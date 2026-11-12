use auto_modele::Facture;
use pdfcraft_cos::{Document, Object};
use pdfcraft_fonts::pdf::Metrics;
use std::sync::Arc;

fn json(type_: &str, numero: &str, n_lignes: usize, franchise: bool) -> Facture {
    let tva = if franchise { 0 } else { 200 };
    let lignes: Vec<String> = (0..n_lignes)
        .map(|i| {
            format!(
                r#"{{ "designation": "Prestation n° {i} — développement d'une fonctionnalité avec une désignation suffisamment longue pour passer à la ligne", "quantite": 1.5, "prixUnitaireHtCents": 12345, "tva": {} }}"#,
                if i % 3 == 0 { 55 } else { tva }
            )
        })
        .collect();
    Facture::depuis_json(&format!(
        r#"{{ "numero": "{numero}", "type": "{type_}", "date": "2026-10-22",
      "emetteur": {{ "nom": "Alpha & Fils", "siret": "73282932000074", "adresse": "1 rue de la Paix, 75002 Paris", "tvaIntracom": "FR44732829320", "email": "contact@alpha.fr" }},
      "client": {{ "nom": "Client SAS", "siret": "73282932000074", "adresse": "2 rue B, 69002 Lyon" }},
      "lignes": [{}], "datePrestation": "2026-10-15", "echeance": "2026-11-21",
      "conditionsPaiement": "Paiement à 30 jours par virement", "penalitesRetard": "3 fois le taux d'intérêt légal",
      "escompte": "aucun", "franchiseTva": {franchise}, "origine": "F-2026-0001", "validiteJours": 30 }}"#,
        lignes.join(",")
    ))
    .unwrap()
}

fn pages(pdf: &[u8]) -> usize {
    pdfcraft_model::pages(&Document::open(Arc::new(pdf.to_vec())).unwrap()).len()
}

/// Texte de la première page, décodé comme un lecteur : suit `Tf`, décode `<…> Tj` par ToUnicode.
fn texte_page1(pdf: &[u8]) -> String {
    let doc = Document::open(Arc::new(pdf.to_vec())).unwrap();
    let page = pdfcraft_model::pages(&doc).remove(0);
    let res = doc.dict(page.dict.get(b"Resources").unwrap()).unwrap();
    let fonts = doc.dict(res.get(b"Font").unwrap()).unwrap();
    let Object::Stream(s) = &*doc.resolve(page.dict.get(b"Contents").unwrap()) else { panic!("contenu") };
    let contenu = String::from_utf8(s.decoded().unwrap()).unwrap();
    let mut police = None;
    let mut out = String::new();
    let toks: Vec<&str> = contenu.split_whitespace().collect();
    for (i, t) in toks.iter().enumerate() {
        if *t == "Tf" {
            let nom = toks[i - 2].trim_start_matches('/');
            police = Some(Metrics::from_dict(&doc, &doc.dict(fonts.get(nom.as_bytes()).unwrap()).unwrap()));
        }
        if let Some(hex) = t.strip_prefix('<').and_then(|h| h.strip_suffix('>')) {
            let octets: Vec<u8> =
                (0..hex.len()).step_by(2).map(|j| u8::from_str_radix(&hex[j..j + 2], 16).unwrap()).collect();
            out.push_str(&police.as_ref().unwrap().decode(&octets));
            out.push('\n');
        }
    }
    out
}

#[test]
fn facture_une_page_texte_extractible() {
    let f = json("facture", "F-2026-0001", 3, false);
    let pdf = auto_docs::rendre(&f).unwrap();
    assert_eq!(pages(&pdf), 1);
    let t = texte_page1(&pdf);
    for attendu in [
        "Alpha & Fils",
        "Facture",
        "N° F-2026-0001",
        "Échéance : 21/11/2026",
        "SIRET : 73282932000074",
        "Client SAS",
        "Total TTC",
        "Pénalités de retard : 3 fois le taux d'intérêt légal",
        "Indemnité forfaitaire pour frais de recouvrement",
        "page 1/1",
    ] {
        assert!(t.contains(attendu), "« {attendu} » absent de :\n{t}");
    }
}

#[test]
fn pagination_longue_facture() {
    let pdf = auto_docs::rendre(&json("facture", "F-2026-0002", 60, false)).unwrap();
    assert!(pages(&pdf) >= 2, "{} pages", pages(&pdf));
}

#[test]
fn devis_brouillon_et_avoir() {
    assert_eq!(pages(&auto_docs::rendre(&json("devis", "", 2, false)).unwrap()), 1);
    assert_eq!(pages(&auto_docs::rendre(&json("avoir", "A-2026-0001", 2, true)).unwrap()), 1);
}

#[test]
fn rendu_converti_en_facturx_pdfa3b_conforme() {
    for (type_, n) in [("facture", 4), ("facture", 60), ("acompte", 1), ("avoir", 2)] {
        let f = json(type_, "F-2026-0003", n, false);
        let pdf = auto_docs::rendre(&f).unwrap();
        let fx = auto_facturx::generer(&f, &pdf, 1_792_000_000).unwrap();
        assert_eq!(auto_facturx::verifier_pdfa(&fx).unwrap(), Vec::<String>::new());
        assert!(auto_facturx::extraire(&fx).unwrap().is_some());
    }
}
