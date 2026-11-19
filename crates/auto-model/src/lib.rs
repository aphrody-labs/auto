//! Canonical commercial document model, VAT rounding rules, and formatting helpers.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use thiserror::Error;

/// French/EU VAT exemption legal statement (Art. 293 B CGI).
pub const VAT_EXEMPT_NOTICE_FR: &str = "TVA non applicable, art. 293 B du CGI";
/// Default B2B fixed recovery fee note under French Commercial Code Art. D441-5.
pub const RECOVERY_FEE_NOTICE_FR: &str = "Indemnité forfaitaire pour frais de recouvrement : 40 €";

/// JSON parsing or validation errors for `Document` / `Invoice`.
#[derive(Debug, Error)]
#[error("invalid document JSON: {0}")]
pub struct JsonError(#[from] pub serde_json::Error);

/// Commercial document party (issuer or customer).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Party {
    #[serde(alias = "nom")]
    pub name: String,
    #[serde(default, alias = "siret", skip_serializing_if = "Option::is_none")]
    pub tax_id: Option<String>,
    #[serde(alias = "adresse")]
    pub address: String,
    #[serde(default, alias = "adresseLivraison", skip_serializing_if = "Option::is_none")]
    pub delivery_address: Option<String>,
    #[serde(default, alias = "tvaIntracom", skip_serializing_if = "Option::is_none")]
    pub vat_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

/// Invoice or quote line item.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineItem {
    #[serde(alias = "designation")]
    pub description: String,
    #[serde(alias = "quantite")]
    pub quantity: f64,
    #[serde(alias = "prixUnitaireHtCents", alias = "unitPriceCents")]
    pub unit_price_excl_vat_cents: i64,
    /// VAT rate in tenths of a percent (`200` = 20.0%, `100` = 10.0%, `55` = 5.5%).
    #[serde(alias = "tva", alias = "tvaRate", alias = "vatRate")]
    pub vat: u16,
    #[serde(default, alias = "unite", skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    /// Line discount in basis points (`0..=10_000`, e.g. `1000` = 10.00%).
    #[serde(default, alias = "remiseBp", skip_serializing_if = "Option::is_none")]
    pub discount_bp: Option<u16>,
}

impl LineItem {
    /// Net amount excluding VAT in cents, rounded identically to JS `Math.round`.
    pub fn net_excl_vat_cents(&self) -> i64 {
        let gross = round_js(self.quantity * self.unit_price_excl_vat_cents as f64);
        match self.discount_bp {
            Some(bp) if bp > 0 => {
                let discount = round_js(gross as f64 * f64::from(bp) / 10_000.0);
                gross - discount
            }
            _ => gross,
        }
    }
}

/// Supported commercial document kinds and UNTDID 1001 codes for Factur-X.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentType {
    #[serde(alias = "devis")]
    Quote,
    #[serde(alias = "facture")]
    Invoice,
    #[serde(alias = "acompte")]
    Deposit,
    #[serde(alias = "creditNote", alias = "avoir")]
    CreditNote,
}

impl DocumentType {
    /// Localized display label (`"Quote"`, `"Invoice"`, `"Deposit"`, `"Credit note"`, or French via `auto-i18n`).
    pub fn label(self, lang: &str) -> String {
        let key = self.english_label();
        auto_i18n::tr_ctx(lang, "pdf", key).into_owned()
    }

    /// Canonical English label key used in catalogs.
    pub const fn english_label(self) -> &'static str {
        match self {
            Self::Quote => "Quote",
            Self::Invoice => "Invoice",
            Self::Deposit => "Deposit",
            Self::CreditNote => "Credit note",
        }
    }

    /// UNTDID 1001 type code for EN 16931 CII XML (`None` for quotes).
    pub const fn untdid_code(self) -> Option<&'static str> {
        match self {
            Self::Quote => None,
            Self::Invoice => Some("380"),
            Self::Deposit => Some("386"),
            Self::CreditNote => Some("381"),
        }
    }
}

/// Embedded base64 brand logo for PDF rendering.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Logo {
    pub mime: String,
    #[serde(alias = "donneesBase64")]
    pub data_base64: String,
}

/// Optional visual branding overrides for PDF document layout.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    #[serde(default, alias = "couleur", skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo: Option<Logo>,
    #[serde(default, alias = "largeur", skip_serializing_if = "Option::is_none")]
    pub width: Option<f32>,
    #[serde(default, alias = "hauteur", skip_serializing_if = "Option::is_none")]
    pub height: Option<f32>,
    #[serde(default, alias = "piedDePage", skip_serializing_if = "Option::is_none")]
    pub footer: Option<String>,
}

/// Full commercial document (`Quote`, `Invoice`, `Deposit`, or `CreditNote`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invoice {
    #[serde(alias = "numero")]
    pub number: String,
    #[serde(rename = "type", alias = "docType")]
    pub doc_type: DocumentType,
    /// ISO 8601 date (`YYYY-MM-DD`).
    pub date: String,
    #[serde(alias = "emetteur")]
    pub issuer: Party,
    #[serde(alias = "client")]
    pub customer: Party,
    #[serde(alias = "lignes")]
    pub lines: Vec<LineItem>,
    #[serde(default, alias = "datePrestation", skip_serializing_if = "Option::is_none")]
    pub service_date: Option<String>,
    #[serde(default, alias = "echeance", skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    #[serde(default, alias = "conditionsPaiement", skip_serializing_if = "Option::is_none")]
    pub payment_terms: Option<String>,
    #[serde(default, alias = "penalitesRetard", skip_serializing_if = "Option::is_none")]
    pub late_penalties: Option<String>,
    #[serde(default, alias = "escompte", skip_serializing_if = "Option::is_none")]
    pub early_discount: Option<String>,
    #[serde(default, alias = "franchiseTva")]
    pub vat_exempt: bool,
    #[serde(default, alias = "origine", skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(default, alias = "validiteJours", skip_serializing_if = "Option::is_none")]
    pub validity_days: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, alias = "gabarit", skip_serializing_if = "Option::is_none")]
    pub template: Option<Template>,
    /// Preferred output locale (`"en"` or `"fr"`), defaulting to `"en"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
}

/// Canonical domain alias for `Invoice`.
pub type Document = Invoice;

/// VAT breakdown grouped by rate (`rate` in tenths of a percent).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VatBreakdown {
    pub rate: u16,
    pub base_excl_vat_cents: i64,
    pub vat_cents: i64,
}

/// Aggregated invoice totals in euro cents.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub total_excl_vat_cents: i64,
    pub total_vat_cents: i64,
    pub total_incl_vat_cents: i64,
    pub by_rate: Vec<VatBreakdown>,
}

/// Rounds identically to JavaScript `Math.round`.
#[inline]
pub fn round_js(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

impl Invoice {
    /// Deserializes a document from canonical camelCase JSON (accepting transition French aliases).
    pub fn from_json(json: &str) -> Result<Self, JsonError> {
        Ok(serde_json::from_str(json)?)
    }

    /// Computes total excl. VAT, grouped VAT per rate, and total incl. VAT in euro cents.
    pub fn totals(&self) -> Totals {
        let mut bases: BTreeMap<u16, i64> = BTreeMap::new();
        let mut total_excl = 0i64;
        for line in &self.lines {
            let net = line.net_excl_vat_cents();
            total_excl += net;
            let rate = if self.vat_exempt { 0 } else { line.vat };
            *bases.entry(rate).or_default() += net;
        }
        let mut by_rate = Vec::with_capacity(bases.len());
        let mut total_vat = 0i64;
        for (rate, base) in bases {
            let vat = if self.vat_exempt || rate == 0 { 0 } else { round_js(base as f64 * f64::from(rate) / 1000.0) };
            total_vat += vat;
            by_rate.push(VatBreakdown { rate, base_excl_vat_cents: base, vat_cents: vat });
        }
        Totals {
            total_excl_vat_cents: total_excl,
            total_vat_cents: total_vat,
            total_incl_vat_cents: total_excl + total_vat,
            by_rate,
        }
    }

    /// Resolves the document's preferred language (`"en"` or `"fr"`).
    pub fn resolved_locale(&self) -> &'static str {
        auto_i18n::resolve_lang(self.locale.as_deref())
    }
}

/// Formats euro cents into locale-aware EUR text (e.g. `"€1,234.50"` in EN, `"1 234,50 €"` in FR).
pub fn format_eur(cents: i64, lang: &str) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let abs = cents.unsigned_abs();
    let units = abs / 100;
    let rem = abs % 100;
    let is_fr = auto_i18n::resolve_lang(Some(lang)) == "fr";
    let sep = if is_fr { " " } else { "," };
    let grouped = format_thousands(units, sep);
    if is_fr { format!("{sign}{grouped},{rem:02} €") } else { format!("{sign}€{grouped}.{rem:02}") }
}

/// Formats a VAT rate stored in tenths of a percent (`200` -> `"20%"` / `"20 %"`, `55` -> `"5.5%"` / `"5,5 %"`).
pub fn format_percent(tenth_pct: u16, lang: &str) -> String {
    let whole = tenth_pct / 10;
    let frac = tenth_pct % 10;
    let is_fr = auto_i18n::resolve_lang(Some(lang)) == "fr";
    if frac == 0 {
        if is_fr { format!("{whole} %") } else { format!("{whole}%") }
    } else if is_fr {
        format!("{whole},{frac} %")
    } else {
        format!("{whole}.{frac}%")
    }
}

/// Formats basis points (`1000` -> `"10%"` / `"10 %"`, `1250` -> `"12.5%"`).
pub fn format_percent_bp(bp: u16, lang: &str) -> String {
    let whole = bp / 100;
    let rem = bp % 100;
    let is_fr = auto_i18n::resolve_lang(Some(lang)) == "fr";
    if rem == 0 {
        if is_fr { format!("{whole} %") } else { format!("{whole}%") }
    } else {
        let dec = format!("{rem:02}");
        let trimmed = dec.trim_end_matches('0');
        if is_fr { format!("{whole},{trimmed} %") } else { format!("{whole}.{trimmed}%") }
    }
}

/// Formats an ISO `YYYY-MM-DD` date according to `lang` (`"DD/MM/YYYY"` in FR, `"YYYY-MM-DD"` in EN).
pub fn format_date(iso: &str, lang: &str) -> String {
    let is_fr = auto_i18n::resolve_lang(Some(lang)) == "fr";
    if is_fr
        && let Some((y, md)) = iso.split_once('-')
        && let Some((m, d)) = md.split_once('-')
        && y.len() == 4
        && m.len() == 2
        && d.len() == 2
    {
        return format!("{d}/{m}/{y}");
    }
    iso.to_owned()
}

fn format_thousands(n: u64, sep: &str) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push_str(sep);
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_line_discount_and_grouped_vat_totals() {
        let doc = Document {
            number: "INV-2026-0001".into(),
            doc_type: DocumentType::Invoice,
            date: "2026-10-22".into(),
            issuer: Party {
                name: "Issuer SAS".into(),
                tax_id: Some("73282932000074".into()),
                address: "10 Main St".into(),
                delivery_address: None,
                vat_number: Some("FR44732829320".into()),
                email: None,
            },
            customer: Party {
                name: "Customer Ltd".into(),
                tax_id: None,
                address: "20 High St".into(),
                delivery_address: None,
                vat_number: None,
                email: None,
            },
            lines: vec![
                LineItem {
                    description: "Consulting".into(),
                    quantity: 2.0,
                    unit_price_excl_vat_cents: 10_000,
                    vat: 200,
                    unit: Some("day".into()),
                    discount_bp: Some(1_000),
                },
                LineItem {
                    description: "Book".into(),
                    quantity: 1.0,
                    unit_price_excl_vat_cents: 1_000,
                    vat: 55,
                    unit: None,
                    discount_bp: None,
                },
            ],
            service_date: None,
            due_date: None,
            payment_terms: None,
            late_penalties: None,
            early_discount: None,
            vat_exempt: false,
            origin: None,
            validity_days: None,
            notes: None,
            template: None,
            locale: None,
        };
        let totals = doc.totals();
        assert_eq!(totals.total_excl_vat_cents, 19_000);
        assert_eq!(totals.total_vat_cents, 3_655);
        assert_eq!(totals.total_incl_vat_cents, 22_655);
        assert_eq!(totals.by_rate.len(), 2);
    }

    #[test]
    fn deserializes_canonical_and_legacy_french_json() {
        let legacy = r#"{
            "numero": "F-2026-0001", "type": "facture", "date": "2026-10-22",
            "emetteur": { "nom": "A", "siret": "73282932000074", "adresse": "1 rue A" },
            "client": { "nom": "B", "adresse": "2 rue B" },
            "lignes": [{ "designation": "X", "quantite": 1.5, "prixUnitaireHtCents": 1000, "tva": 200 }]
        }"#;
        let doc = Document::from_json(legacy).unwrap();
        assert_eq!(doc.doc_type, DocumentType::Invoice);
        assert_eq!(doc.totals().total_incl_vat_cents, 1800);
    }

    #[test]
    fn formats_currency_percent_and_dates_by_locale() {
        assert_eq!(format_eur(123_450, "en"), "€1,234.50");
        assert_eq!(format_eur(-123_450, "fr"), "-1 234,50 €");
        assert_eq!(format_percent(55, "en"), "5.5%");
        assert_eq!(format_percent(200, "fr"), "20 %");
        assert_eq!(format_percent_bp(1250, "en"), "12.5%");
        assert_eq!(format_date("2026-10-22", "fr"), "22/10/2026");
        assert_eq!(format_date("2026-10-22", "en"), "2026-10-22");
    }
}
