//! Workspace and detail screens rendered inside `nav_stack()`.

use auto_model::format_eur;
use nsh_base::{button, nav_page, switch, theme};
use nsh_core::{
    element::{Position, Screen},
    prelude::*,
};

use crate::{
    nav::{self, Section},
    store,
    theme_bridge::{info_color, up_color, warn_color},
    ui::{card, outline_button, primary_button, text_field, top_header},
};

pub fn workspace_screen() -> Screen {
    let new_customer = signal(String::new());
    let submit_quote = move || {
        let val = new_customer.get_untracked();
        store::add_quick_quote(&val);
        new_customer.set(String::new());
    };

    nav_page()
        .title(move || store::tr("Auto Workspace"))
        .header(top_header(move || store::tr("Auto Workspace")))
        .child(
            view()
                .flex_1()
                .gap_4()
                .p_4()
                .pb_safe_area_plus(px(16.0))
                .child(nav_strip())
                .child(
                    view()
                        .flex_row()
                        .items_center()
                        .gap_2()
                        .child(text_field(
                            "Search",
                            store::search_query,
                            store::set_search_query,
                        ).flex_1())
                        .child(text_field(
                            "New quote customer",
                            move || new_customer.get(),
                            move |v| new_customer.set(v.to_owned()),
                        ).flex_1())
                        .child(primary_button(
                            move || store::tr("New Quote"),
                            submit_quote,
                        )),
                )
                .child(
                    view()
                        .flex_1()
                        .child(
                            virtual_list(store::document_count, document_row)
                                .keys(store::filtered_document_ids)
                                .estimated_item_size(px(56.0))
                                .flex_1(),
                        ),
                )
                .child(cluster_strip()),
        )
}

fn nav_strip() -> impl IntoElement {
    view()
        .flex_row()
        .items_center()
        .gap_2()
        .child(outline_button(
            move || store::tr("Documents"),
            move || store::section() == Section::Documents,
            || store::set_section(Section::Documents),
        ))
        .child(outline_button(
            move || store::tr("Customers"),
            move || store::section() == Section::Customers,
            || store::set_section(Section::Customers),
        ))
        .child(outline_button(
            move || store::tr("Automations"),
            move || store::section() == Section::Automations,
            || store::set_section(Section::Automations),
        ))
        .child(outline_button(
            move || store::tr("Cluster"),
            move || store::section() == Section::Cluster,
            || store::set_section(Section::Cluster),
        ))
}

fn document_row(at: Position) -> impl IntoElement {
    let doc = computed(move || store::document_at(at.index()));
    button()
        .flex_row()
        .items_center()
        .justify_between()
        .p_3()
        .mb_2()
        .rounded(move || theme().radius)
        .border_1()
        .border_color(move || theme().border)
        .bg(move || theme().card)
        .active(|s| s.bg(move || theme().muted))
        .on_press(move || {
            if let Some(d) = doc.get_untracked() {
                nav::push_document(d.id);
            }
        })
        .child(
            view()
                .flex_col()
                .gap_1()
                .child(
                    text(move || {
                        doc.get()
                            .map(|d| format!("{} — {}", d.number, d.customer.name))
                            .unwrap_or_default()
                    })
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(move || theme().foreground),
                )
                .child(
                    text(move || {
                        doc.get()
                            .map(|d| d.kind.label(store::lang()))
                            .unwrap_or_default()
                    })
                    .text_xs()
                    .text_color(move || theme().muted_foreground),
                ),
        )
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_3()
                .child(
                    text(move || {
                        doc.get()
                            .map(|d| format_eur(d.total_excl_vat_cents(), store::lang()))
                            .unwrap_or_default()
                    })
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(move || theme().foreground),
                )
                .child(
                    text(move || match doc.get() {
                        Some(d) if d.paid => store::tr("Paid"),
                        _ => store::tr("Pending"),
                    })
                    .text_xs()
                    .text_color(move || match doc.get() {
                        Some(d) if d.paid => up_color(),
                        _ => warn_color(),
                    }),
                ),
        )
}

pub fn document_detail_screen(id: String) -> Screen {
    let toggle_id = id.clone();
    let doc = computed(move || store::document_by_id(&id));

    nav_page()
        .title(move || doc.get().map(|d| d.number).unwrap_or_default())
        .header(top_header(move || doc.get().map(|d| d.number).unwrap_or_default()))
        .child(
            view()
                .flex_1()
                .gap_4()
                .p_4()
                .child(card(
                    view()
                        .flex_col()
                        .gap_2()
                        .child(
                            text(move || doc.get().map(|d| d.customer.name).unwrap_or_default())
                                .text_lg()
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(move || theme().foreground),
                        )
                        .child(
                            text(move || {
                                doc.get()
                                    .map(|d| format_eur(d.total_excl_vat_cents(), store::lang()))
                                    .unwrap_or_default()
                            })
                            .text_base()
                            .text_color(move || info_color()),
                        ),
                ))
                .child(
                    switch()
                        .checked(move || doc.get().is_some_and(|d| d.paid))
                        .on_change(move |&paid: &bool| store::mark_paid(&toggle_id, paid))
                        .flex_row()
                        .items_center()
                        .gap_3()
                        .track_class("w-11 rounded-full bg-muted p-0.5 transition-colors checked:bg-primary")
                        .thumb_class("size-5 rounded-full bg-background transition-transform checked:translate-x-5")
                        .child(text(move || store::tr("Paid")).text_color(move || theme().foreground)),
                ),
        )
}

fn cluster_strip() -> impl IntoElement {
    card(
        view()
            .flex_row()
            .items_center()
            .justify_between()
            .child(
                text(move || {
                    let nodes = store::nodes();
                    let up_count = nodes.iter().filter(|n| n.healthy).count();
                    format!("{} ({up_count}/{})", store::tr("Cluster Load Balancer"), nodes.len())
                })
                .text_xs()
                .text_color(move || up_color()),
            )
            .child(
                text("Factur-X EN 16931 • Art. 286 CGI • FEC")
                    .text_xs()
                    .text_color(move || theme().muted_foreground),
            ),
    )
}
