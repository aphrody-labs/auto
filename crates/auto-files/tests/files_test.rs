use std::collections::BTreeMap;

use auto_files::{
    BulletInput, NewPresentation, NewSlide, ParagraphInput, RedactionOptions, RedactionPattern, SignatureOptions,
    SimpleDocx, TextReplacement, create_docx, create_pptx, docx_text, docx_to_pdf, extract_pdf_pages,
    fill_template_docx, merge_pdfs, pdf_page_count, pdf_text, pptx_text, pptx_to_pdf, read_docx, redact_pdf,
    replace_docx, sign_pdf, template_fields_docx, verify_signatures,
};

#[test]
fn docx_roundtrip_templates_and_pdf() {
    let bytes = create_docx(&SimpleDocx {
        title: Some("Quote {{ number }}".into()),
        paragraphs: vec![
            ParagraphInput { text: "For {{ customer }}, {{ customer }}".into(), style: None, bold: Some(true) },
            ParagraphInput { text: "Keep {{ other }}".into(), style: Some("heading2".into()), bold: None },
        ],
    })
    .expect("create docx");

    assert_eq!(template_fields_docx(&bytes).expect("fields"), vec!["number", "customer", "other"]);

    let mut values = BTreeMap::new();
    values.insert("number".into(), "QUO-7".into());
    values.insert("customer".into(), "Zoe".into());
    let filled = fill_template_docx(&bytes, &values).expect("fill template");
    let body_text = docx_text(&filled).expect("docx text");
    assert_eq!(body_text, "Quote QUO-7\nFor Zoe, Zoe\nKeep {{ other }}");
    assert_eq!(read_docx(&filled).expect("read docx").len(), 3);

    let replaced =
        replace_docx(&filled, &[TextReplacement { find: "Zoe".into(), replace: "Francois".into() }]).expect("replace");
    assert!(docx_text(&replaced).expect("replaced text").contains("For Francois, Francois"));

    let pdf = docx_to_pdf(&filled).expect("docx to pdf");
    assert!(pdf.starts_with(b"%PDF-"));
    assert_eq!(pdf_page_count(&pdf).expect("page count"), 1);
    let pages = pdf_text(&pdf).expect("pdf text");
    assert!(pages[0].contains("Quote QUO-7"));
    assert!(pages[0].contains("For Zoe, Zoe"));
}

#[test]
fn pdf_merge_extract_and_redaction() {
    let p1 =
        docx_to_pdf(&create_docx(&SimpleDocx { title: Some("First Page".into()), paragraphs: vec![] }).expect("d1"))
            .expect("p1");
    let p2 = docx_to_pdf(
        &create_docx(&SimpleDocx {
            title: Some("Statement".into()),
            paragraphs: vec![ParagraphInput {
                text: "Email zoe@example.org IBAN FR76 3000 6000 0112 3456 7890 189".into(),
                style: None,
                bold: None,
            }],
        })
        .expect("d2"),
    )
    .expect("p2");

    let merged = merge_pdfs(&[("one.pdf", &p1), ("two.pdf", &p2)]).expect("merge");
    assert_eq!(pdf_page_count(&merged).expect("merged count"), 2);

    let extracted = extract_pdf_pages(&merged, &[1]).expect("extract page 2");
    assert_eq!(pdf_page_count(&extracted).expect("extracted count"), 1);
    let ex_text = pdf_text(&extracted).expect("ex text");
    assert!(ex_text[0].contains("Statement"));

    let (redacted, report) = redact_pdf(
        &extracted,
        &RedactionOptions { patterns: vec![RedactionPattern::Email, RedactionPattern::Iban], ..Default::default() },
    )
    .expect("redact");
    assert_eq!(report.occurrences, 2);
    assert_eq!(report.pages, vec![1]);
    let after = pdf_text(&redacted).expect("redacted text").join("\n");
    assert!(!after.contains("zoe@example.org"), "email leaked: {after}");
    assert!(!after.contains("FR76 3000"), "iban leaked: {after}");
}

#[test]
fn pdf_signing_ec_and_rsa_with_tamper_detection() {
    let doc = create_docx(&SimpleDocx {
        title: Some("Contract".into()),
        paragraphs: vec![ParagraphInput { text: "Approved amount: 2160.00 EUR".into(), style: None, bold: None }],
    })
    .expect("docx");
    let pdf = docx_to_pdf(&doc).expect("pdf");

    let rsa_p12 = include_bytes!("data/rsa-aes.p12");
    let rsa_pem = include_str!("data/rsa.crt.pem");
    let signed_rsa = sign_pdf(
        &pdf,
        rsa_p12,
        &SignatureOptions {
            password: "test".into(),
            date: Some("D:20261023120000Z".into()),
            reason: Some("Approved".into()),
            location: Some("Paris".into()),
            certify: Some(2),
            ..Default::default()
        },
    )
    .expect("sign rsa");

    let verified = verify_signatures(&signed_rsa, rsa_pem).expect("verify trusted");
    assert_eq!(verified.len(), 1);
    assert_eq!(verified[0].status, "valid");
    assert_eq!(verified[0].modifications, "none");
    assert_eq!(verified[0].certification, Some(2));

    let untrusted = verify_signatures(&signed_rsa, "").expect("verify untrusted");
    assert_eq!(untrusted[0].status, "unknown");

    // Multi-signature incremental signing with EC-P256 on top of RSA signature.
    let ec_p12 = include_bytes!("data/ec-p256.p12");
    let double_signed = sign_pdf(
        &signed_rsa,
        ec_p12,
        &SignatureOptions { password: "test".into(), reason: Some("Countersigned".into()), ..Default::default() },
    )
    .expect("countersign ec");
    let both = verify_signatures(&double_signed, rsa_pem).expect("verify both");
    assert_eq!(both.len(), 2);
    assert_eq!(both[0].status, "valid");
    assert_eq!(both[0].modifications, "forbidden"); // post-sig revision appended
    assert_eq!(both[1].status, "unknown"); // self-signed EC not in rsa.crt.pem

    // Tampering with signed content invalidates signature.
    let mut tampered = signed_rsa;
    if let Some(pos) = tampered.windows(8).position(|w| w == b"Approved") {
        tampered[pos] = b'X';
    }
    let broken = verify_signatures(&tampered, rsa_pem).expect("verify tampered");
    assert_eq!(broken[0].status, "invalid");
}

#[test]
fn pptx_roundtrip_and_pdf() {
    let pptx = create_pptx(&NewPresentation {
        title: Some("Summary".into()),
        subtitle: Some("Workshop".into()),
        slides: vec![NewSlide {
            title: Some("Metrics".into()),
            bullets: vec![
                BulletInput::Text("Revenue up".into()),
                BulletInput::Detailed { text: "Services".into(), level: Some(1) },
            ],
            notes: Some("Speaker memo".into()),
        }],
    })
    .expect("create pptx");

    let slides = pptx_text(&pptx).expect("pptx text");
    assert_eq!(slides.len(), 2);
    assert!(slides[0].contains("Summary"));
    assert!(slides[1].contains("Metrics"));
    assert!(slides[1].contains("Revenue up"));

    let pdf = pptx_to_pdf(&pptx).expect("pptx to pdf");
    let pages = pdf_text(&pdf).expect("pdf text");
    assert_eq!(pages.len(), 2);
}
