//! Présentations (`deckcraft-model`, `deckcraft-pptx`, `deckcraft-pdf`) : diapositive de titre
//! puis diapositives titre et puces, sur le masque et les dispositions standard de DeckCraft
//! (16:9) ; export PPTX et PDF (diapositives rendues, couche texte réelle, signets).

use crate::{Erreur, R};
use deckcraft_model::defaults::{layout_of_kind, new_presentation, new_slide};
use deckcraft_model::text::{Paragraph, TextBody};
use deckcraft_model::{LayoutType, PhType, Presentation, Slide};
use serde::Deserialize;
use std::sync::Arc;

pub use deckcraft_model::Presentation as Pptx;

/// Diapositives au plus.
pub const DIAPOSITIVES_MAX: usize = 500;

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Puce {
    Texte(String),
    Niveau {
        texte: String,
        /// 0 à 4.
        #[serde(default)]
        niveau: u8,
    },
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct Diapositive {
    pub titre: String,
    pub puces: Vec<Puce>,
    /// Notes de l'orateur.
    pub notes: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct NouvellePresentation {
    pub titre: String,
    pub sous_titre: String,
    pub diapositives: Vec<Diapositive>,
}

fn une_ligne(t: &str) -> String {
    t.replace(['\r', '\n', '\u{b}'], " ")
}

/// Remplit les espaces réservés de la diapositive : titre, puis corps (sous-titre ou contenu) ;
/// un espace resté vide est retiré, pour ne pas montrer son invite.
fn remplir(s: &mut Slide, titre: &str, corps: Vec<Paragraph>) {
    let mut corps = Some(corps).filter(|c| !c.is_empty());
    s.shapes.retain_mut(|sh| {
        let Some(kind) = sh.ph_type() else { return true };
        let paragraphes = if kind.is_title() {
            (!titre.is_empty()).then(|| vec![Paragraph::new(&une_ligne(titre))])
        } else if matches!(kind, PhType::SubTitle | PhType::Body | PhType::Obj) {
            corps.take()
        } else {
            None
        };
        match paragraphes {
            Some(paragraphs) => {
                sh.text = Some(TextBody { paragraphs, ..Default::default() });
                true
            }
            None => false,
        }
    });
}

pub fn creer_presentation(n: &NouvellePresentation) -> R<Presentation> {
    if n.diapositives.len() > DIAPOSITIVES_MAX {
        return Err(Erreur::Donnees(format!("{DIAPOSITIVES_MAX} diapositives au plus")));
    }
    if n.titre.is_empty() && n.diapositives.is_empty() {
        return Err(Erreur::Donnees("titre ou diapositives requis".into()));
    }
    let mut p = new_presentation(None);
    p.props.title = n.titre.clone();
    if n.titre.is_empty() && n.sous_titre.is_empty() {
        p.slides.clear();
    } else if let Some(s) = p.slides.first_mut() {
        let sous_titre = n.sous_titre.lines().filter(|l| !l.trim().is_empty()).map(Paragraph::new).collect();
        remplir(Arc::make_mut(s), &n.titre, sous_titre);
    }
    let disposition = layout_of_kind(&p, LayoutType::TitleAndContent)
        .ok_or_else(|| Erreur::Donnees("disposition « titre et contenu » absente".into()))?;
    for d in &n.diapositives {
        let mut s = new_slide(&mut p, disposition);
        let puces = d
            .puces
            .iter()
            .map(|x| {
                let (texte, niveau) = match x {
                    Puce::Texte(t) => (t.as_str(), 0),
                    Puce::Niveau { texte, niveau } => (texte.as_str(), (*niveau).min(4)),
                };
                Paragraph { level: niveau, ..Paragraph::new(&une_ligne(texte)) }
            })
            .collect();
        remplir(&mut s, &d.titre, puces);
        if !d.notes.is_empty() {
            s.notes = TextBody::from_text(&d.notes);
        }
        p.slides.push(Arc::new(s));
    }
    Ok(p)
}

pub fn ecrire_pptx(p: &Presentation) -> R<Vec<u8>> {
    Ok(deckcraft_pptx::export(p)?)
}

pub fn lire_pptx(octets: &[u8]) -> R<Presentation> {
    Ok(deckcraft_pptx::import(octets)?)
}

/// PDF d'une diapositive par page (rendu à 150 ppp, texte sélectionnable).
pub fn presentation_en_pdf(p: &Presentation) -> R<Vec<u8>> {
    Ok(deckcraft_pdf::export(p, &deckcraft_pdf::PdfOptions { dpi: 150.0, ..Default::default() })?)
}

/// Titre et texte de chaque diapositive (une ligne par paragraphe).
pub fn texte_presentation(p: &Presentation) -> Vec<String> {
    p.slides
        .iter()
        .map(|s| s.shapes.iter().filter_map(|sh| sh.text.as_ref()).map(TextBody::text).collect::<Vec<_>>().join("\n"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exemple() -> NouvellePresentation {
        serde_json::from_str(
            r#"{ "titre": "Bilan 2026", "sous_titre": "Atelier Dupont",
              "diapositives": [
                { "titre": "Chiffres", "puces": ["CA : 120 k€", { "texte": "dont services", "niveau": 1 }], "notes": "Insister" },
                { "titre": "Suite" }
              ] }"#,
        )
        .unwrap()
    }

    #[test]
    fn pptx_cree_et_relu() {
        let octets = ecrire_pptx(&creer_presentation(&exemple()).unwrap()).unwrap();
        assert_eq!(&octets[..2], b"PK");
        let p = lire_pptx(&octets).unwrap();
        assert_eq!(p.slides.len(), 3);
        assert_eq!(p.slides[0].title(), "Bilan 2026");
        let t = texte_presentation(&p);
        assert!(t[0].contains("Atelier Dupont"), "{t:?}");
        assert!(t[1].contains("CA : 120 k€") && t[1].contains("dont services"), "{t:?}");
        assert_eq!(t[2], "Suite");
        assert_eq!(p.slides[1].notes_text(), "Insister");
        let corps = p.slides[1].shapes.iter().find(|s| s.ph_type().is_some_and(|k| !k.is_title())).unwrap();
        assert_eq!(corps.text.as_ref().unwrap().paragraphs[1].level, 1);
    }

    #[test]
    fn pdf() {
        let pdf = presentation_en_pdf(&creer_presentation(&exemple()).unwrap()).unwrap();
        let pages = crate::texte_pdf(&pdf).unwrap();
        assert_eq!(pages.len(), 3);
        assert!(pages[1].contains("Chiffres"), "{pages:?}");
    }

    #[test]
    fn sans_titre_ni_diapositive() {
        assert!(creer_presentation(&NouvellePresentation::default()).is_err());
        let p = creer_presentation(&NouvellePresentation {
            diapositives: vec![Diapositive { titre: "Seule".into(), ..Default::default() }],
            ..Default::default()
        })
        .unwrap();
        assert_eq!(p.slides.len(), 1);
    }
}
