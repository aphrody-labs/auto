#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use auto_desktop::{AutoDesktopWorkspace, register_keybindings, sync_gpui_theme};
use auto_theme::Appearance;
use gpui_kit::{AppContext, WindowOptions, bounds, point, px, size};

fn main() {
    gpui_kit::application().run(|cx| {
        gpui_kit::init(cx);
        register_keybindings(cx);
        sync_gpui_theme(Appearance::Light, cx);

        let opts = WindowOptions {
            window_bounds: Some(gpui_kit::WindowBounds::Windowed(bounds(
                point(px(64.0), px(48.0)),
                size(px(1280.0), px(820.0)),
            ))),
            ..Default::default()
        };

        gpui_kit::open_window(opts, cx, |window, cx| {
            cx.new(|cx| AutoDesktopWorkspace::new(10_000, window, cx))
        })
        .expect("open Auto Desktop GPUI window");
    });
}
