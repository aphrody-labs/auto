//! Primary 120 FPS GPUI Desktop Workspace (`Render` + `Focusable` + actions + virtualized 10k-row `uniform_list`).

use gpui_kit::{
    App, AppContext, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement, KeyBinding,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Window,
    component::{
        button::{Button, ButtonVariants},
        h_flex,
        input::{Input, InputEvent, InputState},
        v_flex,
    },
    div, px, uniform_list,
};

use crate::{
    dag_canvas::render_dag_canvas,
    store::{AutoDesktopStore, Section},
    theme::{DesktopPalette, sync_gpui_theme},
};

gpui_kit::actions!(
    auto_desktop,
    [
        ToggleCommandPalette,
        CloseCommandPalette,
        ToggleLanguage,
        ToggleTheme,
        ToggleMode,
        NewQuickQuote,
    ]
);

pub fn register_keybindings(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("ctrl-k", ToggleCommandPalette, Some("AutoWorkspace")),
        KeyBinding::new("escape", CloseCommandPalette, Some("AutoWorkspace")),
    ]);
}

pub struct AutoDesktopWorkspace {
    pub store: AutoDesktopStore,
    pub focus_handle: FocusHandle,
    search_input: Entity<InputState>,
    _subscriptions: Vec<gpui_kit::Subscription>,
}

impl AutoDesktopWorkspace {
    pub fn new(doc_count: usize, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search_input = cx.new(|cx| InputState::new(window, cx).placeholder("Search 10,000 invoices, customers, SIRET..."));
        let sub = cx.subscribe_in(&search_input, window, |this, state, event: &InputEvent, _window, cx| {
            if matches!(event, InputEvent::Change) {
                let q = state.read(cx).value().to_string();
                this.store.set_filter(&q);
                cx.notify();
            }
        });
        Self {
            store: AutoDesktopStore::with_document_count(doc_count),
            focus_handle: cx.focus_handle(),
            search_input,
            _subscriptions: vec![sub],
        }
    }

    pub fn palette(&self) -> DesktopPalette {
        DesktopPalette::from_appearance(self.store.appearance, false)
    }

    fn toggle_palette(&mut self, _: &ToggleCommandPalette, _window: &mut Window, cx: &mut Context<Self>) {
        self.store.command_palette_open = !self.store.command_palette_open;
        cx.notify();
    }

    fn close_palette(&mut self, _: &CloseCommandPalette, _window: &mut Window, cx: &mut Context<Self>) {
        if self.store.command_palette_open {
            self.store.command_palette_open = false;
            cx.notify();
        }
    }

    fn toggle_language(&mut self, _: &ToggleLanguage, _window: &mut Window, cx: &mut Context<Self>) {
        self.store.toggle_language();
        cx.notify();
    }

    fn toggle_theme(&mut self, _: &ToggleTheme, _window: &mut Window, cx: &mut Context<Self>) {
        let next = self.store.toggle_appearance();
        sync_gpui_theme(next, cx);
        cx.notify();
    }

    fn toggle_mode(&mut self, _: &ToggleMode, _window: &mut Window, cx: &mut Context<Self>) {
        self.store.toggle_mode();
        cx.notify();
    }

    fn create_quote(&mut self, _: &NewQuickQuote, _window: &mut Window, cx: &mut Context<Self>) {
        self.store.create_quick_quote("Acme Desktop Quote");
        cx.notify();
    }

    fn render_header(&self, pal: DesktopPalette, cx: &mut Context<Self>) -> impl IntoElement {
        let lang_label: SharedString = self.store.lang.to_ascii_uppercase().into();
        let mode_label: SharedString = self.store.tr(self.store.mode.label_key()).into();
        let theme_label: SharedString = if matches!(self.store.appearance, auto_theme::Appearance::Dark) {
            self.store.tr("Light")
        } else {
            self.store.tr("Dark")
        }
        .into();

        h_flex()
            .w_full()
            .px_4()
            .py_2()
            .gap_3()
            .items_center()
            .justify_between()
            .bg(pal.sidebar)
            .border_b_1()
            .border_color(pal.border)
            .child(
                h_flex()
                    .gap_3()
                    .items_center()
                    .child(div().text_sm().font_weight(gpui_kit::FontWeight::BOLD).text_color(pal.foreground).child("Auto Desktop 120 FPS"))
                    .child(div().w(px(320.0)).child(Input::new(&self.search_input))),
            )
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        Button::new("mode-btn")
                            .label(mode_label)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.store.toggle_mode();
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("lang-btn")
                            .label(lang_label)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.store.toggle_language();
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("theme-btn")
                            .label(theme_label)
                            .on_click(cx.listener(|this, _, _, cx| {
                                let next = this.store.toggle_appearance();
                                sync_gpui_theme(next, cx);
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("palette-btn")
                            .label("Ctrl+K")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.store.command_palette_open = !this.store.command_palette_open;
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("new-quote-btn")
                            .primary()
                            .label(SharedString::from(self.store.tr("New Quote")))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.store.create_quick_quote("Fast GPUI Client");
                                cx.notify();
                            })),
                    ),
            )
    }

    fn render_rail(&self, pal: DesktopPalette, cx: &mut Context<Self>) -> impl IntoElement {
        let mut rail = v_flex()
            .w(px(210.0))
            .h_full()
            .p_3()
            .gap_2()
            .bg(pal.sidebar)
            .border_r_1()
            .border_color(pal.border);

        for sec in Section::ALL {
            let active = self.store.section == sec;
            let label: SharedString = self.store.tr(sec.label_key()).into();
            let id: SharedString = format!("nav-{:?}", sec).into();
            let btn = if active {
                Button::new(id).primary().label(label)
            } else {
                Button::new(id).label(label)
            };
            rail = rail.child(
                btn.w_full().on_click(cx.listener(move |this, _, _, cx| {
                    this.store.section = sec;
                    cx.notify();
                })),
            );
        }
        rail
    }

    fn render_invoices(&self, pal: DesktopPalette, cx: &mut Context<Self>) -> impl IntoElement {
        let count = self.store.filtered_indices.len();
        let preview = self.store.facturx_preview.clone();
        let selected_header: SharedString = self
            .store
            .selected_document()
            .map(|r| format!("{} — {}", r.document.number, r.document.customer.name))
            .unwrap_or_else(|| self.store.tr("Documents"))
            .into();

        h_flex()
            .flex_1()
            .h_full()
            .p_4()
            .gap_4()
            .child(
                v_flex()
                    .flex_1()
                    .h_full()
                    .bg(pal.card)
                    .border_1()
                    .border_color(pal.border)
                    .rounded(pal.radius_lg)
                    .p_2()
                    .child(
                        uniform_list(
                            "invoices-virtual-list",
                            count,
                            cx.processor(move |this, range: std::ops::Range<usize>, _window, cx| {
                                let p = this.palette();
                                range
                                    .map(|row_pos| {
                                        let doc_idx = this.store.filtered_indices[row_pos];
                                        let row = &this.store.documents[doc_idx];
                                        let selected = this.store.selected_doc_idx == Some(doc_idx);
                                        let amount: SharedString = this.store.format_cents(row.total_incl_vat_cents).into();
                                        let title: SharedString = format!("{} — {}", row.document.number, row.document.customer.name).into();
                                        let badge: SharedString = if row.paid { this.store.tr("Paid") } else { this.store.tr("Pending") }.into();

                                        h_flex()
                                            .id(("inv-row", row_pos))
                                            .h(px(40.0))
                                            .w_full()
                                            .px_3()
                                            .justify_between()
                                            .items_center()
                                            .rounded(p.radius_md)
                                            .bg(if selected { p.accent } else { p.card })
                                            .on_click(cx.listener(move |ws, _, _, cx| {
                                                ws.store.select_filtered(row_pos);
                                                cx.notify();
                                            }))
                                            .child(div().text_sm().text_color(p.foreground).child(title))
                                            .child(
                                                h_flex()
                                                    .gap_3()
                                                    .child(div().text_xs().text_color(if row.paid { p.up } else { p.warn }).child(badge))
                                                    .child(div().text_sm().text_color(p.foreground).child(amount)),
                                            )
                                    })
                                    .collect()
                            }),
                        )
                        .size_full(),
                    ),
            )
            .child(
                v_flex()
                    .w(px(380.0))
                    .h_full()
                    .p_4()
                    .gap_3()
                    .bg(pal.card)
                    .border_1()
                    .border_color(pal.border)
                    .rounded(pal.radius_lg)
                    .child(div().text_base().font_weight(gpui_kit::FontWeight::SEMIBOLD).text_color(pal.foreground).child(selected_header))
                    .child(div().text_xs().text_color(pal.muted_foreground).child("Factur-X EN 16931 CII XML Preview"))
                    .child(
                        div()
                            .flex_1()
                            .p_3()
                            .bg(pal.muted)
                            .rounded(pal.radius_md)
                            .overflow_hidden()
                            .text_xs()
                            .text_color(pal.foreground)
                            .child(preview),
                    ),
            )
    }

    fn render_workflows(&self, pal: DesktopPalette) -> impl IntoElement {
        v_flex()
            .flex_1()
            .p_4()
            .gap_4()
            .child(div().text_base().font_weight(gpui_kit::FontWeight::SEMIBOLD).text_color(pal.foreground).child("Workflow DAG Canvas (GPU 120 FPS)"))
            .child(render_dag_canvas(&self.store.nodes, pal))
    }

    fn render_cluster_auth(&self, pal: DesktopPalette) -> impl IntoElement {
        v_flex()
            .flex_1()
            .p_4()
            .gap_4()
            .child(div().text_base().font_weight(gpui_kit::FontWeight::SEMIBOLD).text_color(pal.foreground).child("Rust Better Auth (`auto-auth`) & Cluster Endpoints"))
            .child(
                div()
                    .p_4()
                    .bg(pal.card)
                    .border_1()
                    .border_color(pal.border)
                    .rounded(pal.radius_lg)
                    .text_xs()
                    .text_color(pal.foreground)
                    .child(self.store.auth_preview.clone()),
            )
    }
}

impl Focusable for AutoDesktopWorkspace {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for AutoDesktopWorkspace {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let pal = self.palette();
        let body: gpui_kit::AnyElement = match self.store.section {
            Section::Overview | Section::Invoices => self.render_invoices(pal, cx).into_any_element(),
            Section::Workflows => self.render_workflows(pal).into_any_element(),
            Section::ClusterAuth | Section::Updates => self.render_cluster_auth(pal).into_any_element(),
        };

        let mut root = v_flex()
            .key_context("AutoWorkspace")
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::toggle_palette))
            .on_action(cx.listener(Self::close_palette))
            .on_action(cx.listener(Self::toggle_language))
            .on_action(cx.listener(Self::toggle_theme))
            .on_action(cx.listener(Self::toggle_mode))
            .on_action(cx.listener(Self::create_quote))
            .size_full()
            .bg(pal.background)
            .child(self.render_header(pal, cx))
            .child(h_flex().flex_1().w_full().min_h(px(0.0)).child(self.render_rail(pal, cx)).child(body));

        if self.store.command_palette_open {
            root = root.child(
                div()
                    .id("cmd-palette-backdrop")
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        v_flex()
                            .w(px(420.0))
                            .p_4()
                            .gap_2()
                            .bg(pal.popover)
                            .border_1()
                            .border_color(pal.ring)
                            .rounded(pal.radius_lg)
                            .child(div().text_sm().font_weight(gpui_kit::FontWeight::BOLD).text_color(pal.foreground).child("Command Palette (Esc to close)"))
                            .child(
                                Button::new("cmd-switch-lang")
                                    .label("Switch Language (EN / FR)")
                                    .on_click(cx.listener(|ws, _, _, cx| {
                                        ws.store.toggle_language();
                                        ws.store.command_palette_open = false;
                                        cx.notify();
                                    })),
                            )
                            .child(
                                Button::new("cmd-switch-wf")
                                    .label("Open Workflow DAG Canvas")
                                    .on_click(cx.listener(|ws, _, _, cx| {
                                        ws.store.section = Section::Workflows;
                                        ws.store.command_palette_open = false;
                                        cx.notify();
                                    })),
                            ),
                    ),
            );
        }

        root
    }
}
