//! `auto-desktop`: embeddable 120 FPS GPUI Desktop workspace & `gpui-fast` runtime.

extern crate gpui_kit as gpui;

pub mod dag_canvas;
pub mod store;
pub mod theme;
pub mod workspace;

pub use store::{AutoDesktopStore, DesktopDocumentRow, RuntimeMode, Section};
pub use theme::{DesktopPalette, sync_gpui_theme};
pub use workspace::{AutoDesktopWorkspace, register_keybindings};

#[cfg(test)]
mod tests {
    use super::*;
    use auto_theme::Appearance;

    #[test]
    fn desktop_store_filters_10k_rows_and_generates_facturx() {
        let mut store = AutoDesktopStore::with_document_count(10_000);
        assert_eq!(store.documents.len(), 10_000);
        assert!(store.facturx_preview.contains("CrossIndustryInvoice"));

        store.set_filter("FA-2026-00001");
        assert_eq!(store.filtered_indices.len(), 1);
        assert_eq!(store.selected_document().map(|d| d.document.number.as_str()), Some("FA-2026-00001"));

        store.toggle_language();
        assert_eq!(store.lang, "fr");
        store.create_quick_quote("Bordeaux Client");
        assert_eq!(store.documents.len(), 10_001);

        let dark = DesktopPalette::from_appearance(Appearance::Dark, true);
        assert_eq!(dark.appearance, Appearance::Dark);
    }
}
