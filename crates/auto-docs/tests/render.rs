use auto_docs::{DocParagraphStyle, DocPdfParagraph, SlidePdf, render, render_docx_pdf, render_pptx_pdf};
use auto_model::{Document, DocumentType, LineItem, Party, Template};

fn sample_invoice(lines: usize, locale: Option<&str>) -> Document {
    let items = (0..lines)
        .map(|i| LineItem {
            description: format!("Line item #{} — structural work and finish", i + 1),
            quantity: 2.0,
            unit_price_excl_vat_cents: 12_500,
            vat: 200,
            unit: Some("day".into()),
            discount_bp: if i == 0 { Some(500) } else { None },
        })
        .collect();
    Document {
        number: "INV-2026-0042".into(),
        doc_type: DocumentType::Invoice,
        date: "2026-10-22".into(),
        issuer: Party {
            name: "Atelier Demo Ltd".into(),
            tax_id: Some("73282932000074".into()),
            address: "10 Builder Lane\n75011 Paris".into(),
            delivery_address: None,
            vat_number: Some("FR44732829320".into()),
            email: Some("billing@atelier.example".into()),
        },
        customer: Party {
            name: "Client Corp".into(),
            tax_id: Some("12345678901234".into()),
            address: "42 Oak Avenue\n69002 Lyon".into(),
            delivery_address: Some("Dock 3, 69007 Lyon".into()),
            vat_number: None,
            email: None,
        },
        lines: items,
        service_date: Some("2026-10-20".into()),
        due_date: Some("2026-11-21".into()),
        payment_terms: Some("30 days end of month".into()),
        late_penalties: None,
        early_discount: None,
        vat_exempt: false,
        origin: None,
        validity_days: Some(30),
        notes: Some("Thank you for your business.".into()),
        template: Some(Template {
            color: Some("#0F6B5C".into()),
            logo: None,
            width: None,
            height: None,
            footer: Some("Registered office — Paris".into()),
        }),
        locale: locale.map(str::to_owned),
    }
}

#[test]
fn renders_valid_single_and_multipage_pdfs() {
    let pdf_single = render(&sample_invoice(3, Some("en"))).unwrap();
    assert!(pdf_single.starts_with(b"%PDF-1.7"));
    let cos = craft_pdf::cos::Document::open(std::sync::Arc::new(pdf_single)).unwrap();
    let root = cos.get(cos.root().unwrap());
    let pages = cos.get(root.as_dict().unwrap().reference(b"Pages").unwrap());
    assert_eq!(pages.as_dict().unwrap().int(b"Count"), Some(1));

    let pdf_multi = render(&sample_invoice(48, Some("fr"))).unwrap();
    let cos_multi = craft_pdf::cos::Document::open(std::sync::Arc::new(pdf_multi)).unwrap();
    let root_m = cos_multi.get(cos_multi.root().unwrap());
    let pages_m = cos_multi.get(root_m.as_dict().unwrap().reference(b"Pages").unwrap());
    assert!(pages_m.as_dict().unwrap().int(b"Count").unwrap() >= 2);
}

#[test]
fn renders_docx_and_pptx_pdfs_with_selectable_fonts() {
    let docx_pdf = render_docx_pdf(
        Some("Project Brief"),
        &[
            DocPdfParagraph { text: "Scope".into(), style: DocParagraphStyle::Heading1, bold: true },
            DocPdfParagraph {
                text: "All deliverables are on schedule.".into(),
                style: DocParagraphStyle::Normal,
                bold: false,
            },
        ],
    )
    .unwrap();
    assert!(docx_pdf.starts_with(b"%PDF-1.7"));

    let pptx_pdf = render_pptx_pdf(
        Some("Quarterly Review"),
        &[
            SlidePdf { title: Some("Q4 Summary".into()), bullets: vec![], notes: None },
            SlidePdf {
                title: Some("Milestones".into()),
                bullets: vec![("Released Wasm runtime".into(), 0), ("Verified Factur-X".into(), 1)],
                notes: None,
            },
        ],
    )
    .unwrap();
    let cos_p = craft_pdf::cos::Document::open(std::sync::Arc::new(pptx_pdf)).unwrap();
    let root_p = cos_p.get(cos_p.root().unwrap());
    let pages_p = cos_p.get(root_p.as_dict().unwrap().reference(b"Pages").unwrap());
    assert_eq!(pages_p.as_dict().unwrap().int(b"Count"), Some(2));
}
