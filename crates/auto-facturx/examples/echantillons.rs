//! Écrit des XML CII représentatifs (facture, acompte, avoir, franchise, taux multiples)
//! dans le répertoire donné, pour la validation XSD + Schematron EN 16931.

use auto_facturx::{Facture, xml};

fn json(numero: &str, type_: &str, franchise: bool, lignes: &str) -> String {
    let tva_intracom = if franchise { "null" } else { "\"FR44732829320\"" };
    format!(
        r#"{{ "numero": "{numero}", "type": "{type_}", "date": "2026-10-22",
      "emetteur": {{ "nom": "Alpha & Fils", "siret": "73282932000074", "adresse": "1 rue de la Paix, 75002 Paris", "tvaIntracom": {tva_intracom} }},
      "client": {{ "nom": "Client SAS", "siret": "73282932000074", "adresse": "2 rue B, 69002 Lyon", "tvaIntracom": "FR44732829320", "email": "compta@client.fr" }},
      "lignes": {lignes},
      "datePrestation": "2026-10-15", "echeance": "2026-11-21", "conditionsPaiement": "Paiement à 30 jours",
      "penalitesRetard": "3 fois le taux d'intérêt légal", "escompte": "aucun",
      "franchiseTva": {franchise}, "origine": "F-2026-0001" }}"#
    )
}

fn main() {
    let dir = std::env::args().nth(1).expect("usage: echantillons <répertoire>");
    std::fs::create_dir_all(&dir).unwrap();
    let simple = r#"[{ "designation": "Développement", "quantite": 3, "prixUnitaireHtCents": 60000, "tva": 200 }]"#;
    let multi = r#"[
      { "designation": "Développement", "quantite": 3, "prixUnitaireHtCents": 60000, "tva": 200 },
      { "designation": "Livre", "quantite": 2, "prixUnitaireHtCents": 1999, "tva": 55 },
      { "designation": "Restauration", "quantite": 1.5, "prixUnitaireHtCents": 33333, "tva": 100 },
      { "designation": "Export", "quantite": 1, "prixUnitaireHtCents": 10000, "tva": 0 }
    ]"#;
    let remises = r#"[
      { "designation": "Licence", "quantite": 3, "prixUnitaireHtCents": 33333, "tva": 200, "remiseBp": 1250 },
      { "designation": "Support", "quantite": 1.5, "prixUnitaireHtCents": 19999, "tva": 200, "remiseBp": 1000 },
      { "designation": "Ouvrage", "quantite": 7, "prixUnitaireHtCents": 1999, "tva": 55, "remiseBp": 333 }
    ]"#;
    let franchise = r#"[{ "designation": "Conseil", "quantite": 2, "prixUnitaireHtCents": 45000, "tva": 0 }]"#;
    let cas = [
        ("facture", json("F-2026-0001", "facture", false, simple)),
        ("facture-multi-taux", json("F-2026-0002", "facture", false, multi)),
        ("facture-remises", json("F-2026-0005", "facture", false, remises)),
        ("acompte", json("F-2026-0003", "acompte", false, simple)),
        ("avoir", json("A-2026-0001", "avoir", false, simple)),
        ("franchise", json("F-2026-0004", "facture", true, franchise)),
    ];
    for (nom, j) in cas {
        let f = Facture::depuis_json(&j).unwrap();
        std::fs::write(format!("{dir}/{nom}.xml"), xml(&f).unwrap()).unwrap();
        println!("{dir}/{nom}.xml");
    }
}
