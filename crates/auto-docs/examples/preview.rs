use auto_docs::render;
use auto_model::{Document, DocumentType, LineItem, Party};

fn main() {
    let doc = Document {
        number: "INV-2026-0001".into(),
        doc_type: DocumentType::Invoice,
        date: "2026-10-22".into(),
        issuer: Party {
            name: "Sample Studio".into(),
            tax_id: Some("73282932000074".into()),
            address: "10 Rue Exemple, 75001 Paris".into(),
            delivery_address: None,
            vat_number: Some("FR44732829320".into()),
            email: None,
        },
        customer: Party {
            name: "Customer Inc".into(),
            tax_id: None,
            address: "20 Rue Client, 69001 Lyon".into(),
            delivery_address: None,
            vat_number: None,
            email: None,
        },
        lines: vec![LineItem {
            description: "Engineering milestone".into(),
            quantity: 1.0,
            unit_price_excl_vat_cents: 150_000,
            vat: 200,
            unit: Some("unit".into()),
            discount_bp: None,
        }],
        service_date: None,
        due_date: Some("2026-11-21".into()),
        payment_terms: Some("Net 30".into()),
        late_penalties: None,
        early_discount: None,
        vat_exempt: false,
        origin: None,
        validity_days: None,
        notes: None,
        template: None,
        locale: Some("en".into()),
    };
    let pdf = render(&doc).expect("render sample PDF");
    println!("rendered {} bytes", pdf.len());
}
