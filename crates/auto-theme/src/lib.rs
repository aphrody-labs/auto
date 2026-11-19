//! Material 3 design tokens (seed `#0F6B5C`) aligned with `docs/design/DESIGN.md` for `nsh` and `gpui-kit`.

use serde::{Deserialize, Serialize};
use std::borrow::Cow;

/// Canonical Material 3 brand seed color (`#0F6B5C`).
pub const BRAND_SEED_HEX: &str = "#0F6B5C";

/// sRGB color stored as normalized 8-bit channels with CSS `#rrggbb` helper.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RgbColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl RgbColor {
    pub const fn new(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b }
    }

    /// Formats the color as lowercase `#rrggbb`.
    pub fn to_hex(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
    }

    /// Packs RGB with full opacity (`0xRRGGBBFF`).
    pub const fn to_rgba_u32(self, alpha: u8) -> u32 {
        ((self.r as u32) << 24) | ((self.g as u32) << 16) | ((self.b as u32) << 8) | (alpha as u32)
    }

    /// Normalizes channels to `0.0..=1.0`.
    pub fn to_f32(self) -> [f32; 3] {
        [f32::from(self.r) / 255.0, f32::from(self.g) / 255.0, f32::from(self.b) / 255.0]
    }

    /// WCAG 2.1 relative luminance (`0.0..=1.0`).
    pub fn relative_luminance(self) -> f64 {
        fn channel(v: u8) -> f64 {
            let s = f64::from(v) / 255.0;
            if s <= 0.03928 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
        }
        0.2126 * channel(self.r) + 0.7152 * channel(self.g) + 0.0722 * channel(self.b)
    }

    /// WCAG 2.1 contrast ratio against `other` (`1.0..=21.0`).
    pub fn contrast_ratio(self, other: Self) -> f64 {
        let (a, b) = (self.relative_luminance(), other.relative_luminance());
        let (hi, lo) = if a >= b { (a, b) } else { (b, a) };
        (hi + 0.05) / (lo + 0.05)
    }
}

/// Semantic color tokens shared between Web/mobile (`nsh`) and desktop (`gpui-kit`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorPalette {
    pub background: RgbColor,
    pub foreground: RgbColor,
    pub card: RgbColor,
    pub popover: RgbColor,
    pub primary: RgbColor,
    pub primary_foreground: RgbColor,
    pub secondary: RgbColor,
    pub secondary_foreground: RgbColor,
    pub muted: RgbColor,
    pub muted_foreground: RgbColor,
    pub accent: RgbColor,
    pub accent_foreground: RgbColor,
    pub destructive: RgbColor,
    pub border: RgbColor,
    pub input: RgbColor,
    pub ring: RgbColor,
    pub sidebar: RgbColor,
    pub up: RgbColor,
    pub warn: RgbColor,
    pub info: RgbColor,
}

/// Light mode semantic color palette from `docs/design/DESIGN.md`.
pub const LIGHT_PALETTE: ColorPalette = ColorPalette {
    background: RgbColor::new(0xf5, 0xfb, 0xf7),
    foreground: RgbColor::new(0x17, 0x1d, 0x1b),
    card: RgbColor::new(0xff, 0xff, 0xff),
    popover: RgbColor::new(0xe9, 0xef, 0xec),
    primary: RgbColor::new(0x05, 0x6b, 0x5b),
    primary_foreground: RgbColor::new(0xff, 0xff, 0xff),
    secondary: RgbColor::new(0xcd, 0xe8, 0xe0),
    secondary_foreground: RgbColor::new(0x33, 0x4b, 0x45),
    muted: RgbColor::new(0xef, 0xf5, 0xf1),
    muted_foreground: RgbColor::new(0x3f, 0x49, 0x46),
    accent: RgbColor::new(0xa0, 0xf2, 0xde),
    accent_foreground: RgbColor::new(0x00, 0x51, 0x44),
    destructive: RgbColor::new(0xba, 0x1a, 0x1a),
    border: RgbColor::new(0xbe, 0xc9, 0xc5),
    input: RgbColor::new(0x6f, 0x79, 0x76),
    ring: RgbColor::new(0x05, 0x6b, 0x5b),
    sidebar: RgbColor::new(0xe9, 0xef, 0xec),
    up: RgbColor::new(0x37, 0x69, 0x3d),
    warn: RgbColor::new(0x85, 0x53, 0x17),
    info: RgbColor::new(0x43, 0x62, 0x78),
};

/// Dark mode semantic color palette from `docs/design/DESIGN.md`.
pub const DARK_PALETTE: ColorPalette = ColorPalette {
    background: RgbColor::new(0x0e, 0x15, 0x13),
    foreground: RgbColor::new(0xde, 0xe4, 0xe0),
    card: RgbColor::new(0x1b, 0x21, 0x1f),
    popover: RgbColor::new(0x25, 0x2b, 0x29),
    primary: RgbColor::new(0x84, 0xd6, 0xc2),
    primary_foreground: RgbColor::new(0x00, 0x38, 0x2f),
    secondary: RgbColor::new(0x33, 0x4b, 0x45),
    secondary_foreground: RgbColor::new(0xcd, 0xe8, 0xe0),
    muted: RgbColor::new(0x17, 0x1d, 0x1b),
    muted_foreground: RgbColor::new(0xbe, 0xc9, 0xc5),
    accent: RgbColor::new(0x00, 0x51, 0x44),
    accent_foreground: RgbColor::new(0xa0, 0xf2, 0xde),
    destructive: RgbColor::new(0xff, 0xb4, 0xab),
    border: RgbColor::new(0x3f, 0x49, 0x46),
    input: RgbColor::new(0x89, 0x93, 0x8f),
    ring: RgbColor::new(0x84, 0xd6, 0xc2),
    sidebar: RgbColor::new(0x09, 0x0f, 0x0e),
    up: RgbColor::new(0x9d, 0xd4, 0x9e),
    warn: RgbColor::new(0xfc, 0xb9, 0x74),
    info: RgbColor::new(0xab, 0xca, 0xe4),
};

/// Active appearance mode.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Appearance {
    #[default]
    Light,
    Dark,
}

/// Font family and size tokens (px).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypographyTokens {
    pub display_family: Cow<'static, str>,
    pub body_family: Cow<'static, str>,
    pub min_size_px: u16,
    pub body_desktop_px: u16,
    pub body_touch_px: u16,
    pub title_md_px: u16,
    pub title_lg_px: u16,
    pub display_sm_px: u16,
    pub display_lg_px: u16,
}

pub const TYPOGRAPHY: TypographyTokens = TypographyTokens {
    display_family: Cow::Borrowed("Plus Jakarta Sans"),
    body_family: Cow::Borrowed("Inter"),
    min_size_px: 12,
    body_desktop_px: 14,
    body_touch_px: 15,
    title_md_px: 16,
    title_lg_px: 18,
    display_sm_px: 24,
    display_lg_px: 32,
};

/// Corner radius scale (px).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RadiiTokens {
    pub sm: u16,
    pub md: u16,
    pub lg: u16,
    pub xl: u16,
    pub full: u16,
}

pub const RADII: RadiiTokens = RadiiTokens { sm: 4, md: 8, lg: 12, xl: 16, full: 9999 };

/// 4px spacing scale (px).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpacingTokens {
    pub xs: u16,
    pub sm: u16,
    pub md: u16,
    pub lg: u16,
    pub xl: u16,
    pub x2: u16,
    pub x3: u16,
    pub x4: u16,
}

pub const SPACING: SpacingTokens = SpacingTokens { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, x2: 24, x3: 32, x4: 48 };

/// Motion durations in milliseconds (0 when reduced motion is enabled).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionTokens {
    pub theme_switch_ms: u16,
    pub toggle_ms: u16,
    pub sheet_ms: u16,
    pub nav_stack_ms: u16,
    pub toast_ms: u16,
}

pub const MOTION_STANDARD: MotionTokens =
    MotionTokens { theme_switch_ms: 120, toggle_ms: 180, sheet_ms: 220, nav_stack_ms: 240, toast_ms: 180 };

pub const MOTION_REDUCED: MotionTokens =
    MotionTokens { theme_switch_ms: 0, toggle_ms: 0, sheet_ms: 0, nav_stack_ms: 0, toast_ms: 0 };

/// Complete resolved theme bundle consumable by both `nsh` and `gpui-kit`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeTokens {
    pub appearance: Appearance,
    pub colors: ColorPalette,
    pub typography: TypographyTokens,
    pub radii: RadiiTokens,
    pub spacing: SpacingTokens,
    pub motion: MotionTokens,
    pub desktop_control_height_px: u16,
    pub touch_target_min_px: u16,
}

/// Resolves theme tokens for the requested appearance and reduced-motion flag.
pub const fn resolve(appearance: Appearance, reduced_motion: bool) -> ThemeTokens {
    ThemeTokens {
        appearance,
        colors: match appearance {
            Appearance::Light => LIGHT_PALETTE,
            Appearance::Dark => DARK_PALETTE,
        },
        typography: TYPOGRAPHY,
        radii: RADII,
        spacing: SPACING,
        motion: if reduced_motion { MOTION_REDUCED } else { MOTION_STANDARD },
        desktop_control_height_px: 36,
        touch_target_min_px: 44,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn palettes_meet_wcag_aa_contrast() {
        for (name, p) in [("light", LIGHT_PALETTE), ("dark", DARK_PALETTE)] {
            assert!(p.foreground.contrast_ratio(p.background) >= 12.0, "{name} foreground/background");
            assert!(p.muted_foreground.contrast_ratio(p.background) >= 7.0, "{name} muted/background");
            assert!(p.primary_foreground.contrast_ratio(p.primary) >= 4.5, "{name} primary contrast");
            assert!(p.secondary_foreground.contrast_ratio(p.secondary) >= 4.5, "{name} secondary contrast");
            assert!(p.accent_foreground.contrast_ratio(p.accent) >= 4.5, "{name} accent contrast");
        }
    }

    #[test]
    fn resolves_appearance_and_reduced_motion() {
        let light = resolve(Appearance::Light, false);
        assert_eq!(light.colors.primary.to_hex(), "#056b5b");
        assert_eq!(light.motion.sheet_ms, 220);

        let dark_reduced = resolve(Appearance::Dark, true);
        assert_eq!(dark_reduced.colors.background.to_hex(), "#0e1513");
        assert_eq!(dark_reduced.motion.nav_stack_ms, 0);
        assert_eq!(dark_reduced.touch_target_min_px, 44);
    }
}
