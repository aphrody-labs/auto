// Real-time async L7 HTTP reverse proxy & health-probed load balancer across fleet upstreams.
// Supports consistent FNV-1a company sticky routing, least-connections, round-robin, and automatic failover.
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
};
use std::time::Duration;

use axum::{
    Json, Router,
    body::Body,
    extract::{Request, State},
    http::{HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
};
use serde::Serialize;

use crate::{SdkError, SdkResult, config::LoadBalancerConfig};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LbStrategy {
    RoundRobin,
    LeastConnections,
    ConsistentHash,
}

impl LbStrategy {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "round_robin" | "rr" => Self::RoundRobin,
            "least_connections" | "least_conn" => Self::LeastConnections,
            _ => Self::ConsistentHash,
        }
    }
}

#[derive(Debug)]
pub struct UpstreamNode {
    pub url: String,
    pub healthy: AtomicBool,
    pub active_conns: AtomicUsize,
    pub consecutive_failures: AtomicUsize,
    pub consecutive_successes: AtomicUsize,
    pub total_requests: AtomicU64,
    pub failed_requests: AtomicU64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamMetrics {
    pub url: String,
    pub healthy: bool,
    pub active_conns: usize,
    pub total_requests: u64,
    pub failed_requests: u64,
}

#[derive(Debug)]
pub struct LoadBalancer {
    pub strategy: LbStrategy,
    pub cfg: LoadBalancerConfig,
    pub upstreams: Vec<Arc<UpstreamNode>>,
    rr_cursor: AtomicUsize,
    client: reqwest::Client,
}

impl LoadBalancer {
    pub fn new(urls: &[String], cfg: LoadBalancerConfig) -> SdkResult<Arc<Self>> {
        if urls.is_empty() {
            return Err(SdkError::Config("load balancer requires at least one upstream URL".into()));
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(32)
            .build()
            .map_err(|e| SdkError::Network(e.to_string()))?;
        let upstreams = urls
            .iter()
            .map(|u| {
                Arc::new(UpstreamNode {
                    url: u.trim_end_matches('/').to_string(),
                    healthy: AtomicBool::new(true),
                    active_conns: AtomicUsize::new(0),
                    consecutive_failures: AtomicUsize::new(0),
                    consecutive_successes: AtomicUsize::new(0),
                    total_requests: AtomicU64::new(0),
                    failed_requests: AtomicU64::new(0),
                })
            })
            .collect();
        Ok(Arc::new(Self {
            strategy: LbStrategy::parse(&cfg.strategy),
            cfg,
            upstreams,
            rr_cursor: AtomicUsize::new(0),
            client,
        }))
    }

    pub fn select_candidates(&self, affinity_key: Option<&str>) -> Vec<Arc<UpstreamNode>> {
        let mut pool: Vec<Arc<UpstreamNode>> =
            self.upstreams.iter().filter(|u| u.healthy.load(Ordering::Relaxed)).cloned().collect();
        if pool.is_empty() {
            pool = self.upstreams.clone();
        }
        let len = pool.len();
        if len <= 1 {
            return pool;
        }
        let start = match self.strategy {
            LbStrategy::ConsistentHash if affinity_key.is_some_and(|k| !k.is_empty()) => {
                (fnv1a_32(affinity_key.unwrap_or_default().as_bytes()) as usize) % len
            }
            LbStrategy::LeastConnections => pool
                .iter()
                .enumerate()
                .min_by_key(|(_, n)| n.active_conns.load(Ordering::Relaxed))
                .map(|(i, _)| i)
                .unwrap_or(0),
            _ => self.rr_cursor.fetch_add(1, Ordering::Relaxed) % len,
        };
        let mut ordered = Vec::with_capacity(len);
        ordered.extend(pool.iter().skip(start).cloned());
        ordered.extend(pool.into_iter().take(start));
        ordered
    }

    pub async fn probe_once(&self) {
        let probe_timeout = Duration::from_millis(self.cfg.health_timeout_ms.max(250));
        for node in &self.upstreams {
            let url = format!("{}{}", node.url, self.cfg.health_path);
            let ok = matches!(
                self.client.get(&url).timeout(probe_timeout).send().await,
                Ok(resp) if resp.status().is_success()
            );
            if ok {
                node.consecutive_failures.store(0, Ordering::Relaxed);
                let succ = node.consecutive_successes.fetch_add(1, Ordering::Relaxed) + 1;
                if succ >= self.cfg.healthy_threshold.max(1) as usize {
                    node.healthy.store(true, Ordering::Relaxed);
                }
            } else {
                node.consecutive_successes.store(0, Ordering::Relaxed);
                let fail = node.consecutive_failures.fetch_add(1, Ordering::Relaxed) + 1;
                if fail >= self.cfg.unhealthy_threshold.max(1) as usize {
                    node.healthy.store(false, Ordering::Relaxed);
                }
            }
        }
    }

    pub fn spawn_health_loop(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let lb = Arc::clone(self);
        let interval = Duration::from_millis(lb.cfg.health_interval_ms.max(500));
        tokio::spawn(async move {
            loop {
                lb.probe_once().await;
                tokio::time::sleep(interval).await;
            }
        })
    }

    pub fn metrics(&self) -> Vec<UpstreamMetrics> {
        self.upstreams
            .iter()
            .map(|u| UpstreamMetrics {
                url: u.url.clone(),
                healthy: u.healthy.load(Ordering::Relaxed),
                active_conns: u.active_conns.load(Ordering::Relaxed),
                total_requests: u.total_requests.load(Ordering::Relaxed),
                failed_requests: u.failed_requests.load(Ordering::Relaxed),
            })
            .collect()
    }
}

pub fn lb_router(lb: Arc<LoadBalancer>) -> Router {
    Router::new()
        .route("/_lb/metrics", axum::routing::get(h_metrics))
        .route("/{*path}", any(h_proxy))
        .route("/", any(h_proxy))
        .with_state(lb)
}

async fn h_metrics(State(lb): State<Arc<LoadBalancer>>) -> Response {
    let healthy_count = lb.upstreams.iter().filter(|u| u.healthy.load(Ordering::Relaxed)).count();
    Json(serde_json::json!({
        "ok": healthy_count > 0,
        "healthyCount": healthy_count,
        "totalUpstreams": lb.upstreams.len(),
        "upstreams": lb.metrics(),
    }))
    .into_response()
}

async fn h_proxy(State(lb): State<Arc<LoadBalancer>>, req: Request) -> Response {
    let sticky = req.headers().get(lb.cfg.sticky_header.as_str()).and_then(|v| v.to_str().ok()).map(str::to_string);
    let path_and_query = req.uri().path_and_query().map(|pq| pq.as_str().to_string()).unwrap_or_else(|| "/".into());
    let method = req.method().clone();
    let req_headers = req.headers().clone();

    let body_bytes = match axum::body::to_bytes(req.into_body(), 25 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            return (StatusCode::PAYLOAD_TOO_LARGE, Json(serde_json::json!({ "error": e.to_string() })))
                .into_response();
        }
    };

    let candidates = lb.select_candidates(sticky.as_deref());
    for (idx, node) in candidates.iter().enumerate() {
        node.active_conns.fetch_add(1, Ordering::Relaxed);
        node.total_requests.fetch_add(1, Ordering::Relaxed);
        let target_url = format!("{}{}", node.url, path_and_query);
        let mut builder = lb.client.request(
            reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET),
            &target_url,
        );
        for (name, val) in &req_headers {
            let n = name.as_str();
            if n.eq_ignore_ascii_case("host") || n.eq_ignore_ascii_case("content-length") {
                continue;
            }
            if let Ok(rn) = reqwest::header::HeaderName::from_bytes(n.as_bytes())
                && let Ok(rv) = reqwest::header::HeaderValue::from_bytes(val.as_bytes())
            {
                builder = builder.header(rn, rv);
            }
        }
        if !body_bytes.is_empty() {
            builder = builder.body(body_bytes.clone());
        }

        let res = builder.send().await;
        node.active_conns.fetch_sub(1, Ordering::Relaxed);

        match res {
            Ok(up_resp) => {
                let status = StatusCode::from_u16(up_resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                if status.is_server_error() && status.as_u16() >= 502 && idx + 1 < candidates.len() {
                    node.failed_requests.fetch_add(1, Ordering::Relaxed);
                    node.healthy.store(false, Ordering::Relaxed);
                    continue;
                }
                let up_headers = up_resp.headers().clone();
                let payload = up_resp.bytes().await.unwrap_or_default();
                let mut builder = Response::builder().status(status);
                for (name, val) in &up_headers {
                    if name.as_str().eq_ignore_ascii_case("transfer-encoding") {
                        continue;
                    }
                    if let Ok(hn) = HeaderName::from_bytes(name.as_str().as_bytes())
                        && let Ok(hv) = HeaderValue::from_bytes(val.as_bytes())
                    {
                        builder = builder.header(hn, hv);
                    }
                }
                if let Ok(hv) = HeaderValue::from_str(&node.url) {
                    builder = builder.header("x-auto-upstream", hv);
                }
                return builder.body(Body::from(payload)).unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());
            }
            Err(_) => {
                node.failed_requests.fetch_add(1, Ordering::Relaxed);
                node.healthy.store(false, Ordering::Relaxed);
            }
        }
    }

    (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": "all fleet upstreams unavailable" }))).into_response()
}

pub fn fnv1a_32(data: &[u8]) -> u32 {
    let mut hash: u32 = 2166136261;
    for &b in data {
        hash ^= u32::from(b);
        hash = hash.wrapping_mul(16777619);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;

    #[tokio::test]
    async fn real_l7_balancer_failover_and_consistent_routing() {
        let app1 =
            Router::new().route("/health", get(|| async { "ok1" })).route("/v1/ping", get(|| async { "node-1" }));
        let app2 =
            Router::new().route("/health", get(|| async { "ok2" })).route("/v1/ping", get(|| async { "node-2" }));

        let l1 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let a1 = l1.local_addr().unwrap();
        let l2 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let a2 = l2.local_addr().unwrap();
        let h1 = tokio::spawn(async move {
            let _ = axum::serve(l1, app1).await;
        });
        let h2 = tokio::spawn(async move {
            let _ = axum::serve(l2, app2).await;
        });

        let lb = LoadBalancer::new(&[format!("http://{a1}"), format!("http://{a2}")], LoadBalancerConfig::default())
            .unwrap();
        lb.probe_once().await;

        let lb_l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let lb_addr = lb_l.local_addr().unwrap();
        let _hlb = tokio::spawn(async move {
            let _ = axum::serve(lb_l, lb_router(lb)).await;
        });

        let client = reqwest::Client::new();
        let r1 =
            client.get(format!("http://{lb_addr}/v1/ping")).header("x-company-id", "comp_alpha").send().await.unwrap();
        assert!(r1.status().is_success());
        let first_node = r1.text().await.unwrap();

        let r2 =
            client.get(format!("http://{lb_addr}/v1/ping")).header("x-company-id", "comp_alpha").send().await.unwrap();
        assert_eq!(r2.text().await.unwrap(), first_node);

        // Shut down node 1 -> traffic fails over cleanly to node 2
        h1.abort();
        let _ = h1.await;
        let r_failover =
            client.get(format!("http://{lb_addr}/v1/ping")).header("x-company-id", "comp_alpha").send().await.unwrap();
        assert!(r_failover.status().is_success());
        h2.abort();
    }
}
