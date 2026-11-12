//! C ABI pour `bun:ffi`. Un seul point d'entrée :
//!
//! `auto_call(op, op_len, entree, entree_len, sortie_len) -> *mut u8`
//!
//! Le tampon renvoyé commence par un octet d'état (0 = succès, 1 = erreur), suivi de la charge
//! utile : octets du PDF, texte XML ou JSON, ou message d'erreur UTF-8. L'appelant le libère avec
//! `auto_free(ptr, len)`, `len` étant la valeur écrite dans `sortie_len`.
//!
//! Opérations : `rendre` (JSON → PDF), `facturx` (JSON + date unix en tête → Factur-X),
//! `xml` (JSON → XML CII), `extraire` (PDF → XML, vide si absent), `verifier_pdfa` (PDF → JSON),
//! `tableur_lire` (xlsx/xls/xlsb/ods/csv → JSON), `xlsx_ecrire` (JSON → xlsx).
//!
//! Fichiers (auto-fichiers) ; une entrée « en trames » est une suite de `u32` little-endian
//! (longueur) suivis d'autant d'octets :
//! `pdf_fusionner` (trames nom, PDF, nom, PDF… → PDF), `pdf_pages` (trames JSON `[pages]`, PDF → PDF),
//! `pdf_nombre_pages` (PDF → nombre), `pdf_texte` (PDF → JSON `{ pages: [texte] }`), `docx_creer` (JSON → DOCX),
//! `docx_champs` (DOCX → JSON `[noms]`), `docx_remplir` (trames JSON `{ nom: valeur }`, DOCX → DOCX),
//! `docx_texte` (DOCX → texte), `docx_pdf` (DOCX → PDF),
//! `pdf_caviarder` (trames JSON options, PDF → trames JSON rapport, PDF), `pdf_signer` (trames JSON
//! options, PKCS #12, PDF → PDF), `pdf_signatures` (trames certificats de confiance PEM, PDF → JSON),
//! `pptx_creer` (JSON → PPTX), `pptx_pdf` (PPTX → PDF).
//!
//! Base de connaissances (auto-connaissance) : `rag_decouper` (JSON `{ source, texte, taille? }` → JSON
//! `[{ position, texte, titre, ligne_debut, ligne_fin }]`), `rag_topk` (trames JSON `{ dimension, k, diversite? }`,
//! question puis matrice en `f32` little-endian → JSON `[{ indice, score }]`, score cosinus décroissant).

use auto_modele::Facture;
use std::collections::BTreeMap;

/// Découpe une entrée en trames (`u32` LE de longueur puis les octets).
fn trames(mut entree: &[u8]) -> Result<Vec<&[u8]>, String> {
    let mut v = Vec::new();
    while !entree.is_empty() {
        let (n, reste) = entree.split_at_checked(4).ok_or("trame tronquée")?;
        let n = u32::from_le_bytes(n.try_into().map_err(|_| "trame invalide")?) as usize;
        let (t, reste) = reste.split_at_checked(n).ok_or("trame tronquée")?;
        v.push(t);
        entree = reste;
    }
    Ok(v)
}

/// Inverse de [`trames`].
fn en_trames(parties: &[&[u8]]) -> Vec<u8> {
    let mut v = Vec::with_capacity(parties.iter().map(|p| p.len() + 4).sum());
    for p in parties {
        v.extend_from_slice(&(p.len() as u32).to_le_bytes());
        v.extend_from_slice(p);
    }
    v
}

fn json<T: serde::de::DeserializeOwned>(o: &[u8]) -> Result<T, String> {
    serde_json::from_slice(o).map_err(|e| e.to_string())
}

fn docx(o: &[u8]) -> Result<auto_fichiers::Docx, String> {
    auto_fichiers::lire_docx(o).map_err(|e| e.to_string())
}

/// Nombres `f32` little-endian.
fn f32s(o: &[u8]) -> Result<Vec<f32>, String> {
    let (blocs, reste) = o.as_chunks::<4>();
    if !reste.is_empty() {
        return Err("vecteur f32 : longueur non multiple de 4".into());
    }
    Ok(blocs.iter().map(|b| f32::from_le_bytes(*b)).collect())
}

fn facture(entree: &[u8]) -> Result<Facture, String> {
    Facture::depuis_json(std::str::from_utf8(entree).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Exécute une opération ; utilisable aussi depuis Rust.
pub fn appeler(op: &str, entree: &[u8]) -> Result<Vec<u8>, String> {
    match op {
        "rendre" => auto_docs::rendre(&facture(entree)?).map_err(|e| e.to_string()),
        "facturx" => {
            // 8 octets de date unix (little-endian) puis le JSON.
            let (date, json) = entree.split_at_checked(8).ok_or("entrée trop courte")?;
            let date = i64::from_le_bytes(date.try_into().map_err(|_| "date invalide")?);
            let f = facture(json)?;
            let pdf = auto_docs::rendre(&f).map_err(|e| e.to_string())?;
            auto_facturx::generer(&f, &pdf, date).map_err(|e| e.to_string())
        }
        "xml" => auto_facturx::xml(&facture(entree)?).map(String::into_bytes).map_err(|e| e.to_string()),
        "extraire" => {
            auto_facturx::extraire(entree).map(|x| x.unwrap_or_default().into_bytes()).map_err(|e| e.to_string())
        }
        "verifier_pdfa" => auto_facturx::verifier_pdfa(entree)
            .map(|v| serde_json::to_vec(&v).unwrap_or_default())
            .map_err(|e| e.to_string()),
        "tableur_lire" => auto_sheets::lire(entree)
            .map_err(|e| e.to_string())
            .and_then(|l| serde_json::to_vec(&l).map_err(|e| e.to_string())),
        "xlsx_ecrire" => {
            let c: auto_sheets::Classeur = serde_json::from_slice(entree).map_err(|e| e.to_string())?;
            auto_sheets::ecrire(&c).map_err(|e| e.to_string())
        }
        "xlsx_modifier" => {
            let [editions, octets] = trames(entree)?[..] else { return Err("trames éditions, XLSX attendues".into()) };
            auto_sheets::modifier(octets, &json::<Vec<auto_sheets::EditionCellule>>(editions)?)
                .map_err(|e| e.to_string())
        }
        "pdf_fusionner" => {
            let t = trames(entree)?;
            if t.len() % 2 != 0 {
                return Err("trames nom/PDF attendues par paires".into());
            }
            let pdfs = t
                .chunks(2)
                .map(|c| Ok((std::str::from_utf8(c[0]).map_err(|e| e.to_string())?, c[1])))
                .collect::<Result<Vec<_>, String>>()?;
            auto_fichiers::fusionner(&pdfs).map_err(|e| e.to_string())
        }
        "pdf_pages" => {
            let [pages, pdf] = trames(entree)?[..] else { return Err("trames pages, PDF attendues".into()) };
            auto_fichiers::extraire_pages(pdf, &json::<Vec<usize>>(pages)?).map_err(|e| e.to_string())
        }
        "pdf_nombre_pages" => {
            auto_fichiers::nombre_pages(entree).map(|n| n.to_string().into_bytes()).map_err(|e| e.to_string())
        }
        "pdf_texte" => auto_fichiers::texte_pdf(entree)
            .map(|pages| serde_json::json!({ "pages": pages }).to_string().into_bytes())
            .map_err(|e| e.to_string()),
        "docx_creer" => auto_fichiers::creer_docx(&json(entree)?)
            .and_then(|d| auto_fichiers::ecrire_docx(&d))
            .map_err(|e| e.to_string()),
        "docx_champs" => serde_json::to_vec(&auto_fichiers::champs_docx(&docx(entree)?)).map_err(|e| e.to_string()),
        "docx_remplir" => {
            let [valeurs, octets] = trames(entree)?[..] else { return Err("trames valeurs, DOCX attendues".into()) };
            let mut d = docx(octets)?;
            auto_fichiers::remplir_docx(&mut d, &json::<BTreeMap<String, String>>(valeurs)?)
                .and_then(|_| auto_fichiers::ecrire_docx(&d))
                .map_err(|e| e.to_string())
        }
        "docx_texte" => Ok(auto_fichiers::texte_docx(&docx(entree)?).into_bytes()),
        "docx_remplacer" => {
            let [editions, octets] = trames(entree)?[..] else {
                return Err("trames remplacements, DOCX attendues".into());
            };
            let mut d = docx(octets)?;
            auto_fichiers::remplacer_docx(&mut d, &json::<Vec<auto_fichiers::Remplacement>>(editions)?)
                .and_then(|_| auto_fichiers::ecrire_docx(&d))
                .map_err(|e| e.to_string())
        }
        "docx_pdf" => auto_fichiers::docx_en_pdf(&docx(entree)?).map_err(|e| e.to_string()),
        "pdf_caviarder" => {
            let [options, pdf] = trames(entree)?[..] else { return Err("trames options, PDF attendues".into()) };
            let (pdf, rapport) = auto_fichiers::caviarder(pdf, &json(options)?).map_err(|e| e.to_string())?;
            Ok(en_trames(&[&serde_json::to_vec(&rapport).map_err(|e| e.to_string())?, &pdf]))
        }
        "pdf_signer" => {
            let [options, p12, pdf] = trames(entree)?[..] else {
                return Err("trames options, PKCS #12, PDF attendues".into());
            };
            auto_fichiers::signer_pdf(pdf, p12, &json(options)?).map_err(|e| e.to_string())
        }
        "pdf_signatures" => {
            let [confiance, pdf] = trames(entree)?[..] else { return Err("trames certificats, PDF attendues".into()) };
            auto_fichiers::verifier_signatures(pdf, confiance)
                .map_err(|e| e.to_string())
                .and_then(|v| serde_json::to_vec(&v).map_err(|e| e.to_string()))
        }
        "pptx_creer" => auto_fichiers::creer_presentation(&json(entree)?)
            .and_then(|p| auto_fichiers::ecrire_pptx(&p))
            .map_err(|e| e.to_string()),
        "pptx_pdf" => auto_fichiers::lire_pptx(entree)
            .and_then(|p| auto_fichiers::presentation_en_pdf(&p))
            .map_err(|e| e.to_string()),
        "rag_decouper" => {
            #[derive(serde::Deserialize)]
            struct Entree {
                source: String,
                texte: String,
                taille: Option<usize>,
            }
            let e: Entree = json(entree)?;
            auto_connaissance::decouper(&e.source, &e.texte, e.taille)
                .map_err(|e| e.to_string())
                .and_then(|m| serde_json::to_vec(&m).map_err(|e| e.to_string()))
        }
        "rag_topk" => {
            #[derive(serde::Deserialize)]
            struct Parametres {
                dimension: usize,
                k: usize,
                diversite: Option<f64>,
            }
            let [p, question, matrice] = trames(entree)?[..] else {
                return Err("trames paramètres, question, matrice attendues".into());
            };
            let p: Parametres = json(p)?;
            auto_connaissance::plus_proches(&f32s(question)?, &f32s(matrice)?, p.dimension, p.k, p.diversite)
                .map_err(|e| e.to_string())
                .and_then(|r| serde_json::to_vec(&r).map_err(|e| e.to_string()))
        }
        _ => Err(format!("opération inconnue : {op}")),
    }
}

fn tampon(etat: u8, charge: &[u8], sortie_len: *mut usize) -> *mut u8 {
    let mut v = Vec::with_capacity(charge.len() + 1);
    v.push(etat);
    v.extend_from_slice(charge);
    let b = v.into_boxed_slice();
    // SAFETY: l'appelant fournit un pointeur valide vers un usize.
    unsafe { *sortie_len = b.len() };
    Box::into_raw(b).cast()
}

/// # Safety
/// `op`/`entree` pointent vers `op_len`/`entree_len` octets lisibles (`entree` peut être nul si
/// `entree_len` vaut 0) ; `sortie_len` pointe vers un usize inscriptible.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn auto_call(
    op: *const u8,
    op_len: usize,
    entree: *const u8,
    entree_len: usize,
    sortie_len: *mut usize,
) -> *mut u8 {
    // SAFETY: garanti par l'appelant (voir la documentation).
    let op = unsafe { std::slice::from_raw_parts(op, op_len) };
    let entree = if entree_len == 0 { &[][..] } else { unsafe { std::slice::from_raw_parts(entree, entree_len) } };
    let resultat = std::panic::catch_unwind(|| {
        let op = std::str::from_utf8(op).map_err(|e| e.to_string())?;
        appeler(op, entree)
    });
    match resultat {
        Ok(Ok(v)) => tampon(0, &v, sortie_len),
        Ok(Err(e)) => tampon(1, e.as_bytes(), sortie_len),
        Err(_) => tampon(1, "panique dans auto-ffi".as_bytes(), sortie_len),
    }
}

/// # Safety
/// `ptr`/`len` proviennent d'un appel à `auto_call`, et ne sont libérés qu'une fois.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn auto_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        // SAFETY: reconstruit la boîte allouée par `tampon`.
        drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const JSON: &str = r#"{ "numero": "F-2026-0001", "type": "facture", "date": "2026-10-22",
      "emetteur": { "nom": "A", "siret": "73282932000074", "adresse": "1 rue A", "tvaIntracom": "FR44732829320" },
      "client": { "nom": "B", "siret": "73282932000074", "adresse": "2 rue B" },
      "lignes": [{ "designation": "X", "quantite": 1, "prixUnitaireHtCents": 1000, "tva": 200 }],
      "echeance": "2026-11-21", "datePrestation": "2026-10-20" }"#;

    fn appel(op: &str, entree: &[u8]) -> (u8, Vec<u8>) {
        let mut len = 0usize;
        let p = unsafe { auto_call(op.as_ptr(), op.len(), entree.as_ptr(), entree.len(), &mut len) };
        let v = unsafe { std::slice::from_raw_parts(p, len) }.to_vec();
        unsafe { auto_free(p, len) };
        (v[0], v[1..].to_vec())
    }

    #[test]
    fn abi_facturx_extraire() {
        let mut entree = 1_792_000_000i64.to_le_bytes().to_vec();
        entree.extend_from_slice(JSON.as_bytes());
        let (etat, pdf) = appel("facturx", &entree);
        assert_eq!(etat, 0, "{}", String::from_utf8_lossy(&pdf));
        let (etat, xml) = appel("extraire", &pdf);
        assert_eq!(etat, 0);
        assert!(String::from_utf8(xml).unwrap().contains("F-2026-0001"));
        let (_, v) = appel("verifier_pdfa", &pdf);
        assert_eq!(v, b"[]");
    }

    #[test]
    fn abi_erreurs() {
        assert_eq!(appel("inconnue", b"").0, 1);
        let (etat, msg) = appel("rendre", b"{");
        assert_eq!(etat, 1);
        assert!(!msg.is_empty());
        assert_eq!(appel("facturx", b"court").0, 1);
        assert_eq!(appel("pdf_pages", &[9, 0, 0, 0, 1]).0, 1);
        assert_eq!(appel("pdf_fusionner", b"").0, 1);
    }

    fn trame(v: &mut Vec<u8>, o: &[u8]) {
        v.extend_from_slice(&(o.len() as u32).to_le_bytes());
        v.extend_from_slice(o);
    }

    #[test]
    fn abi_fichiers() {
        let (etat, d) =
            appel("docx_creer", r#"{ "titre": "Bon {{ n }}", "paragraphes": [{ "texte": "Ligne" }] }"#.as_bytes());
        assert_eq!(etat, 0, "{}", String::from_utf8_lossy(&d));
        assert_eq!(appel("docx_champs", &d).1, br#"["n"]"#);
        let mut e = Vec::new();
        trame(&mut e, br#"{ "n": "42" }"#);
        trame(&mut e, &d);
        let (etat, rempli) = appel("docx_remplir", &e);
        assert_eq!(etat, 0);
        assert_eq!(
            appel("docx_texte", &rempli).1,
            "Bon 42
Ligne"
                .as_bytes()
        );
        let (etat, pdf) = appel("docx_pdf", &rempli);
        assert_eq!(etat, 0);
        let mut e = Vec::new();
        for _ in 0..2 {
            trame(&mut e, b"bon.pdf");
            trame(&mut e, &pdf);
        }
        let (etat, deux) = appel("pdf_fusionner", &e);
        assert_eq!(etat, 0, "{}", String::from_utf8_lossy(&deux));
        let mut e = Vec::new();
        trame(&mut e, b"[1]");
        trame(&mut e, &deux);
        assert_eq!(appel("pdf_nombre_pages", &deux).1, b"2");
        let (etat, une) = appel("pdf_pages", &e);
        assert_eq!(etat, 0);
        let texte: serde_json::Value = serde_json::from_slice(&appel("pdf_texte", &une).1).unwrap();
        assert_eq!(texte["pages"].as_array().unwrap().len(), 1);
        assert!(texte["pages"][0].as_str().unwrap().contains("Bon 42"));
    }

    #[test]
    fn abi_caviarder_signer_presentation() {
        let (_, docx) = appel(
            "docx_creer",
            r#"{ "titre": "Note", "paragraphes": [{ "texte": "Contact : a.b@exemple.fr" }] }"#.as_bytes(),
        );
        let (_, pdf) = appel("docx_pdf", &docx);
        let mut e = Vec::new();
        trame(&mut e, br#"{ "motifs": ["email"] }"#);
        trame(&mut e, &pdf);
        let (etat, sortie) = appel("pdf_caviarder", &e);
        assert_eq!(etat, 0, "{}", String::from_utf8_lossy(&sortie));
        let [rapport, caviarde] = trames(&sortie).unwrap()[..] else { panic!("deux trames") };
        let rapport: serde_json::Value = serde_json::from_slice(rapport).unwrap();
        assert_eq!(rapport["occurrences"], 1);
        assert!(!String::from_utf8_lossy(&appel("pdf_texte", caviarde).1).contains("exemple.fr"));

        let p12 = include_bytes!("../../../vendor/suite/crates/pdfcraft-sign/tests/data/rsa-aes.p12");
        let mut e = Vec::new();
        trame(&mut e, br#"{ "mot_de_passe": "test", "date": "D:20261023120000Z" }"#);
        trame(&mut e, p12);
        trame(&mut e, caviarde);
        let (etat, signe) = appel("pdf_signer", &e);
        assert_eq!(etat, 0, "{}", String::from_utf8_lossy(&signe));
        let mut e = Vec::new();
        trame(&mut e, b"");
        trame(&mut e, &signe);
        let (etat, v) = appel("pdf_signatures", &e);
        assert_eq!(etat, 0);
        let v: serde_json::Value = serde_json::from_slice(&v).unwrap();
        assert_eq!(v[0]["statut"], "inconnue");
        assert_eq!(v[0]["signataire"], "Test Signer RSA");

        let (etat, pptx) =
            appel("pptx_creer", br#"{ "titre": "Bilan", "diapositives": [{ "titre": "Un", "puces": ["a"] }] }"#);
        assert_eq!(etat, 0, "{}", String::from_utf8_lossy(&pptx));
        let (etat, pdf) = appel("pptx_pdf", &pptx);
        assert_eq!(etat, 0, "{}", String::from_utf8_lossy(&pdf));
        assert_eq!(appel("pdf_nombre_pages", &pdf).1, b"2");
        assert_eq!(appel("pptx_pdf", b"PK").0, 1);
    }

    #[test]
    fn abi_connaissance() {
        let texte = "La garantie couvre deux ans de pièces. ".repeat(40);
        let e = serde_json::json!({ "source": "garantie.txt", "texte": texte, "taille": 300 }).to_string();
        let (etat, m) = appel("rag_decouper", e.as_bytes());
        assert_eq!(etat, 0, "{}", String::from_utf8_lossy(&m));
        let m: serde_json::Value = serde_json::from_slice(&m).unwrap();
        assert!(m.as_array().unwrap().len() > 3);
        assert_eq!(m[1]["position"], 1);
        assert!(m[0]["texte"].as_str().unwrap().contains("garantie"));

        let f = |v: &[f32]| v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
        let mut e = Vec::new();
        trame(&mut e, br#"{ "dimension": 2, "k": 2 }"#);
        trame(&mut e, &f(&[0.0, 2.0]));
        trame(&mut e, &f(&[1.0, 0.0, 0.0, 1.0, 1.0, 1.0]));
        let (etat, r) = appel("rag_topk", &e);
        assert_eq!(etat, 0, "{}", String::from_utf8_lossy(&r));
        let r: serde_json::Value = serde_json::from_slice(&r).unwrap();
        assert_eq!(r[0]["indice"], 1);
        assert_eq!(r[1]["indice"], 2);
        assert!((r[0]["score"].as_f64().unwrap() - 1.0).abs() < 1e-6);
        let mut e = Vec::new();
        trame(&mut e, br#"{ "dimension": 3, "k": 2 }"#);
        trame(&mut e, &f(&[0.0, 2.0]));
        trame(&mut e, &f(&[1.0, 0.0]));
        assert_eq!(appel("rag_topk", &e).0, 1);
        assert_eq!(appel("rag_topk", b"").0, 1);
        assert_eq!(appel("rag_decouper", b"{}").0, 1);
    }
}
