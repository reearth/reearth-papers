//! papers-tile — minimal MapLibre style → raster tile server.
//!
//! Designed to run inside a Cloudflare Workers Container. Renders a
//! 256×256 PNG for an XYZ tile using `maplibre-native` (software GL via
//! Xvfb + llvmpipe; see `Dockerfile`).

use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    Router,
    extract::{Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use image::ImageEncoder;
use serde::Deserialize;
use tokio::sync::RwLock;

#[derive(Clone)]
struct AppState {
    default_style_url: Option<String>,
    style_cache: Arc<RwLock<std::collections::HashMap<String, PathBuf>>>,
}

#[derive(Deserialize)]
struct TileQuery {
    style: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let state = AppState {
        default_style_url: std::env::var("STYLE_URL").ok(),
        style_cache: Arc::new(RwLock::new(Default::default())),
    };

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/tile/{z}/{x}/{y}", get(render_tile))
        .with_state(state.clone());

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8080);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("listening on {addr}");

    // Prewarm maplibre's GL context in the background so Cloudflare
    // Workers Containers' startup port-readiness check (~8 s default)
    // sees the listener immediately. The first /tile request still
    // serializes on `SingleThreadedRenderPool::global_pool()`, so it
    // effectively waits for prewarm — but the container is alive and
    // responsive to /health from the start.
    if let Some(url) = state.default_style_url.clone() {
        let state = state.clone();
        tokio::spawn(async move {
            let t0 = std::time::Instant::now();
            match prewarm(&state, &url).await {
                Ok(()) => tracing::info!(
                    "prewarm complete in {:.2}s (style={url})",
                    t0.elapsed().as_secs_f32()
                ),
                Err(e) => tracing::warn!("prewarm failed (continuing anyway): {e:?}"),
            }
        });
    } else {
        tracing::info!("STYLE_URL not set, skipping prewarm");
    }

    axum::serve(listener, app).await?;
    Ok(())
}

/// Render z=0 of the given style and discard the pixels. The expensive
/// parts — Xvfb attach, GL context creation, font/sprite resolution,
/// style.json parsing — all happen on this first render and are reused
/// by `SingleThreadedRenderPool::global_pool()` from then on.
async fn prewarm(state: &AppState, style_url: &str) -> anyhow::Result<()> {
    let style_path = ensure_style(state, style_url)
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let pool = maplibre_native::SingleThreadedRenderPool::global_pool();
    let _ = pool
        .render_tile(style_path, 0, 0, 0)
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    Ok(())
}

async fn render_tile(
    State(state): State<AppState>,
    Path((z, x, y)): Path<(u32, u32, u32)>,
    Query(q): Query<TileQuery>,
) -> Result<Response, AppError> {
    let style_url = q
        .style
        .or(state.default_style_url.clone())
        .ok_or_else(|| AppError::BadRequest("missing style URL (set STYLE_URL or ?style=)".into()))?;

    let z_u8: u8 = z.try_into().map_err(|_| AppError::BadRequest("z out of range".into()))?;

    let style_path = ensure_style(&state, &style_url).await?;

    let pool = maplibre_native::SingleThreadedRenderPool::global_pool();
    let image = pool
        .render_tile(style_path, z_u8, x, y)
        .await
        .map_err(|e| AppError::Render(format!("{e:?}")))?;

    let mut rgba = image.as_image().clone();
    if rgba.width() != 256 || rgba.height() != 256 {
        rgba = image::imageops::resize(&rgba, 256, 256, image::imageops::FilterType::Lanczos3);
    }

    let mut buf = Vec::with_capacity(8 * 1024);
    image::codecs::png::PngEncoder::new(&mut buf)
        .write_image(rgba.as_raw(), rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8)
        .map_err(|e| AppError::Render(format!("png encode: {e}")))?;

    Ok((
        [(header::CONTENT_TYPE, "image/png")],
        buf,
    )
        .into_response())
}

async fn ensure_style(state: &AppState, url: &str) -> Result<PathBuf, AppError> {
    if let Some(p) = url.strip_prefix("file://") {
        return Ok(PathBuf::from(p));
    }
    {
        let cache = state.style_cache.read().await;
        if let Some(p) = cache.get(url) {
            return Ok(p.clone());
        }
    }

    let body = reqwest::get(url)
        .await
        .map_err(|e| AppError::Fetch(format!("{e}")))?
        .error_for_status()
        .map_err(|e| AppError::Fetch(format!("{e}")))?
        .bytes()
        .await
        .map_err(|e| AppError::Fetch(format!("{e}")))?;

    let dir = std::env::temp_dir().join("papers-tile-styles");
    tokio::fs::create_dir_all(&dir).await.map_err(io_err)?;
    let hash = simple_hash(url);
    let path = dir.join(format!("{hash:x}.json"));
    tokio::fs::write(&path, &body).await.map_err(io_err)?;

    state.style_cache.write().await.insert(url.to_owned(), path.clone());
    Ok(path)
}

fn simple_hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

fn io_err(e: std::io::Error) -> AppError {
    AppError::Internal(format!("{e}"))
}

#[derive(thiserror::Error, Debug)]
enum AppError {
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("fetch failed: {0}")]
    Fetch(String),
    #[error("render failed: {0}")]
    Render(String),
    #[error("internal: {0}")]
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match &self {
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Fetch(_) => StatusCode::BAD_GATEWAY,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        tracing::warn!(error = %self, "request failed");
        (status, self.to_string()).into_response()
    }
}
