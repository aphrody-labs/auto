//! Données échangées entre le serveur et la page (sérialisées par les fonctions serveur).
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EtatService {
    Marche,
    Demarrage,
    Panne,
    Arret,
    Absent,
}

impl EtatService {
    pub fn libelle(self) -> &'static str {
        match self {
            Self::Marche => "En marche",
            Self::Demarrage => "Démarre",
            Self::Panne => "En panne",
            Self::Arret => "Arrêté",
            Self::Absent => "Non installé",
        }
    }
    pub fn classe(self) -> &'static str {
        match self {
            Self::Marche => "marche",
            Self::Demarrage => "demarrage",
            Self::Panne => "panne",
            Self::Arret => "arret",
            Self::Absent => "absent",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ServiceVu {
    pub id: String,
    pub nom: String,
    pub role: String,
    pub couleur: String,
    pub technique: bool,
    /// Lien « Ouvrir », calculé par le serveur depuis l'hôte de la requête (ou le domaine de la boîte).
    pub lien: Option<String>,
    pub etat: EtatService,
    pub statut: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Systeme {
    pub cpus: Option<u64>,
    pub memoire: Option<u64>,
    pub disque_total: Option<u64>,
    pub disque_libre: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EtatBoite {
    pub services: Vec<ServiceVu>,
    pub systeme: Systeme,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Modele {
    pub nom: String,
    pub taille: u64,
    pub details: String,
    pub charge: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Suggestion {
    pub nom: String,
    pub usage: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Progression {
    pub nom: String,
    pub statut: String,
    pub fait: u64,
    pub total: u64,
    pub erreur: Option<String>,
    pub termine: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Modeles {
    pub installes: Vec<Modele>,
    pub suggestions: Vec<Suggestion>,
    pub en_cours: Vec<Progression>,
    pub erreur: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Acces {
    pub service: String,
    pub identifiant: String,
    pub mot_de_passe: String,
}

/// Taille lisible : 1,5 Go, 300 Mo…
pub fn octets(n: u64) -> String {
    const UNITES: [&str; 5] = ["o", "Ko", "Mo", "Go", "To"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITES.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    let texte = if v < 10.0 && i > 0 { format!("{v:.1}") } else { format!("{v:.0}") };
    format!("{} {}", texte.replace('.', ","), UNITES[i])
}

#[cfg(test)]
mod tests {
    use super::octets;

    #[test]
    fn tailles_lisibles() {
        assert_eq!(octets(512), "512 o");
        assert_eq!(octets(1536), "1,5 Ko");
        assert_eq!(octets(2_684_354_560), "2,5 Go");
        assert_eq!(octets(300 * 1024 * 1024), "300 Mo");
    }
}
