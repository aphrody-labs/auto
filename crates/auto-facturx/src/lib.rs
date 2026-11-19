//! EN 16931 Factur-X CII XML generation, PDF/A-3b attachment, extraction, and validation.

pub mod cii;
pub mod pdf;

use auto_model::Document;
use thiserror::Error;

/// Factur-X generation and PDF/A-3b validation errors.
#[derive(Debug, Error)]
pub enum FacturxError {
    #[error("quotes cannot be converted to Factur-X invoices")]
    QuoteNotAllowed,
    #[error("invalid ISO date: {0}")]
    InvalidDate(String),
    #[error("missing PDF document catalog")]
    MissingCatalog,
    #[error("PDF error: {0}")]
    Pdf(#[from] craft_pdf::cos::CosError),
}

/// Generates EN 16931 CII XML from an `Invoice`, `Deposit`, or `CreditNote`.
pub fn xml(doc: &Document) -> Result<String, FacturxError> {
    cii::generate_cii_xml(doc)
}

/// Wraps a rendered PDF in PDF/A-3b and embeds EN 16931 `factur-x.xml`.
pub fn generate(doc: &Document, pdf_bytes: &[u8], unix_secs: i64) -> Result<Vec<u8>, FacturxError> {
    let cii_xml = cii::generate_cii_xml(doc)?;
    pdf::assemble_facturx_pdf(pdf_bytes, &cii_xml, &doc.number, unix_secs)
}

/// Extracts an embedded Factur-X XML document from a PDF, if present.
pub fn extract_xml(pdf_bytes: &[u8]) -> Result<Option<String>, FacturxError> {
    pdf::extract_xml_from_pdf(pdf_bytes)
}

/// Validates PDF/A-3b conformance essentials (empty list means compliant).
pub fn verify_pdfa(pdf_bytes: &[u8]) -> Result<Vec<String>, FacturxError> {
    pdf::verify_pdfa3b(pdf_bytes)
}
