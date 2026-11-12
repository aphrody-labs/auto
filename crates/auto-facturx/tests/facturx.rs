use auto_facturx::{Facture, extraire, generer, verifier_pdfa, xml};
use pdfcraft_cos::{Document, Object, SaveOptions, write_full};
use std::sync::Arc;

const DATE: i64 = 1_792_000_000;

fn facture(type_: &str, franchise: bool) -> Facture {
    let tva = if franchise { 0 } else { 200 };
    let tva_intracom = if franchise { "null" } else { "\"FR44732829320\"" };
    Facture::depuis_json(&format!(
        r#"{{
      "numero": "F-2026-0001", "type": "{type_}", "date": "2026-10-22",
      "emetteur": {{ "nom": "Alpha & Fils", "siret": "73282932000074", "adresse": "1 rue de la Paix, 75002 Paris", "tvaIntracom": {tva_intracom} }},
      "client": {{ "nom": "Client <SAS>", "siret": "73282932000074", "adresse": "2 rue B, Lyon", "email": "compta@client.fr" }},
      "lignes": [
        {{ "designation": "Développement", "quantite": 3, "prixUnitaireHtCents": 60000, "tva": {tva} }},
        {{ "designation": "Formation", "quantite": 1.5, "prixUnitaireHtCents": 33333, "tva": {tva} }}
      ],
      "datePrestation": "2026-10-15", "echeance": "2026-11-21",
      "conditionsPaiement": "Paiement à 30 jours", "penalitesRetard": "3 fois le taux d'intérêt légal",
      "escompte": "aucun", "franchiseTva": {franchise}, "origine": "F-2026-0000"
    }}"#
    ))
    .unwrap()
}

fn pdf_vierge() -> Vec<u8> {
    let doc = pdfcraft_create::blank(595.0, 842.0, 1).unwrap();
    write_full(&doc, &SaveOptions::default()).unwrap()
}

#[test]
fn totaux_identiques_au_domaine_ts() {
    let t = facture("facture", false).totaux();
    // 3 × 600,00 + 1,5 × 333,33 (499,995 → 500,00 arrondi JS) = 2300,00 HT
    assert_eq!(t.ht_cents, 230_000);
    assert_eq!(t.tva_cents, 46_000);
    assert_eq!(t.ttc_cents, 276_000);
}

#[test]
fn xml_en16931() {
    let x = xml(&facture("facture", false)).unwrap();
    assert!(x.contains("<ram:ID>urn:cen.eu:en16931:2017</ram:ID>"));
    assert!(x.contains("<ram:TypeCode>380</ram:TypeCode>"));
    assert!(x.contains("<ram:ID schemeID=\"0002\">732829320</ram:ID>"));
    assert!(x.contains("<ram:ID schemeID=\"VA\">FR44732829320</ram:ID>"));
    assert!(x.contains("Alpha &amp; Fils"));
    assert!(x.contains("Client &lt;SAS&gt;"));
    assert!(x.contains("<ram:GrandTotalAmount>2760.00</ram:GrandTotalAmount>"));
    assert!(x.contains("<ram:DueDateDateTime><udt:DateTimeString format=\"102\">20261121</udt:DateTimeString>"));
    assert!(x.contains("<ram:SubjectCode>PMT</ram:SubjectCode>"));
    // La référence d'origine n'est émise que pour un avoir.
    assert!(!x.contains("InvoiceReferencedDocument"));
    let a = xml(&facture("avoir", false)).unwrap();
    assert!(a.contains("<ram:TypeCode>381</ram:TypeCode>"));
    assert!(a.contains("<ram:IssuerAssignedID>F-2026-0000</ram:IssuerAssignedID>"));
}

#[test]
fn xml_franchise() {
    let x = xml(&facture("facture", true)).unwrap();
    assert!(x.contains("<ram:CategoryCode>E</ram:CategoryCode>"));
    assert!(x.contains("<ram:ExemptionReason>TVA non applicable, art. 293 B du CGI</ram:ExemptionReason>"));
    assert!(x.contains("<ram:ID schemeID=\"FC\">73282932000074</ram:ID>"));
    assert!(x.contains("<ram:TaxTotalAmount currencyID=\"EUR\">0.00</ram:TaxTotalAmount>"));
}

#[test]
fn facturx_pdfa3b_conforme_et_extractible() {
    let f = facture("facture", false);
    let out = generer(&f, &pdf_vierge(), DATE).unwrap();
    assert_eq!(verifier_pdfa(&out).unwrap(), Vec::<String>::new());
    assert_eq!(extraire(&out).unwrap().unwrap(), xml(&f).unwrap());
    // Structure : /AF du catalogue → Filespec factur-x.xml en relation Alternative ; XMP Factur-X.
    let doc = Document::open(Arc::new(out)).unwrap();
    let cat = doc.dict(&Object::Ref(doc.root().unwrap())).unwrap();
    let af = doc.resolve(cat.get(b"AF").unwrap()).as_array().unwrap().clone();
    let fs = doc.dict(&af[0]).unwrap();
    assert_eq!(fs.name(b"AFRelationship"), Some(&b"Alternative"[..]));
    let Object::Stream(md) = &*doc.resolve(cat.get(b"Metadata").unwrap()) else { panic!("XMP absent") };
    let xmp = String::from_utf8(md.decoded().unwrap()).unwrap();
    assert!(xmp.contains("<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>"));
    assert!(xmp.contains("<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>"));
    assert!(xmp.contains("pdfaid:part"));
}

#[test]
fn pdf_sans_xml() {
    assert_eq!(extraire(&pdf_vierge()).unwrap(), None);
}
