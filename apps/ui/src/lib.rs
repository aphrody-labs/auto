//! Cross-platform NSH Rust UI library for Auto.

pub mod nav;
pub mod pages;
pub mod shell;
pub mod store;
pub mod theme_bridge;
pub mod ui;

use nsh_base::theme;
use nsh_core::prelude::*;

/// Native module exported to NSH hosts (`nsh.json` `"rust"`).
#[native_module("auto-ui/native")]
fn native(registry: &mut Registry) {
    registry.register::<App>();
}

/// Root NSH component binding `auto_theme` semantic tokens onto the primary surface.
#[component]
pub fn App() -> impl IntoElement {
    theme_bridge::apply_auto_tokens();
    view()
        .flex_1()
        .bg(move || theme().background)
        .child(shell::shell())
}
