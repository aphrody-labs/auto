//! Headless GPUI Kit integration tests verifying real frame rendering, navigation, and actions.

use auto_desktop::{AutoDesktopWorkspace, RuntimeMode, Section, register_keybindings, sync_gpui_theme};
use auto_theme::Appearance;
use gpui_kit::{
    AppContext, Bounds, Point, TestAppContext, WindowBounds, WindowOptions, px, size,
    test::TestWindowExt,
};

#[gpui_kit::test]
fn renders_workspace_and_toggles_modes_and_locales(cx: &mut TestAppContext) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        register_keybindings(cx);
        sync_gpui_theme(Appearance::Light, cx);
    });

    let (handle, workspace) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds {
                    origin: Point::default(),
                    size: size(px(1280.), px(820.)),
                })),
                ..Default::default()
            },
            cx,
            |window, cx| cx.new(|cx| AutoDesktopWorkspace::new(250, window, cx)),
        )
        .expect("open headless GPUI window")
    });

    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.click("lang-btn", cx);
        window.click("mode-btn", cx);
        window.click("new-quote-btn", cx);
        window.click("nav-Workflows", cx);
        window.render_frame(cx);
    })
    .expect("drive workspace UI interactions");

    cx.update(|cx| {
        let ws = workspace.read(cx);
        assert_eq!(ws.store.lang, "fr");
        assert_eq!(ws.store.mode, RuntimeMode::SelfHosted);
        assert_eq!(ws.store.documents.len(), 251);
        assert_eq!(ws.store.section, Section::Workflows);
    });
}
