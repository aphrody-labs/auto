//! Écrit un classeur d'exemple dans le fichier donné.
fn main() {
    let out = std::env::args().nth(1).expect("usage: exemple <fichier.xlsx>");
    let c: auto_sheets::Classeur = serde_json::from_str(
        r#"{ "feuilles": [{ "nom": "Ventes",
      "colonnes": [{ "titre": "Date", "type": "date" }, { "titre": "Numéro" }, { "titre": "TTC", "type": "euros" }, { "titre": "Remise", "type": "pourcent" }],
      "lignes": [["2026-10-22", "F-2026-0001", 216000, 1250]] }] }"#,
    )
    .unwrap();
    std::fs::write(out, auto_sheets::ecrire(&c).unwrap()).unwrap();
}
