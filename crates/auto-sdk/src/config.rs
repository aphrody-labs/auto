// Declarative configuration parsed from `auto.toml` + environment overrides (zero hardcoded endpoints or secrets).
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{SdkError, SdkResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoToml {
    #[serde(default)]
    pub app: AppSection,
    #[serde(default)]
    pub locales: LocalesSection,
    #[serde(default)]
    pub modes: ModesSection,
    #[serde(default)]
    pub cluster: ClusterSection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSection {
    pub name: String,
    pub slug: String,
    pub default_locale: String,
    pub supported_locales: Vec<String>,
    pub default_currency: String,
    pub default_timezone: String,
}

impl Default for AppSection {
    fn default() -> Self {
        Self {
            name: "Auto".into(),
            slug: "auto".into(),
            default_locale: "en".into(),
            supported_locales: vec!["en".into(), "fr".into()],
            default_currency: "EUR".into(),
            default_timezone: "UTC".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalesSection {
    pub directory: String,
    pub format: String,
    pub bundles: Vec<String>,
}

impl Default for LocalesSection {
    fn default() -> Self {
        Self { directory: "locales".into(), format: "tsv".into(), bundles: vec!["common".into(), "auto".into()] }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModesSection {
    pub default: String,
    #[serde(default)]
    pub self_hosted: SelfHostedSection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelfHostedSection {
    pub default_host: String,
    pub default_port: u16,
    pub default_data_dir: String,
    pub sync_interval_ms: u64,
    pub realtime_ws: bool,
}

impl Default for SelfHostedSection {
    fn default() -> Self {
        Self {
            default_host: "0.0.0.0".into(),
            default_port: 3000,
            default_data_dir: "data".into(),
            sync_interval_ms: 5000,
            realtime_ws: true,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ClusterSection {
    #[serde(default)]
    pub load_balancer: LoadBalancerConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadBalancerConfig {
    pub strategy: String,
    pub health_path: String,
    pub health_interval_ms: u64,
    pub health_timeout_ms: u64,
    pub unhealthy_threshold: u32,
    pub healthy_threshold: u32,
    pub sticky_header: String,
}

impl Default for LoadBalancerConfig {
    fn default() -> Self {
        Self {
            strategy: "consistent_hash".into(),
            health_path: "/health".into(),
            health_interval_ms: 5000,
            health_timeout_ms: 2000,
            unhealthy_threshold: 2,
            healthy_threshold: 1,
            sticky_header: "x-company-id".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedRuntimeConfig {
    pub mode: String,
    pub host: String,
    pub port: u16,
    pub db_path: String,
    pub public_base_url: String,
    pub locale: String,
    pub upstreams: Vec<String>,
    pub load_balancer: LoadBalancerConfig,
}

pub fn load_toml(path: &Path) -> SdkResult<AutoToml> {
    if !path.exists() {
        return Ok(AutoToml {
            app: AppSection::default(),
            locales: LocalesSection::default(),
            modes: ModesSection { default: "auto".into(), self_hosted: SelfHostedSection::default() },
            cluster: ClusterSection::default(),
        });
    }
    let raw = std::fs::read_to_string(path)?;
    toml::from_str(&raw).map_err(|e| SdkError::Config(format!("invalid {}: {e}", path.display())))
}

pub fn resolve_runtime(toml_path: Option<&Path>) -> SdkResult<ResolvedRuntimeConfig> {
    let parsed = load_toml(toml_path.unwrap_or_else(|| Path::new("auto.toml")))?;
    let mode = std::env::var("AUTO_MODE").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| {
        if parsed.modes.default.is_empty() { "self-hosted".into() } else { parsed.modes.default.clone() }
    });
    let host =
        std::env::var("AUTO_HOST").ok().filter(|s| !s.is_empty()).unwrap_or(parsed.modes.self_hosted.default_host);
    let port = std::env::var("AUTO_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(parsed.modes.self_hosted.default_port);
    let db_path = std::env::var("AUTO_DB_PATH")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("{}/auto.sqlite", parsed.modes.self_hosted.default_data_dir.trim_end_matches('/')));
    let public_base_url = std::env::var("AUTO_URL_APP")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("http://{}:{port}", if host == "0.0.0.0" { "127.0.0.1" } else { &host }));
    let locale = std::env::var("AUTO_LOCALE").ok().filter(|s| !s.is_empty()).unwrap_or(parsed.app.default_locale);
    let upstreams = std::env::var("AUTO_UPSTREAMS")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let mut lb = parsed.cluster.load_balancer;
    if let Ok(strat) = std::env::var("AUTO_LB_STRATEGY")
        && !strat.is_empty()
    {
        lb.strategy = strat;
    }
    Ok(ResolvedRuntimeConfig { mode, host, port, db_path, public_base_url, locale, upstreams, load_balancer: lb })
}
