use std::path::PathBuf;

use auto_facturx::{generate, verify_pdfa, xml};
use auto_model::{Document, DocumentType, LineItem, Party};

fn main() {
    let doc = Document {
        number: "INV-2026-0001".into(),
        doc_type: DocumentType::Invoice,
        date: "2026-10-22".into(),
        issuer: Party {
            name: "Sample Co".into(),
            tax_id: Some("73282932000074".into()),
            address: "10 Main St\n75001 Paris".into(),
            delivery_address: None,
            vat_number: Some("FR44732829320".into()),
            email: None,
        },
        customer: Party {
            name: "Buyer Co".into(),
            tax_id: None,
            address: "20 Side St\n69001 Lyon".into(),
            delivery_address: None,
            vat_number: None,
            email: None,
        },
        lines: vec![LineItem {
            description: "Workshop".into(),
            quantity: 1.0,
            unit_price_excl_vat_cents: 100_000,
            vat: 200,
            unit: Some("day".into()),
            discount_bp: None,
        }],
        service_date: Some("2026-10-20".into()),
        due_date: Some("2026-11-21".into()),
        payment_terms: Some("30 days".into()),
        late_penalties: Some("3 times the statutory interest rate".into()),
        early_discount: Some("None".into()),
        vat_exempt: false,
        origin: None,
        validity_days: None,
        notes: None,
        template: None,
        locale: Some("en".into()),
    };

    let cii = xml(&doc).expect("generate CII");
    let pdf = auto_docs::render(&doc).expect("render PDF");
    let fx = generate(&doc, &pdf, 1_792_000_000).expect("assemble Factur-X");
    let checks = verify_pdfa(&fx).expect("verify PDF/A-3b");
    if let Some(dir) = std::env::args().nth(1) {
        let out_dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&out_dir);
        std::fs::write(out_dir.join("invoice.xml"), cii.as_bytes()).expect("write invoice.xml");
    }
    println!("CII={} bytes, Factur-X={} bytes, violations={:?}", cii.len(), fx.len(), checks);
}
