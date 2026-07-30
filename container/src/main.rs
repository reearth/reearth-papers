//! papers-tile — minimal MapLibre style → raster tile server.
//!
//! Designed to run inside a Cloudflare Workers Container. Renders a
//! 512×512 PNG for an XYZ tile using `maplibre-native` (software GL via
//! Xvfb + llvmpipe; see `Dockerfile`).
//!
//! Tiles are 512px on purpose: the renderer's camera is fixed at
//! `zoom = z` over a 512-logical-px viewport (MapLibre zoom is
//! 512px-tile based), so the render carries text/line sizes exactly as
//! the vector style specifies. Downscaling to 256 would halve every
//! label — clients must consume these with `tileSize: 512`.

mod proxy;

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

    // maplibre-native's libcurl crashes the process on HTTPS inside
    // this Workers Container; we route all its outbound through a
    // plain-HTTP loopback proxy that reqwest-fetches the real upstream.
    // See src/proxy.rs.
    proxy::spawn_loopback_proxy().await?;

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

    // Prewarm is disabled: maplibre-native's C++ side throws on certain
    // network/source-load failures and `std::terminate` takes down the
    // whole process — including the running axum server. Running it as
    // a `tokio::spawn` doesn't help because that's a process-level
    // abort, not a Rust panic. We pay a cold-start penalty on the first
    // /tile request instead.

    axum::serve(listener, app).await?;
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

    let image = if debug_flags().is_some() {
        // Local-debugging path (never taken in production): a private
        // render thread whose ImageRenderer carries MLN_DEBUG's flags —
        // the crate's global pool doesn't expose set_debug_flags.
        render_debug(style_path, z_u8, x, y)
            .await
            .map_err(AppError::Render)?
    } else {
        let pool = maplibre_native::SingleThreadedRenderPool::global_pool();
        pool.render_tile(style_path, z_u8, x, y)
            .await
            .map_err(|e| AppError::Render(format!("{e:?}")))?
    };

    // Serve the render at its native 512×512 (see module docs). The
    // resize is a defensive no-op unless the renderer's viewport ever
    // drifts from the expected size.
    let mut rgba = image.as_image().clone();
    if rgba.width() != 512 || rgba.height() != 512 {
        rgba = image::imageops::resize(&rgba, 512, 512, image::imageops::FilterType::Lanczos3);
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

/// Debug visualization bits from `MLN_DEBUG` (comma-separated:
/// `collision`, `borders`, `overdraw`). Unset (production) → None.
fn debug_flags() -> Option<u32> {
    let v = std::env::var("MLN_DEBUG").ok()?;
    let mut bits = 0u32;
    for part in v.split(',') {
        bits |= match part.trim() {
            "collision" => 1 << 4,
            "borders" => 1 << 1,
            "overdraw" => 1 << 5,
            _ => 0,
        };
    }
    (bits != 0).then_some(bits)
}

struct DebugRenderRequest {
    style_path: PathBuf,
    z: u8,
    x: u32,
    y: u32,
    response: tokio::sync::oneshot::Sender<Result<maplibre_native::Image, String>>,
}

async fn render_debug(
    style_path: PathBuf,
    z: u8,
    x: u32,
    y: u32,
) -> Result<maplibre_native::Image, String> {
    use std::sync::{OnceLock, mpsc};
    static TX: OnceLock<mpsc::Sender<DebugRenderRequest>> = OnceLock::new();
    let tx = TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<DebugRenderRequest>();
        std::thread::spawn(move || {
            let mut renderer =
                maplibre_native::ImageRendererBuilder::default().build_tile_renderer();
            let flags = debug_flags().unwrap_or(0);
            renderer.set_debug_flags(maplibre_native::MapDebugOptions { repr: flags });
            let mut current: Option<PathBuf> = None;
            while let Ok(req) = rx.recv() {
                if current.as_ref() != Some(&req.style_path) {
                    if let Err(e) = renderer.load_style_from_path(&req.style_path) {
                        let _ = req.response.send(Err(format!("style: {e}")));
                        continue;
                    }
                    current = Some(req.style_path.clone());
                }
                let result = renderer
                    .render_tile(req.z, req.x, req.y)
                    .map_err(|e| format!("{e:?}"));
                let _ = req.response.send(result);
            }
        });
        tx
    });
    let (response_tx, response_rx) = tokio::sync::oneshot::channel();
    tx.send(DebugRenderRequest { style_path, z, x, y, response: response_tx })
        .map_err(|_| "debug render thread gone".to_string())?;
    response_rx.await.map_err(|_| "debug render dropped".to_string())?
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

    // Rewrite the style's outbound URLs (tiles / glyphs / sprite /
    // TileJSON) to point at the loopback proxy. maplibre-native sees
    // plain-HTTP localhost URLs and never goes near TLS itself.
    let body = proxy::rewrite_style_urls(&body)
        .map_err(|e| AppError::Internal(format!("style rewrite: {e}")))?;

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
