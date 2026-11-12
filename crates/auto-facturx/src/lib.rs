//! Factur-X, profil EN 16931 : génération du XML CII (UN/CEFACT D16B), assemblage du PDF/A-3b
//! avec `factur-x.xml` embarqué (relation `Alternative`), contrôle PDF/A et extraction.
//!
//! Le modèle d'entrée reprend le JSON de `@auto/domain` (`Document` + `numero`), en camelCase.

mod cii;
mod pdf;

pub use auto_modele::{Facture, Ligne, Partie, Totaux, TypeDocument};
pub use cii::xml;
pub use pdf::{NOM_XML, assembler, extraire, verifier_pdfa};

#[derive(Debug, thiserror::Error)]
pub enum Erreur {
    #[error("PDF : {0}")]
    Pdf(#[from] pdfcraft_cos::CosError),
    #[error("PDF/A-3b non conforme : {0:?}")]
    NonConforme(Vec<String>),
    #[error("document invalide : {0}")]
    Invalide(String),
}

/// Facture JSON + PDF visuel → Factur-X conforme PDF/A-3b.
pub fn generer(facture: &Facture, pdf_visuel: &[u8], date_unix: i64) -> Result<Vec<u8>, Erreur> {
    let x = xml(facture)?;
    let out = assembler(pdf_visuel, &x, date_unix)?;
    let restants = verifier_pdfa(&out)?;
    if !restants.is_empty() {
        return Err(Erreur::NonConforme(restants));
    }
    Ok(out)
}
