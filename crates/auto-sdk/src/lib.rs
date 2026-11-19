#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub use auto_auth as auth;
pub use auto_client as client;
pub use auto_docs as docs;
pub use auto_facturx as facturx;
pub use auto_files as files;
pub use auto_i18n as i18n;
pub use auto_knowledge as knowledge;
pub use auto_model as model;
pub use auto_sheets as sheets;
pub use auto_theme as theme;

pub mod balancer;
pub mod config;
pub mod mcp;
pub mod server_rt;
pub mod updater;

use thiserror::Error;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Error)]
pub enum SdkError {
    #[error("configuration error: {0}")]
    Config(String),
    #[error("network/proxy error: {0}")]
    Network(String),
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("auth error: {0}")]
    Auth(#[from] auto_auth::AuthError),
    #[error("client error: {0}")]
    Client(#[from] auto_client::ClientError),
}

pub type SdkResult<T> = Result<T, SdkError>;
