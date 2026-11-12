use auto_sheets::{Classeur, ecrire, lire};

fn classeur() -> Classeur {
    serde_json::from_str(
        r#"{ "feuilles": [{
          "nom": "Ventes",
          "colonnes": [
            { "titre": "Date", "type": "date" }, { "titre": "Numéro" }, { "titre": "Client", "largeur": 30 },
            { "titre": "TTC", "type": "euros" }, { "titre": "Remise", "type": "pourcent" }, { "titre": "Qté", "type": "nombre" }
          ],
          "lignes": [
            ["2026-10-22", "F-2026-0001", "Dupont & Fils", 216000, 1250, 3],
            ["2026-10-23", "F-2026-0002", "Été « spécial »", 99, null, 1.5]
          ]
        }, { "nom": "Vide", "colonnes": [{ "titre": "A" }], "lignes": [] }] }"#,
    )
    .unwrap()
}

#[test]
fn aller_retour_xlsx() {
    let xlsx = ecrire(&classeur()).unwrap();
    assert_eq!(&xlsx[..2], b"PK");
    let l = lire(&xlsx).unwrap();
    assert_eq!(l.format, "xlsx");
    assert_eq!(l.feuilles.len(), 2);
    let v = &l.feuilles[0].lignes;
    assert_eq!(v[0][1], "Numéro");
    assert_eq!(v[1][1], "F-2026-0001");
    assert_eq!(v[1][2], "Dupont & Fils");
    assert_eq!(v[1][3].as_f64().unwrap(), 2160.0);
    assert_eq!(v[1][4].as_f64().unwrap(), 0.125);
    // 22/10/2026 = série Excel 46317.
    assert_eq!(v[1][0].as_f64().unwrap(), 46317.0);
    assert_eq!(v[2][2], "Été « spécial »");
    assert_eq!(v[2][3].as_f64().unwrap(), 0.99);
    assert!(v[2][4].is_null());
}

#[test]
fn lecture_csv_point_virgule() {
    let csv = "Nom;SIRET;Adresse\nDupont;73282932000074;1 rue A\n\"Martin, fils\";;2 rue B\n";
    let l = lire(csv.as_bytes()).unwrap();
    assert_eq!(l.format, "csv");
    let v = &l.feuilles[0].lignes;
    assert_eq!(v.len(), 3);
    assert_eq!(v[2][0], "Martin, fils");
    assert_eq!(v[0][2], "Adresse");
}

#[test]
fn erreurs() {
    assert!(lire(b"\x00\x01pas un tableur").is_err());
    let mut c = classeur();
    c.feuilles[0].lignes.push(vec![serde_json::json!("pas une date")]);
    assert!(ecrire(&c).is_err());
    assert!(ecrire(&Classeur { feuilles: vec![] }).is_err());
}
