// Loopback HTTP proxy for maplibre-native.
//
// maplibre-native's built-in HTTP client (libcurl + OpenSSL) crashes
// the process on every outbound HTTPS request inside this Workers
// Container — `SSL_ERROR_SYSCALL` or `recv failure`, then
// `std::terminate`. Rust `reqwest` (rustls) on the same URLs from the
// same container succeeds, and so does the OS `curl` binary; the
// failure is specific to maplibre's HTTP path.
//
// Workaround: serve a plain-HTTP proxy on `127.0.0.1:PROXY_PORT` and
// rewrite all upstream URLs in the style JSON to go through it. The
// rewritten URLs look like
//
//   http://127.0.0.1:9000/proxy/https/example.com/path/to/thing
//
// — maplibre's libcurl talks HTTP to localhost (no TLS handshake, no
// crash); the proxy uses reqwest to fetch the real `https://...`
// upstream and pipes the bytes back.

use std::net::SocketAddr;

use axum::{
    Router,
    body::Body,
    extract::Path,
    http::{HeaderName, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};

pub const PROXY_PORT: u16 = 9000;

/// Spawn the loopback HTTP proxy on a background tokio task. Errors
/// from binding are surfaced; runtime errors are logged but don't kill
/// the parent process — if the proxy dies, the next render attempt
/// will fail loudly enough to notice.
pub async fn spawn_loopback_proxy() -> anyhow::Result<()> {
    let app = Router::new().route("/proxy/{scheme}/{host}/{*path}", get(handle));
    let addr = SocketAddr::from(([127, 0, 0, 1], PROXY_PORT));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("loopback proxy listening on http://{addr}");
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            tracing::error!("loopback proxy exited: {e:?}");
        }
    });
    Ok(())
}

async fn handle(
    Path((scheme, host, path)): Path<(String, String, String)>,
    uri: Uri,
) -> Response {
    // Preserve the query string if maplibre passed one through.
    let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let url = format!("{scheme}://{host}/{path}{query}");

    let upstream = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("loopback proxy: client build failed: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("client: {e}")).into_response();
        }
    };

    match upstream.get(&url).send().await {
        Ok(res) => {
            let status = res.status();
            // Forward only the headers maplibre/libcurl actually needs;
            // copying everything is risky (e.g. transfer-encoding,
            // connection-specific headers).
            let forward = [header::CONTENT_TYPE, header::CONTENT_ENCODING];
            let mut headers = axum::http::HeaderMap::new();
            for h in &forward {
                if let Some(v) = res.headers().get(h) {
                    headers.insert(HeaderName::from(h.clone()), v.clone());
                }
            }
            match res.bytes().await {
                Ok(body) => {
                    let mut response = Response::new(Body::from(body));
                    *response.status_mut() = status;
                    *response.headers_mut() = headers;
                    response
                }
                Err(e) => {
                    tracing::warn!("loopback proxy {url}: body error: {e}");
                    (StatusCode::BAD_GATEWAY, format!("body: {e}")).into_response()
                }
            }
        }
        Err(e) => {
            tracing::warn!("loopback proxy {url}: upstream error: {e}");
            (StatusCode::BAD_GATEWAY, format!("upstream: {e}")).into_response()
        }
    }
}

/// Rewrite a MapLibre `style.json` so any `http(s)://...` URL it
/// reaches at render time (vector tiles, glyphs, sprites, TileJSON)
/// is redirected through the loopback proxy.
pub fn rewrite_style_urls(body: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut v: serde_json::Value = serde_json::from_slice(body)?;
    rewrite_at_known_keys(&mut v);
    Ok(serde_json::to_vec(&v)?)
}

fn rewrite_at_known_keys(v: &mut serde_json::Value) {
    // top-level: glyphs (string template), sprite (string)
    if let Some(obj) = v.as_object_mut() {
        for k in ["glyphs", "sprite"] {
            if let Some(s) = obj.get(k).and_then(|x| x.as_str()).map(String::from) {
                obj.insert(k.into(), serde_json::Value::String(to_proxy_url(&s)));
            }
        }
        // sources.*: each source may have `url` (TileJSON) and/or
        // `tiles` (array of URL templates).
        if let Some(sources) = obj.get_mut("sources").and_then(|s| s.as_object_mut()) {
            for src in sources.values_mut() {
                let Some(src) = src.as_object_mut() else { continue };
                if let Some(s) = src.get("url").and_then(|x| x.as_str()).map(String::from) {
                    src.insert("url".into(), serde_json::Value::String(to_proxy_url(&s)));
                }
                if let Some(tiles) = src.get_mut("tiles").and_then(|t| t.as_array_mut()) {
                    for t in tiles.iter_mut() {
                        if let Some(s) = t.as_str().map(String::from) {
                            *t = serde_json::Value::String(to_proxy_url(&s));
                        }
                    }
                }
            }
        }
    }
}

fn to_proxy_url(url: &str) -> String {
    // Leave `file://` and any unrecognized scheme alone; only rewrite
    // http(s).
    if let Some(rest) = url.strip_prefix("https://") {
        format!("http://127.0.0.1:{PROXY_PORT}/proxy/https/{rest}")
    } else if let Some(rest) = url.strip_prefix("http://") {
        format!("http://127.0.0.1:{PROXY_PORT}/proxy/http/{rest}")
    } else {
        url.to_string()
    }
}
