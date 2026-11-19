//! Production state & virtualized 10,000-row ledger backing `AutoDesktopWorkspace`.

use auto_auth::{
    jwt::{JwkSet, derive_ed25519_keypair, jwk_from_verifying_key},
    password::hash_password_argon2id_with_salt,
};
use auto_facturx::xml as to_cii_xml;
use auto_i18n::catalog;
use auto_model::{Document, DocumentType, LineItem, Party, format_eur};
use auto_theme::Appearance;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Section {
    Overview,
    Invoices,
    Workflows,
    ClusterAuth,
    Updates,
}

impl Section {
    pub const ALL: [Section; 5] = [
        Section::Overview,
        Section::Invoices,
        Section::Workflows,
        Section::ClusterAuth,
        Section::Updates,
    ];

    pub fn label_key(self) -> &'static str {
        match self {
            Self::Overview => "Overview",
            Self::Invoices => "Documents",
            Self::Workflows => "Automations",
            Self::ClusterAuth => "Cluster & Auth",
            Self::Updates => "Updater",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeMode {
    Serverless,
    SelfHosted,
}

impl RuntimeMode {
    pub fn toggle(self) -> Self {
        match self {
            Self::Serverless => Self::SelfHosted,
            Self::SelfHosted => Self::Serverless,
        }
    }

    pub fn label_key(self) -> &'static str {
        match self {
            Self::Serverless => "Cloudflare Serverless",
            Self::SelfHosted => "Self-Hosted Cluster",
        }
    }
}

#[derive(Clone, Debug)]
pub struct DesktopDocumentRow {
    pub id: String,
    pub document: Document,
    pub total_excl_vat_cents: i64,
    pub total_incl_vat_cents: i64,
    pub paid: bool,
    pub number_lower: String,
    pub customer_lower: String,
}

impl DesktopDocumentRow {
    pub fn from_document(id: impl Into<String>, document: Document, paid: bool) -> Self {
        let totals = document.totals();
        let number_lower = document.number.to_ascii_lowercase();
        let customer_lower = document.customer.name.to_ascii_lowercase();
        Self {
            id: id.into(),
            document,
            total_excl_vat_cents: totals.total_excl_vat_cents,
            total_incl_vat_cents: totals.total_incl_vat_cents,
            paid,
            number_lower,
            customer_lower,
        }
    }
}

#[derive(Clone, Debug)]
pub struct DagNode {
    pub id: &'static str,
    pub title: &'static str,
    pub status: &'static str,
    pub x: f32,
    pub y: f32,
}

pub struct AutoDesktopStore {
    pub lang: &'static str,
    pub appearance: Appearance,
    pub mode: RuntimeMode,
    pub section: Section,
    pub command_palette_open: bool,
    pub search_query: String,
    pub documents: Vec<DesktopDocumentRow>,
    pub filtered_indices: Vec<usize>,
    pub selected_doc_idx: Option<usize>,
    pub facturx_preview: String,
    pub auth_preview: String,
    pub nodes: Vec<DagNode>,
    next_seq: usize,
}

impl AutoDesktopStore {
    /// Production constructor preloading `doc_count` commercial documents (`10_000` by default in desktop & bench).
    pub fn with_document_count(doc_count: usize) -> Self {
        let mut documents = Vec::with_capacity(doc_count);
        let issuer = Party {
            name: "Auto SAS".to_owned(),
            tax_id: Some("80212345600018".to_owned()),
            address: "14 Rue de la Paix, 75002 Paris".to_owned(),
            delivery_address: None,
            vat_number: Some("FR12802123456".to_owned()),
            email: Some("billing@auto.aphrody.com".to_owned()),
        };
        let clients = [
            "Acme Europe SAS",
            "Nordic Logistics SARL",
            "Helios Robotics",
            "Ateliers Valmy",
            "Solstice Cloud",
        ];

        for i in 0..doc_count {
            let is_quote = i % 4 == 3;
            let prefix = if is_quote { "DV" } else { "FA" };
            let client_name = clients[i % clients.len()];
            let unit_cents = 45_000 + ((i % 25) as i64) * 5_000;
            let doc = Document {
                number: format!("{prefix}-2026-{:05}", i + 1),
                doc_type: if is_quote {
                    DocumentType::Quote
                } else {
                    DocumentType::Invoice
                },
                date: "2026-11-18".to_owned(),
                issuer: issuer.clone(),
                customer: Party {
                    name: format!("{client_name} #{}", (i % 97) + 1),
                    tax_id: Some(format!("90212345{:06}", (i % 900_000) + 100_000)),
                    address: "42 Avenue Jean Jaures, 69007 Lyon".to_owned(),
                    delivery_address: None,
                    vat_number: None,
                    email: None,
                },
                lines: vec![LineItem {
                    description: "Aphrody Edge Cluster & Compliance".to_owned(),
                    quantity: f64::from(((i % 5) + 1) as u32),
                    unit_price_excl_vat_cents: unit_cents,
                    vat: 200,
                    unit: Some("month".to_owned()),
                    discount_bp: if i % 7 == 0 { Some(500) } else { None },
                }],
                service_date: None,
                due_date: Some("2026-12-18".to_owned()),
                payment_terms: None,
                late_penalties: None,
                early_discount: None,
                vat_exempt: false,
                origin: None,
                validity_days: Some(30),
                notes: None,
                template: None,
                locale: Some("en".to_owned()),
            };
            documents.push(DesktopDocumentRow::from_document(
                format!("doc-{i}"),
                doc,
                i % 3 != 0,
            ));
        }

        let filtered_indices = (0..documents.len()).collect();
        let facturx_preview = documents
            .first()
            .and_then(|r| to_cii_xml(&r.document).ok())
            .unwrap_or_default();

        let (signing_key, kid) = derive_ed25519_keypair("auto-desktop-local-preview", "ed25519-main");
        let jwks = JwkSet {
            keys: vec![jwk_from_verifying_key(&signing_key.verifying_key(), &kid)],
        };
        let jwk = serde_json::to_string_pretty(&jwks).unwrap_or_default();
        let sample_hash =
            hash_password_argon2id_with_salt("auto-desktop-sample", &[7; 16]).unwrap_or_default();

        Self {
            lang: "en",
            appearance: Appearance::Light,
            mode: RuntimeMode::Serverless,
            section: Section::Invoices,
            command_palette_open: false,
            search_query: String::new(),
            documents,
            filtered_indices,
            selected_doc_idx: if doc_count > 0 { Some(0) } else { None },
            facturx_preview,
            auth_preview: format!("Argon2id sample:\n{sample_hash}\n\nEd25519 JWKS:\n{jwk}"),
            nodes: vec![
                DagNode { id: "trigger", title: "Invoice Draft Created", status: "ok", x: 32.0, y: 40.0 },
                DagNode { id: "siret", title: "SIRET & TVA Check", status: "ok", x: 256.0, y: 40.0 },
                DagNode { id: "facturx", title: "Factur-X PDF/A-3b", status: "ok", x: 480.0, y: 40.0 },
                DagNode { id: "sync", title: "CompanyDO HLC Sync", status: "ok", x: 256.0, y: 156.0 },
            ],
            next_seq: doc_count + 1,
        }
    }

    pub fn tr<'a>(&'a self, source: &'a str) -> String {
        catalog().tr(self.lang, source).into_owned()
    }

    pub fn format_cents(&self, cents: i64) -> String {
        format_eur(cents, self.lang)
    }

    pub fn toggle_language(&mut self) {
        self.lang = if self.lang == "en" { "fr" } else { "en" };
    }

    pub fn toggle_appearance(&mut self) -> Appearance {
        self.appearance = match self.appearance {
            Appearance::Light => Appearance::Dark,
            Appearance::Dark => Appearance::Light,
        };
        self.appearance
    }

    pub fn toggle_mode(&mut self) {
        self.mode = self.mode.toggle();
    }

    pub fn set_filter(&mut self, query: &str) {
        let needle = query.trim().to_ascii_lowercase();
        if needle == self.search_query && self.filtered_indices.len() == self.documents.len() {
            return;
        }
        self.search_query = needle;
        self.filtered_indices.clear();
        if self.search_query.is_empty() {
            self.filtered_indices.extend(0..self.documents.len());
        } else {
            for (idx, row) in self.documents.iter().enumerate() {
                if row.number_lower.contains(&self.search_query)
                    || row.customer_lower.contains(&self.search_query)
                {
                    self.filtered_indices.push(idx);
                }
            }
        }
        self.selected_doc_idx = self.filtered_indices.first().copied();
        self.refresh_facturx_preview();
    }

    pub fn select_filtered(&mut self, filtered_pos: usize) {
        if let Some(&doc_idx) = self.filtered_indices.get(filtered_pos) {
            self.selected_doc_idx = Some(doc_idx);
            self.refresh_facturx_preview();
        }
    }

    pub fn create_quick_quote(&mut self, customer_name: &str) {
        let clean = customer_name.trim();
        let name = if clean.is_empty() { "New Client SAS" } else { clean };
        let seq = self.next_seq;
        self.next_seq += 1;
        let doc = Document {
            number: format!("DV-2026-{seq:05}"),
            doc_type: DocumentType::Quote,
            date: "2026-11-18".to_owned(),
            issuer: Party {
                name: "Auto SAS".to_owned(),
                tax_id: Some("80212345600018".to_owned()),
                address: "14 Rue de la Paix, 75002 Paris".to_owned(),
                delivery_address: None,
                vat_number: None,
                email: None,
            },
            customer: Party {
                name: name.to_owned(),
                tax_id: None,
                address: "Paris, France".to_owned(),
                delivery_address: None,
                vat_number: None,
                email: None,
            },
            lines: vec![LineItem {
                description: "Integration Package".to_owned(),
                quantity: 1.0,
                unit_price_excl_vat_cents: 95_000,
                vat: 200,
                unit: Some("unit".to_owned()),
                discount_bp: None,
            }],
            service_date: None,
            due_date: Some("2026-12-18".to_owned()),
            payment_terms: None,
            late_penalties: None,
            early_discount: None,
            vat_exempt: false,
            origin: None,
            validity_days: Some(30),
            notes: None,
            template: None,
            locale: Some(self.lang.to_owned()),
        };
        let row = DesktopDocumentRow::from_document(format!("doc-q-{seq}"), doc, false);
        self.documents.insert(0, row);
        let current = self.search_query.clone();
        self.set_filter(&current);
        self.selected_doc_idx = Some(0);
        self.refresh_facturx_preview();
    }

    pub fn selected_document(&self) -> Option<&DesktopDocumentRow> {
        self.selected_doc_idx.and_then(|i| self.documents.get(i))
    }

    pub fn refresh_facturx_preview(&mut self) {
        self.facturx_preview = self
            .selected_document()
            .and_then(|r| to_cii_xml(&r.document).ok())
            .unwrap_or_default();
    }
}
