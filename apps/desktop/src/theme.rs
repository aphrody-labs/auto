//! Semantic GPUI theme bridge backed exclusively by `crates/auto-theme`.

use auto_theme::{Appearance, ColorPalette, RgbColor, ThemeTokens, resolve};
use gpui_kit::{
    App, Hsla, Pixels,
    component::theme::{Theme, ThemeMode},
    px, rgb,
};

/// Convert an `auto_theme::RgbColor` to GPUI `Hsla` without losing accuracy.
#[inline]
pub fn rgb_to_hsla(c: RgbColor) -> Hsla {
    let packed = ((c.r as u32) << 16) | ((c.g as u32) << 8) | (c.b as u32);
    rgb(packed).into()
}

/// Complete resolved semantic GPUI palette aligned with `DESIGN.md` & `auto_theme`.
#[derive(Clone, Copy, Debug)]
pub struct DesktopPalette {
    pub appearance: Appearance,
    pub background: Hsla,
    pub foreground: Hsla,
    pub card: Hsla,
    pub popover: Hsla,
    pub primary: Hsla,
    pub primary_foreground: Hsla,
    pub secondary: Hsla,
    pub secondary_foreground: Hsla,
    pub muted: Hsla,
    pub muted_foreground: Hsla,
    pub accent: Hsla,
    pub accent_foreground: Hsla,
    pub destructive: Hsla,
    pub border: Hsla,
    pub input: Hsla,
    pub ring: Hsla,
    pub sidebar: Hsla,
    pub up: Hsla,
    pub warn: Hsla,
    pub info: Hsla,
    pub radius_md: Pixels,
    pub radius_lg: Pixels,
}

impl DesktopPalette {
    pub fn from_appearance(appearance: Appearance, reduced_motion: bool) -> Self {
        let tokens: ThemeTokens = resolve(appearance, reduced_motion);
        let p: ColorPalette = tokens.colors;
        Self {
            appearance,
            background: rgb_to_hsla(p.background),
            foreground: rgb_to_hsla(p.foreground),
            card: rgb_to_hsla(p.card),
            popover: rgb_to_hsla(p.popover),
            primary: rgb_to_hsla(p.primary),
            primary_foreground: rgb_to_hsla(p.primary_foreground),
            secondary: rgb_to_hsla(p.secondary),
            secondary_foreground: rgb_to_hsla(p.secondary_foreground),
            muted: rgb_to_hsla(p.muted),
            muted_foreground: rgb_to_hsla(p.muted_foreground),
            accent: rgb_to_hsla(p.accent),
            accent_foreground: rgb_to_hsla(p.accent_foreground),
            destructive: rgb_to_hsla(p.destructive),
            border: rgb_to_hsla(p.border),
            input: rgb_to_hsla(p.input),
            ring: rgb_to_hsla(p.ring),
            sidebar: rgb_to_hsla(p.sidebar),
            up: rgb_to_hsla(p.up),
            warn: rgb_to_hsla(p.warn),
            info: rgb_to_hsla(p.info),
            radius_md: px(f32::from(tokens.radii.md)),
            radius_lg: px(f32::from(tokens.radii.lg)),
        }
    }
}

/// Synchronize `gpui_component::Theme` with `auto_theme` semantic tokens.
pub fn sync_gpui_theme(appearance: Appearance, cx: &mut App) {
    let mode = match appearance {
        Appearance::Light => ThemeMode::Light,
        Appearance::Dark => ThemeMode::Dark,
    };
    Theme::change(mode, None, cx);
    let pal = DesktopPalette::from_appearance(appearance, false);
    Theme::update(cx, |theme| {
        theme.colors.background = pal.background;
        theme.colors.foreground = pal.foreground;
        theme.colors.border = pal.border;
        theme.colors.input = pal.input;
        theme.colors.ring = pal.ring;
        theme.colors.primary = pal.primary;
        theme.colors.primary_foreground = pal.primary_foreground;
        theme.colors.secondary = pal.secondary;
        theme.colors.secondary_foreground = pal.secondary_foreground;
        theme.colors.accent = pal.accent;
        theme.colors.accent_foreground = pal.accent_foreground;
        theme.colors.muted = pal.muted;
        theme.colors.muted_foreground = pal.muted_foreground;
        theme.colors.popover = pal.popover;
        theme.colors.popover_foreground = pal.foreground;
        theme.colors.sidebar = pal.sidebar;
        theme.colors.sidebar_foreground = pal.foreground;
        theme.colors.sidebar_accent = pal.accent;
        theme.colors.sidebar_accent_foreground = pal.accent_foreground;
        theme.colors.sidebar_border = pal.border;
        theme.colors.danger = pal.destructive;
        theme.colors.success = pal.up;
        theme.colors.warning = pal.warn;
        theme.colors.info = pal.info;
        theme.radius = pal.radius_md;
        theme.radius_lg = pal.radius_lg;
    });
}
