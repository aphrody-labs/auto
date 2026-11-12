//! Fichiers des automatisations, par la suite Craft :
//!
//! - PDF : fusion (`pdfcraft-organize::combine`), extraction de pages (`extract_pages`), texte dans
//!   l'ordre de lecture (`pdfcraft-render`, couche texte de hayro).
//! - Word : lecture et écriture DOCX (`wordcraft-docx`), remplissage d'un gabarit à champs
//!   `{{ nom }}`, création d'un document simple, export PDF (`wordcraft-pdf`, polices embarquées).
//! - Caviardage définitif (`pdfcraft-redact`), signature PAdES et vérification (`pdfcraft-sign`).
//! - Présentations PPTX et PDF (`deckcraft-pptx`, `deckcraft-pdf`).

mod caviardage;
mod presentation;
mod signature;

pub use caviardage::{Caviardage, MOTIFS, Rapport, Recherche, caviarder, ibans};
pub use presentation::{
    Diapositive, NouvellePresentation, Pptx, Puce, creer_presentation, ecrire_pptx, lire_pptx, presentation_en_pdf,
    texte_presentation,
};
pub use signature::{Signature, Verification, signer_pdf, verifier_signatures};

use pdfcraft_cos::{Document as Pdf, SaveOptions, write_full};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::Arc;
pub use wordcraft_doc::Document as Docx;
use wordcraft_doc::para::OBJ;
use wordcraft_doc::{Block, Blocks, CharProps, Paragraph, StoryRef, para_block};

#[derive(Debug, thiserror::Error)]
pub enum Erreur {
    #[error("PDF illisible : {0}")]
    Pdf(#[from] pdfcraft_cos::CosError),
    #[error("PDF : {0}")]
    Organisation(#[from] pdfcraft_organize::OrganizeError),
    #[error("DOCX : {0}")]
    Docx(#[from] wordcraft_docx::DocxError),
    #[error("export PDF : {0}")]
    Export(#[from] wordcraft_pdf::PdfError),
    #[error("document : {0}")]
    Modele(#[from] wordcraft_doc::DocError),
    #[error("caviardage : {0}")]
    Caviardage(#[from] pdfcraft_redact::RedactError),
    #[error("signature : {0}")]
    Signature(#[from] pdfcraft_sign::SignError),
    #[error("PPTX : {0}")]
    Pptx(#[from] deckcraft_pptx::PptxError),
    #[error("présentation en PDF : {0}")]
    PresentationPdf(#[from] deckcraft_pdf::PdfError),
    #[error("{0}")]
    Donnees(String),
}

pub(crate) type R<T> = Result<T, Erreur>;

/// Pages au plus lues par `texte_pdf` (au-delà, le texte est tronqué).
pub const PAGES_TEXTE_MAX: usize = 500;

pub(crate) fn ouvrir(octets: &[u8]) -> R<Pdf> {
    Ok(Pdf::open(Arc::new(octets.to_vec()))?)
}

pub(crate) fn enregistrer(doc: &Pdf) -> R<Vec<u8>> {
    Ok(write_full(doc, &SaveOptions::default())?)
}

// PDF -------------------------------------------------------------------------------------------

/// Fusionne des PDF dans l'ordre ; chacun reçoit un signet à son nom.
pub fn fusionner(pdfs: &[(&str, &[u8])]) -> R<Vec<u8>> {
    if pdfs.is_empty() {
        return Err(Erreur::Donnees("aucun PDF à fusionner".into()));
    }
    let docs = pdfs.iter().map(|(_, o)| ouvrir(o)).collect::<R<Vec<_>>>()?;
    let sources: Vec<(&str, &Pdf)> = pdfs.iter().zip(&docs).map(|((nom, _), d)| (*nom, d)).collect();
    enregistrer(&pdfcraft_organize::combine(&sources)?)
}

/// Nombre de pages d'un PDF.
pub fn nombre_pages(pdf: &[u8]) -> R<usize> {
    Ok(pdfcraft_organize::page_count(&ouvrir(pdf)?)?)
}

/// Nouveau PDF fait des pages `pages` (numérotées à partir de 0, dans l'ordre donné).
pub fn extraire_pages(pdf: &[u8], pages: &[usize]) -> R<Vec<u8>> {
    if pages.is_empty() {
        return Err(Erreur::Donnees("aucune page demandée".into()));
    }
    enregistrer(&pdfcraft_organize::extract_pages(&ouvrir(pdf)?, pages)?)
}

/// Texte de chaque page, dans l'ordre de lecture (vide pour une page sans couche texte, un scan).
pub fn texte_pdf(pdf: &[u8]) -> R<Vec<String>> {
    use pdfcraft_render::{PageRenderer, RenderConfig, RenderRequest, RequestKind};
    let mut r = PageRenderer::new(Arc::new(pdf.to_vec()), RenderConfig::default());
    let n = r.page_count();
    if n == 0 {
        // Le PDF n'a pas pu être analysé : l'erreur précise vient du lecteur cos.
        ouvrir(pdf)?;
        return Err(Erreur::Donnees("PDF sans page".into()));
    }
    Ok((0..n.min(PAGES_TEXTE_MAX))
        .map(|page| {
            let rendu = r.render(RenderRequest { page, kind: RequestKind::Text, scale: 1.0, ..Default::default() });
            rendu.text.map(|t| t.plain_text().trim_end().to_string()).unwrap_or_default()
        })
        .collect())
}

// Word ------------------------------------------------------------------------------------------

/// Paragraphe d'un document créé.
#[derive(Debug, Deserialize)]
pub struct Para {
    pub texte: String,
    /// `titre`, `titre1`, `titre2`, `titre3` ou normal.
    #[serde(default)]
    pub style: Option<String>,
    #[serde(default)]
    pub gras: bool,
}

/// Document simple : titre puis paragraphes, A4.
#[derive(Debug, Deserialize)]
pub struct Nouveau {
    #[serde(default)]
    pub titre: String,
    #[serde(default)]
    pub paragraphes: Vec<Para>,
}

fn style(s: Option<&str>) -> Option<&'static str> {
    match s? {
        "titre" => Some("Title"),
        "titre1" => Some("Heading1"),
        "titre2" => Some("Heading2"),
        "titre3" => Some("Heading3"),
        _ => None,
    }
}

fn paragraphe(texte: &str, style: Option<&str>, gras: bool) -> Arc<Block> {
    let props = CharProps { bold: gras.then_some(true), ..Default::default() };
    let p = Paragraph::with_text(&texte.replace(['\r', '\n'], " "), props);
    para_block(match style {
        Some(s) => p.styled(s),
        None => p,
    })
}

/// Crée un document Word (A4, marges de 2 cm).
pub fn creer_docx(n: &Nouveau) -> R<Docx> {
    let mut d = Docx::new();
    let mut corps: Blocks = Vec::new();
    if !n.titre.is_empty() {
        corps.push(paragraphe(&n.titre, Some("Title"), false));
        d.core.title = n.titre.clone();
    }
    for p in &n.paragraphes {
        // Un paragraphe par ligne : les retours à la ligne du texte restent visibles.
        for ligne in p.texte.split('\n') {
            corps.push(paragraphe(ligne, style(p.style.as_deref()), p.gras));
        }
    }
    if !corps.is_empty() {
        d.body = corps;
    }
    let s = &mut d.last_section;
    (s.page_w, s.page_h) = (595.28, 841.89);
    (s.margin_top, s.margin_bottom, s.margin_left, s.margin_right) = (56.7, 56.7, 56.7, 56.7);
    d.ensure_nonempty();
    Ok(d)
}

pub fn lire_docx(octets: &[u8]) -> R<Docx> {
    Ok(wordcraft_docx::read(octets)?)
}

pub fn ecrire_docx(d: &Docx) -> R<Vec<u8>> {
    Ok(wordcraft_docx::write(d)?)
}

pub fn docx_en_pdf(d: &Docx) -> R<Vec<u8>> {
    Ok(wordcraft_pdf::export(d, &wordcraft_pdf::PdfOptions::default())?)
}

/// Texte du corps du document, un paragraphe par ligne.
pub fn texte_docx(d: &Docx) -> String {
    d.plain_text(StoryRef::Body)
}

/// Champs `{{ nom }}` d'un paragraphe : (début, fin, nom) en octets.
fn champs_de(texte: &str) -> Vec<(usize, usize, String)> {
    let mut v = Vec::new();
    let mut i = 0;
    while let Some(a) = texte[i..].find("{{").map(|a| a + i) {
        let Some(b) = texte[a + 2..].find("}}").map(|b| b + a + 2) else { break };
        let nom = texte[a + 2..b].trim();
        if !nom.is_empty() && !nom.contains(OBJ) && !nom.contains("{{") {
            v.push((a, b + 2, nom.to_string()));
            i = b + 2;
        } else {
            i = a + 2;
        }
    }
    v
}

/// Applique `f` à chaque paragraphe du document : corps, tableaux, en-têtes, pieds, notes, zones de texte.
fn chaque_para(d: &mut Docx, f: &mut dyn FnMut(&mut Paragraph) -> R<()>) -> R<()> {
    fn blocs(bl: &mut Blocks, f: &mut dyn FnMut(&mut Paragraph) -> R<()>) -> R<()> {
        for b in bl.iter_mut() {
            match &**b {
                Block::Para(_) => {
                    if let Block::Para(p) = Arc::make_mut(b) {
                        f(p)?;
                    }
                }
                Block::Table(_) => {
                    let Block::Table(t) = Arc::make_mut(b) else { continue };
                    for r in &mut t.rows {
                        for c in &mut r.cells {
                            blocs(&mut c.blocks, f)?;
                        }
                    }
                }
            }
        }
        Ok(())
    }
    blocs(&mut d.body, f)?;
    for part in d.parts.values_mut() {
        blocs(&mut part.blocks, f)?;
    }
    Ok(())
}

/// Noms des champs `{{ nom }}` d'un gabarit, sans doublon, dans l'ordre d'apparition.
pub fn champs_docx(d: &Docx) -> Vec<String> {
    fn blocs(bl: &Blocks, noms: &mut Vec<String>) {
        for b in bl {
            match &**b {
                Block::Para(p) => {
                    for (_, _, nom) in champs_de(&p.text) {
                        if !noms.contains(&nom) {
                            noms.push(nom);
                        }
                    }
                }
                Block::Table(t) => t.rows.iter().flat_map(|r| &r.cells).for_each(|c| blocs(&c.blocks, noms)),
            }
        }
    }
    let mut noms = Vec::new();
    blocs(&d.body, &mut noms);
    d.parts.values().for_each(|part| blocs(&part.blocks, &mut noms));
    noms
}

/// Remplace chaque champ `{{ nom }}` connu par sa valeur, avec la mise en forme du `{{`.
/// Les champs absents de `valeurs` restent tels quels.
pub fn remplir_docx(d: &mut Docx, valeurs: &BTreeMap<String, String>) -> R<usize> {
    if valeurs.len() > 200 || valeurs.iter().any(|(k, v)| k.len() > 200 || v.len() > 100_000) {
        return Err(Erreur::Donnees("valeurs de gabarit trop volumineuses".into()));
    }
    let mut n = 0;
    let mut ajouts = 0usize;
    chaque_para(d, &mut |p| {
        let champs = champs_de(&p.text);
        if champs.iter().all(|(_, _, nom)| !valeurs.contains_key(nom)) {
            return Ok(());
        }
        for (a, b, nom) in champs.into_iter().rev() {
            let Some(v) = valeurs.get(&nom) else { continue };
            ajouts = ajouts.saturating_add(v.len());
            if n >= 10_000 || ajouts > 20 * 1024 * 1024 {
                return Err(Erreur::Donnees("gabarit rempli supérieur aux limites".into()));
            }
            let props = p.props_of_char(a).clone();
            p.delete(a, b)?;
            p.insert_text(a, &v.replace(['\r', '\n'], " "), &props)?;
            n += 1;
        }
        Ok(())
    })?;
    Ok(n)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Remplacement {
    pub chercher: String,
    pub remplacer: String,
}

/// Remplacements littéraux, y compris tableaux et parties liées, avec les attributs du premier caractère.
pub fn remplacer_docx(d: &mut Docx, remplacements: &[Remplacement]) -> R<usize> {
    if remplacements.is_empty()
        || remplacements.len() > 100
        || remplacements.iter().any(|r| r.chercher.is_empty() || r.chercher.len() > 2000 || r.remplacer.len() > 100_000)
    {
        return Err(Erreur::Donnees("remplacements invalides".into()));
    }
    let mut total = 0;
    let mut ajouts = 0usize;
    chaque_para(d, &mut |p| {
        for r in remplacements {
            let positions: Vec<_> = p.text.match_indices(&r.chercher).map(|(a, s)| (a, s.len())).collect();
            if total + positions.len() > 10_000 {
                return Err(Erreur::Donnees("plus de 10 000 remplacements".into()));
            }
            ajouts = ajouts.saturating_add(positions.len().saturating_mul(r.remplacer.len()));
            if ajouts > 20 * 1024 * 1024 {
                return Err(Erreur::Donnees("texte remplacé supérieur à 20 Mo".into()));
            }
            for (a, longueur) in positions.into_iter().rev() {
                let props = p.props_of_char(a).clone();
                p.delete(a, a + longueur)?;
                p.insert_text(a, &r.remplacer.replace(['\r', '\n'], " "), &props)?;
                total += 1;
            }
        }
        Ok(())
    })?;
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nouveau(titre: &str, lignes: &[&str]) -> Nouveau {
        Nouveau {
            titre: titre.into(),
            paragraphes: lignes.iter().map(|t| Para { texte: (*t).into(), style: None, gras: false }).collect(),
        }
    }

    fn pdf(titre: &str, lignes: &[&str]) -> Vec<u8> {
        docx_en_pdf(&creer_docx(&nouveau(titre, lignes)).unwrap()).unwrap()
    }

    #[test]
    fn docx_cree_relu_et_exporte() {
        let d = creer_docx(&nouveau("Compte rendu", &["Chantier Dupont", "Livraison prévue lundi"])).unwrap();
        let octets = ecrire_docx(&d).unwrap();
        assert_eq!(&octets[..2], b"PK");
        let relu = lire_docx(&octets).unwrap();
        assert_eq!(texte_docx(&relu), "Compte rendu\nChantier Dupont\nLivraison prévue lundi");
        assert_eq!(relu.last_section.page_w.round(), 595.0);
        let texte = texte_pdf(&docx_en_pdf(&relu).unwrap()).unwrap().join("\n");
        assert!(texte.contains("Livraison prévue lundi"), "{texte}");
    }

    #[test]
    fn gabarit_rempli() {
        let d = creer_docx(&nouveau("Devis {{ numero }}", &["Client : {{client.nom}} ({{ ville }})", "{{ inconnu }}"]))
            .unwrap();
        // Aller-retour DOCX : le gabarit vient d'un fichier.
        let mut d = lire_docx(&ecrire_docx(&d).unwrap()).unwrap();
        assert_eq!(champs_docx(&d), ["numero", "client.nom", "ville", "inconnu"]);
        let valeurs: BTreeMap<String, String> =
            [("numero", "D-12"), ("client.nom", "Zoé Martin"), ("ville", "Lyon\nCentre")]
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .into();
        assert_eq!(remplir_docx(&mut d, &valeurs).unwrap(), 3);
        let relu = lire_docx(&ecrire_docx(&d).unwrap()).unwrap();
        assert_eq!(texte_docx(&relu), "Devis D-12\nClient : Zoé Martin (Lyon Centre)\n{{ inconnu }}");
        assert_eq!(relu.body[0].as_para().unwrap().props.style.as_deref(), Some("Title"));
    }

    #[test]
    fn champs_mal_formes() {
        assert_eq!(champs_de("{{ a }} {{ }} {{b}} {{ c"), [(0, 7, "a".into()), (14, 19, "b".into())]);
        assert!(champs_de("aucun").is_empty());
    }

    #[test]
    fn pdf_fusion_pages_texte() {
        let a = pdf("Premier", &["Alpha"]);
        let b = pdf("Second", &["Bêta"]);
        let f = fusionner(&[("a.pdf", &a), ("b.pdf", &b)]).unwrap();
        assert_eq!(nombre_pages(&f).unwrap(), 2);
        let t = texte_pdf(&f).unwrap();
        assert_eq!(t.len(), 2);
        assert!(t[0].contains("Premier") && t[0].contains("Alpha"), "{t:?}");
        assert!(t[1].contains("Second") && t[1].contains("Bêta"), "{t:?}");
        let seule = extraire_pages(&f, &[1]).unwrap();
        assert_eq!(texte_pdf(&seule).unwrap(), [t[1].clone()]);
        let inverse = extraire_pages(&f, &[1, 0]).unwrap();
        assert!(texte_pdf(&inverse).unwrap()[0].contains("Second"));
    }

    #[test]
    fn pdf_de_facture() {
        let json = r#"{ "numero": "F-2026-0001", "type": "facture", "date": "2026-10-22",
          "emetteur": { "nom": "Atelier", "siret": "73282932000074", "adresse": "1 rue A" },
          "client": { "nom": "Client SAS", "siret": "73282932000074", "adresse": "2 rue B" },
          "lignes": [{ "designation": "Pose", "quantite": 1, "prixUnitaireHtCents": 1000, "tva": 200 }],
          "echeance": "2026-11-21", "datePrestation": "2026-10-20" }"#;
        let f = auto_docs::rendre(&auto_modele::Facture::depuis_json(json).unwrap()).unwrap();
        let t = texte_pdf(&f).unwrap().join("\n");
        assert!(t.contains("F-2026-0001") && t.contains("Client SAS"), "{t}");
        let deux = fusionner(&[("f.pdf", &f), ("g.pdf", &f)]).unwrap();
        assert_eq!(nombre_pages(&deux).unwrap(), 2);
    }

    #[test]
    fn erreurs() {
        assert!(fusionner(&[]).is_err());
        assert!(texte_pdf(b"pas un pdf").is_err());
        assert!(extraire_pages(&pdf("x", &[]), &[3]).is_err());
        assert!(lire_docx(b"PK pas un zip").is_err());
    }
}
