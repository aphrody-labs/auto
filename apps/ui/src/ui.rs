//! Reusable styled NSH UI primitives consuming `nsh_base::theme()` semantic tokens exclusively.

use nsh_base::{button, input, theme};
use nsh_core::{element::IntoProp, prelude::*};

use crate::{nav, store};

pub fn primary_button(
    label: impl IntoReactive<SharedString>,
    on_press: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .on_press(on_press)
        .h_9()
        .px_4()
        .items_center()
        .justify_center()
        .rounded(move || theme().radius)
        .bg(move || theme().primary)
        .active(|s| s.opacity(0.85))
        .focus_visible(|s| s.outline(px(2.0)).outline_color(move || theme().ring))
        .disabled_style(|s| s.opacity(0.45))
        .child(
            text(label)
                .text_sm()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(move || theme().primary_foreground),
        )
}

pub fn outline_button<M: 'static>(
    label: impl IntoReactive<SharedString>,
    selected: impl IntoProp<bool, M>,
    on_press: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .selected(selected)
        .on_press(on_press)
        .h_9()
        .px_3()
        .items_center()
        .justify_center()
        .rounded(move || theme().radius)
        .border_1()
        .border_color(move || theme().border)
        .bg(move || theme().card)
        .app_class("selected:bg-accent")
        .active(|s| s.opacity(0.75))
        .focus_visible(|s| s.outline(px(2.0)).outline_color(move || theme().ring))
        .child(
            text(label)
                .text_sm()
                .text_color(move || theme().foreground),
        )
}

pub fn text_field(placeholder: &'static str, value: impl Fn() -> String + 'static, on_change: impl Fn(&str) + 'static) -> nsh_base::Input {
    input()
        .value(value)
        .on_change(on_change)
        .placeholder(placeholder)
        .placeholder_color(|| color(theme().muted_foreground))
        .caret_color(|| color(theme().primary))
        .h_9()
        .px_3()
        .text_sm()
        .rounded(move || theme().radius)
        .border_1()
        .border_color(move || theme().input)
        .bg(move || theme().card)
        .text_color(move || theme().foreground)
        .focus(|s| s.border_color(move || theme().ring))
}

pub fn card(child: impl IntoElement) -> impl IntoElement {
    view()
        .p_4()
        .rounded(move || theme().radius)
        .border_1()
        .border_color(move || theme().border)
        .bg(move || theme().card)
        .child(child)
}

pub fn top_header(title: impl Fn() -> String + 'static) -> impl IntoElement {
    view()
        .flex_row()
        .items_center()
        .justify_between()
        .gap_3()
        .p_3()
        .border_b_1()
        .border_b_color(move || theme().border)
        .bg(move || theme().sidebar)
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_3()
                .child(when(nav::can_go_back, || {
                    outline_button(move || store::tr("Back"), false, nav::pop_document)
                }))
                .child(
                    text(title)
                        .text_base()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(move || theme().foreground),
                ),
        )
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_2()
                .child(outline_button(
                    move || store::tr(store::mode().key()),
                    move || store::mode() == store::RuntimeMode::SelfHosted,
                    store::toggle_mode,
                ))
                .child(outline_button(
                    move || if store::lang() == "fr" { "FR" } else { "EN" },
                    move || store::lang() == "fr",
                    store::toggle_lang,
                ))
                .child(outline_button(
                    move || if store::is_dark() { store::tr("Dark") } else { store::tr("Light") },
                    store::is_dark,
                    store::toggle_dark,
                )),
        )
}
