//! Headless NSH flow tests exercising bilingual switching, quote creation, and navigation stack push/pop.

use nsh_engine::{EngineConfig, Root};
use nsh_testing::Headless;

fn start() -> Headless {
    let mut app = Headless::start(EngineConfig::new(Root::of::<auto_ui::App>())).expect("start headless NSH engine");
    app.wait_for("FA-2026-0001 — Acme Europe SAS").expect("initial invoice renders");
    app
}

#[test]
fn bilingual_switch_quote_creation_and_navigation_work() {
    let mut app = start();

    // Create a new quote via the controlled field
    app.type_text("text:New quote customer", "Helios Tech").expect("type customer name");
    app.press("role:button[New Quote]").expect("submit quick quote");
    app.wait_for("DV-2026-0003 — Helios Tech").expect("new quote appears in virtual_list");

    // Push document detail screen and toggle Paid switch
    app.press("FA-2026-0001 — Acme Europe SAS").expect("open invoice detail");
    app.wait_for("role:switch").expect("detail screen renders switch");
    app.press("role:button[Back]").expect("pop back to workspace");
    app.wait_for("DV-2026-0003 — Helios Tech").expect("workspace list remains visible");

    // Toggle EN -> FR locale dynamically
    app.press("role:button[EN]").expect("switch language to French");
    app.wait_for("role:button[FR]").expect("language button switches to FR");
}
