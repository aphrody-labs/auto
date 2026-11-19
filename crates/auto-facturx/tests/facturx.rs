use auto_facturx::{FacturxError, extract_xml, generate, verify_pdfa, xml};
use auto_model::{Document, DocumentType, LineItem, Party};

fn invoice(doc_type: DocumentType, vat_exempt: bool) -> Document {
    Document {
        number: "INV-2026-0100".into(),
        doc_type,
        date: "2026-10-22".into(),
        issuer: Party {
            name: "Atelier Factur-X SAS".into(),
            tax_id: Some("73282932000074".into()),
            address: "10 Rue de Rivoli\n75001 Paris".into(),
            delivery_address: None,
            vat_number: Some("FR44732829320".into()),
            email: Some("factures@atelier.example".into()),
        },
        customer: Party {
            name: "Buyer Corp".into(),
            tax_id: Some("12345678901234".into()),
            address: "25 Avenue Jean Jaurès\n69007 Lyon".into(),
            delivery_address: Some("Depot B\n69007 Lyon".into()),
            vat_number: None,
            email: None,
        },
        lines: vec![
            LineItem {
                description: "Engineering design".into(),
                quantity: 3.0,
                unit_price_excl_vat_cents: 50_000,
                vat: 200,
                unit: Some("day".into()),
                discount_bp: Some(1_000),
            },
            LineItem {
                description: "Travel allowance".into(),
                quantity: 1.0,
                unit_price_excl_vat_cents: 12_000,
                vat: 100,
                unit: None,
                discount_bp: None,
            },
        ],
        service_date: Some("2026-10-20".into()),
        due_date: Some("2026-11-21".into()),
        payment_terms: Some("Net 30 days".into()),
        late_penalties: None,
        early_discount: None,
        vat_exempt,
        origin: None,
        validity_days: None,
        notes: Some("Order PO-4412".into()),
        template: None,
        locale: Some("en".into()),
    }
}

#[test]
fn embeds_and_extracts_facturx_xml_and_passes_pdfa3b_checks() {
    let doc = invoice(DocumentType::Invoice, false);
    let base_pdf = auto_docs::render(&doc).unwrap();
    let fx_pdf = generate(&doc, &base_pdf, 1_792_000_000).unwrap();

    let violations = verify_pdfa(&fx_pdf).unwrap();
    assert!(violations.is_empty(), "PDF/A-3b violations: {violations:?}");

    let extracted = extract_xml(&fx_pdf).unwrap().expect("factur-x.xml missing");
    assert!(extracted.contains("<ram:ID>INV-2026-0100</ram:ID>"));
    assert!(extracted.contains("<ram:TypeCode>380</ram:TypeCode>"));
    assert!(extracted.contains("<ram:GrandTotalAmount>"));
    assert!(extract_xml(&base_pdf).unwrap().is_none());
}

#[test]
fn rejects_quotes_and_supports_credit_notes_and_exemptions() {
    assert!(matches!(xml(&invoice(DocumentType::Quote, false)), Err(FacturxError::QuoteNotAllowed)));
    let cn_xml = xml(&invoice(DocumentType::CreditNote, true)).unwrap();
    assert!(cn_xml.contains("<ram:TypeCode>381</ram:TypeCode>"));
    assert!(cn_xml.contains("<ram:CategoryCode>E</ram:CategoryCode>"));
}
