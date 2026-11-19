# Auto Design System Specification

## Semantic Design Tokens

Derived from `crates/auto-theme` (`auto_theme`) aligned with Material 3 Expressive (`https://design.google/`). No raw hex literals appear inside UI views or components.

- **Light palette**:
  - Background `#F6F8F7`, Surface `#FFFFFF`, Surface Variant `#ECF1EE`, Elevated `#E2E9E5`
  - Primary `#0B5D4E` (foreground `#FFFFFF`, hover `#094A3E`), container `#D3EDE7`
  - Foreground `#111C19`, muted `#4A5D57`, border `#CBD7D2`
  - Danger `#B3261E`, Warning `#8A5300`, Success `#146C2E`, Info `#00639B`
- **Dark palette**:
  - Background `#0D1412`, Surface `#131D1A`, Surface Variant `#1C2A25`, Elevated `#24342F`
  - Primary `#5CD4BC` (foreground `#072B24`), container `#12483E`
  - Foreground `#E8F0ED`, muted `#9AB0A8`, border `#2A3B35`
- **Typography**: Clean UI sans-serif + monospace for tax IDs, ledger numbers, and invoice totals (`13px` dense tables, `14px` body, `22px` title).
- **Spacing & Radii**: 4px base unit (`4, 8, 12, 16, 24, 32`), radii `4 / 8 / 12 / 16`, border `1px`.
- **Accessibility**: Minimum `4.5:1` contrast ratio verified in `auto-theme` unit tests; visible focus ring on interactive elements; Escape dismisses topmost dialog/palette.

## Motion Inventory (Pre-Flight Specification)

1. **Navigation rail selection indicator**: 160ms cubic ease on tab change; instant snap under `reduced_motion`.
2. **Command palette (`Ctrl+K`)**: 150ms fade/scale entrance from top-center, Escape returns focus to trigger.
3. **Interactive buttons and list rows**: 90ms background tint transition on hover and active state.
4. **Virtual 10k-row invoice scroll**: Zero-alloc `uniform_list` frame reuse targeting `< 8.33 ms` (120 FPS).
5. **Locale switch (`EN` / `FR`)**: Immediate reactive string lookup without dropping form focus or scroll offset.
6. **Live sync & load balancer badge**: Smooth state dot transition (`connected`, `reconnecting`, `offline`).

## Finishing Checklist

- Geometry & Radii: Nested panel borders align (`radius = parent - inset`).
- Typography: All monetary figures and dates formatted per active locale (`en` / `fr`).
- Spacing: Uniform 16px panel gutters and 8px control gaps.
- Alignment: Column headers aligned right for numeric columns (`Amount`, `VAT`).
- Color: Semantic token roles verified across both light and dark themes.
- Interaction states: Hover, focus, active, disabled, empty, and error states implemented.
