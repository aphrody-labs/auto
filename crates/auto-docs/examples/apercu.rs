//! Écrit un devis et une facture Factur-X d'exemple dans le répertoire donné.

use auto_modele::Facture;

fn main() {
    let dir = std::env::args().nth(1).expect("usage: apercu <répertoire>");
    std::fs::create_dir_all(&dir).unwrap();
    let lignes = r#"[
      { "designation": "Développement de l'application de facturation (sprint 1)", "quantite": 5, "prixUnitaireHtCents": 65000, "tva": 200, "unite": "jour" },
      { "designation": "Formation des utilisateurs", "quantite": 1, "prixUnitaireHtCents": 90000, "tva": 200 },
      { "designation": "Manuel utilisateur imprimé", "quantite": 10, "prixUnitaireHtCents": 1990, "tva": 55 },
      { "designation": "Hébergement — premier mois", "quantite": 1, "prixUnitaireHtCents": 4900, "tva": 200 }
    ]"#;
    for (nom, type_, numero) in [("devis", "devis", "D-2026-0007"), ("facture", "facture", "F-2026-0042")] {
        let f = Facture::depuis_json(&format!(
            r#"{{ "numero": "{numero}", "type": "{type_}", "date": "2026-10-22",
          "emetteur": {{ "nom": "Alpha & Fils SARL", "siret": "73282932000074", "adresse": "1 rue de la Paix, 75002 Paris", "tvaIntracom": "FR44732829320", "email": "contact@alpha-fils.fr" }},
          "client": {{ "nom": "Client SAS", "siret": "73282932000074", "adresse": "2 rue de la République, 69002 Lyon", "tvaIntracom": "FR44732829320" }},
          "lignes": {lignes}, "datePrestation": "2026-10-15", "echeance": "2026-11-21",
          "conditionsPaiement": "Paiement à 30 jours par virement (IBAN FR76 3000 6000 0112 3456 7890 189)",
          "penalitesRetard": "3 fois le taux d'intérêt légal", "escompte": "Pas d'escompte pour paiement anticipé",
          "validiteJours": 30 }}"#
        ))
        .unwrap();
        let pdf = auto_docs::rendre(&f).unwrap();
        let out = if type_ == "facture" { auto_facturx::generer(&f, &pdf, 1_792_000_000).unwrap() } else { pdf };
        std::fs::write(format!("{dir}/{nom}.pdf"), out).unwrap();
        println!("{dir}/{nom}.pdf");
    }
}
