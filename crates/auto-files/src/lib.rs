#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

pub mod docx_ops;
pub mod pdf_ops;
pub mod presentation;
pub mod redaction;
pub mod signing;

pub use docx_ops::{
    ParagraphInput, SimpleDocx, TextReplacement, create_docx, docx_text, docx_to_pdf, fill_template_docx, read_docx,
    replace_docx, template_fields_docx,
};
pub use pdf_ops::{extract_pdf_pages, merge_pdfs, pdf_page_count, pdf_text};
pub use presentation::{BulletInput, NewPresentation, NewSlide, create_pptx, pptx_text, pptx_to_pdf};
pub use redaction::{QueryCount, RedactionOptions, RedactionPattern, RedactionReport, redact_pdf};
pub use signing::{SignatureOptions, VerifiedSignature, sign_pdf, verify_signatures};

#[derive(Debug, thiserror::Error)]
pub enum FileError {
    #[error("invalid PDF: {0}")]
    InvalidPdf(String),
    #[error("PDF error: {0}")]
    Cos(#[from] craft_pdf::cos::CosError),
    #[error("PKCS#7 / certificate error: {0}")]
    Pkcs7(#[from] craft_pkcs7::Error),
    #[error("DOCX error: {0}")]
    Docx(#[from] craft_docx::DocxError),
    #[error("Word model error: {0}")]
    WordModel(#[from] craft_wordmodel::DocError),
    #[error("PPTX error: {0}")]
    Pptx(#[from] craft_pptx::Error),
    #[error("PDF rendering error: {0}")]
    Render(#[from] auto_docs::RenderError),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("page {page} out of range (1..={total})")]
    PageOutOfRange { page: usize, total: usize },
}
