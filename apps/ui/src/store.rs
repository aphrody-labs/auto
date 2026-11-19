//! Reactive store owning Auto's cross-platform NSH state cleanly via `global<AutoUiState>()`.

use auto_model::{DocumentType, LineItem, Party};
use nsh_core::prelude::*;

use crate::nav::Section;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RuntimeMode {
    Serverless,
    SelfHosted,
}

impl RuntimeMode {
    pub fn key(self) -> &'static str {
        match self {
            Self::Serverless => "Cloudflare Serverless",
            Self::SelfHosted => "Self-Hosted Cluster",
        }
    }
}

#[derive(Clone, PartialEq)]
pub struct UiDocument {
    pub id: String,
    pub kind: DocumentType,
    pub number: String,
    pub customer: Party,
    pub lines: Vec<LineItem>,
    pub paid: bool,
}

impl UiDocument {
    pub fn total_excl_vat_cents(&self) -> i64 {
        self.lines.iter().map(LineItem::net_excl_vat_cents).sum()
    }
}

#[derive(Clone, PartialEq)]
pub struct ClusterNode {
    pub id: String,
    pub endpoint: String,
    pub healthy: bool,
    pub latency_ms: u32,
}

#[derive(Clone)]
struct AutoUiState {
    lang: &'static str,
    dark: bool,
    mode: RuntimeMode,
    section: Section,
    search_query: String,
    documents: Vec<UiDocument>,
    nodes: Vec<ClusterNode>,
    next_seq: u32,
}

impl Default for AutoUiState {
    fn default() -> Self {
        Self {
            lang: "en",
            dark: false,
            mode: RuntimeMode::Serverless,
            section: Section::Documents,
            search_query: String::new(),
            documents: vec![
                UiDocument {
                    id: "doc-101".to_owned(),
                    kind: DocumentType::Invoice,
                    number: "FA-2026-0001".to_owned(),
                    customer: Party {
                        name: "Acme Europe SAS".to_owned(),
                        tax_id: Some("80212345600018".to_owned()),
                        address: "14 Rue de la Paix, 75002 Paris".to_owned(),
                        delivery_address: None,
                        vat_number: Some("FR12802123456".to_owned()),
                        email: Some("billing@acme.example".to_owned()),
                    },
                    lines: vec![LineItem {
                        description: "Cloudflare Durable Object Sync & Invoicing Engine".to_owned(),
                        quantity: 2.0,
                        unit_price_excl_vat_cents: 120_000,
                        vat: 200,
                        unit: Some("month".to_owned()),
                        discount_bp: None,
                    }],
                    paid: true,
                },
                UiDocument {
                    id: "doc-102".to_owned(),
                    kind: DocumentType::Quote,
                    number: "DV-2026-0002".to_owned(),
                    customer: Party {
                        name: "Nordic Logistics".to_owned(),
                        tax_id: Some("91234567800011".to_owned()),
                        address: "42 Avenue Jean Jaurès, 69007 Lyon".to_owned(),
                        delivery_address: None,
                        vat_number: None,
                        email: Some("ap@nordic.example".to_owned()),
                    },
                    lines: vec![LineItem {
                        description: "Annual Self-Hosted LTO Appliance License".to_owned(),
                        quantity: 1.0,
                        unit_price_excl_vat_cents: 240_000,
                        vat: 200,
                        unit: Some("year".to_owned()),
                        discount_bp: Some(500),
                    }],
                    paid: false,
                },
            ],
            nodes: vec![
                ClusterNode {
                    id: "cf-edge".to_owned(),
                    endpoint: "https://auto.aphrody.com".to_owned(),
                    healthy: true,
                    latency_ms: 14,
                },
                ClusterNode {
                    id: "prd-node".to_owned(),
                    endpoint: "prd (Self-Hosted LTO)".to_owned(),
                    healthy: true,
                    latency_ms: 28,
                },
                ClusterNode {
                    id: "fr2-proxy".to_owned(),
                    endpoint: "fr2 (Pingora Edge LB)".to_owned(),
                    healthy: true,
                    latency_ms: 19,
                },
            ],
            next_seq: 3,
        }
    }
}

fn state() -> Signal<AutoUiState> {
    global::<AutoUiState>()
}

pub fn tr(source: &'static str) -> String {
    let lang = state().with(|s| s.lang);
    auto_i18n::tr(lang, source).into_owned()
}

pub fn lang() -> &'static str {
    state().with(|s| s.lang)
}

pub fn toggle_lang() {
    state().update(|s| {
        s.lang = if s.lang == "en" { "fr" } else { "en" };
    });
}

pub fn is_dark() -> bool {
    state().with(|s| s.dark)
}

pub fn toggle_dark() {
    state().update(|s| {
        s.dark = !s.dark;
        set_color_scheme(if s.dark {
            Appearance::Dark
        } else {
            Appearance::Light
        });
    });
}

pub fn mode() -> RuntimeMode {
    state().with(|s| s.mode)
}

pub fn toggle_mode() {
    state().update(|s| {
        s.mode = match s.mode {
            RuntimeMode::Serverless => RuntimeMode::SelfHosted,
            RuntimeMode::SelfHosted => RuntimeMode::Serverless,
        };
    });
}

pub fn section() -> Section {
    state().with(|s| s.section)
}

pub fn set_section(next: Section) {
    state().update(|s| s.section = next);
}

pub fn search_query() -> String {
    state().with(|s| s.search_query.clone())
}

pub fn set_search_query(q: &str) {
    state().update(|s| s.search_query = q.to_owned());
}

pub fn filtered_document_ids() -> Vec<String> {
    state().with(|s| {
        let q = s.search_query.trim().to_ascii_lowercase();
        s.documents
            .iter()
            .filter(|d| {
                q.is_empty()
                    || d.number.to_ascii_lowercase().contains(&q)
                    || d.customer.name.to_ascii_lowercase().contains(&q)
            })
            .map(|d| d.id.clone())
            .collect()
    })
}

pub fn document_count() -> usize {
    filtered_document_ids().len()
}

pub fn document_at(idx: usize) -> Option<UiDocument> {
    let ids = filtered_document_ids();
    let target = ids.get(idx)?.clone();
    document_by_id(&target)
}

pub fn document_by_id(id: &str) -> Option<UiDocument> {
    state().with(|s| s.documents.iter().find(|d| d.id == id).cloned())
}

pub fn add_quick_quote(customer_name: &str) {
    let clean = customer_name.trim();
    if clean.is_empty() {
        return;
    }
    state().update(|s| {
        let seq = s.next_seq;
        s.next_seq += 1;
        s.documents.insert(
            0,
            UiDocument {
                id: format!("doc-{seq}"),
                kind: DocumentType::Quote,
                number: format!("DV-2026-{seq:04}"),
                customer: Party {
                    name: clean.to_owned(),
                    tax_id: None,
                    address: "Paris, France".to_owned(),
                    delivery_address: None,
                    vat_number: None,
                    email: None,
                },
                lines: vec![LineItem {
                    description: "Advisory & Software Integration".to_owned(),
                    quantity: 1.0,
                    unit_price_excl_vat_cents: 80_000,
                    vat: 200,
                    unit: Some("unit".to_owned()),
                    discount_bp: None,
                }],
                paid: false,
            },
        );
    });
}

pub fn mark_paid(id: &str, paid: bool) {
    state().update(|s| {
        if let Some(doc) = s.documents.iter_mut().find(|d| d.id == id) {
            doc.paid = paid;
        }
    });
}

pub fn nodes() -> Vec<ClusterNode> {
    state().with(|s| s.nodes.clone())
}
