//! Bridge from canonical `auto_theme` semantic tokens into `nsh_core::prelude::Tokens`.

use auto_theme::{DARK_PALETTE, LIGHT_PALETTE, RADII, RgbColor, SPACING, TYPOGRAPHY};
use nsh_core::prelude::*;

#[inline]
const fn pack24(c: RgbColor) -> u32 {
    ((c.r as u32) << 16) | ((c.g as u32) << 8) | (c.b as u32)
}

#[inline]
pub fn adaptive(light: RgbColor, dark: RgbColor) -> AdaptiveColor {
    AdaptiveColor::rgb(pack24(light), pack24(dark))
}

/// Applies Auto's canonical light & dark palettes (`crates/auto-theme`) into NSH `Tokens`.
pub fn apply_auto_tokens() {
    let mut tokens = Tokens::default();
    let pairs = [
        ("background", LIGHT_PALETTE.background, DARK_PALETTE.background),
        ("foreground", LIGHT_PALETTE.foreground, DARK_PALETTE.foreground),
        ("card", LIGHT_PALETTE.card, DARK_PALETTE.card),
        ("card-foreground", LIGHT_PALETTE.foreground, DARK_PALETTE.foreground),
        ("popover", LIGHT_PALETTE.popover, DARK_PALETTE.popover),
        ("popover-foreground", LIGHT_PALETTE.foreground, DARK_PALETTE.foreground),
        ("primary", LIGHT_PALETTE.primary, DARK_PALETTE.primary),
        ("primary-foreground", LIGHT_PALETTE.primary_foreground, DARK_PALETTE.primary_foreground),
        ("secondary", LIGHT_PALETTE.secondary, DARK_PALETTE.secondary),
        ("secondary-foreground", LIGHT_PALETTE.secondary_foreground, DARK_PALETTE.secondary_foreground),
        ("muted", LIGHT_PALETTE.muted, DARK_PALETTE.muted),
        ("muted-foreground", LIGHT_PALETTE.muted_foreground, DARK_PALETTE.muted_foreground),
        ("accent", LIGHT_PALETTE.accent, DARK_PALETTE.accent),
        ("accent-foreground", LIGHT_PALETTE.accent_foreground, DARK_PALETTE.accent_foreground),
        ("destructive", LIGHT_PALETTE.destructive, DARK_PALETTE.destructive),
        ("border", LIGHT_PALETTE.border, DARK_PALETTE.border),
        ("input", LIGHT_PALETTE.input, DARK_PALETTE.input),
        ("ring", LIGHT_PALETTE.ring, DARK_PALETTE.ring),
        ("sidebar", LIGHT_PALETTE.sidebar, DARK_PALETTE.sidebar),
        ("up", LIGHT_PALETTE.up, DARK_PALETTE.up),
        ("warn", LIGHT_PALETTE.warn, DARK_PALETTE.warn),
        ("info", LIGHT_PALETTE.info, DARK_PALETTE.info),
    ];
    for (name, light, dark) in pairs {
        tokens.set_color(name, adaptive(light, dark));
    }
    tokens.set_number("radius", f32::from(RADII.md));
    tokens.set_number("radius-lg", f32::from(RADII.lg));
    tokens.set_number("font-size", f32::from(TYPOGRAPHY.body_desktop_px));
    tokens.set_number("spacing", f32::from(SPACING.xs));
    set_tokens(tokens);
}

pub fn up_color() -> AdaptiveColor {
    adaptive(LIGHT_PALETTE.up, DARK_PALETTE.up)
}

pub fn warn_color() -> AdaptiveColor {
    adaptive(LIGHT_PALETTE.warn, DARK_PALETTE.warn)
}

pub fn info_color() -> AdaptiveColor {
    adaptive(LIGHT_PALETTE.info, DARK_PALETTE.info)
}
