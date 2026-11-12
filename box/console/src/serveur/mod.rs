//! Côté serveur : configuration lue dans l'environnement (le `.env` de la boîte, passé par compose), clients du
//! moteur Docker et d'Ollama, session, catalogue des services et préparateur.
pub mod docker;
pub mod ollama;
pub mod preparer;
pub mod services;
pub mod session;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use crate::types::Progression;

pub struct Config {
    pub utilisateur: String,
    pub mot_de_passe: String,
    pub secret: String,
    pub domaine: Option<String>,
    pub env: HashMap<String, String>,
}

impl Config {
    pub fn depuis_env() -> Result<Self, String> {
        let env: HashMap<String, String> = std::env::vars().collect();
        let lire = |cle: &str| env.get(cle).cloned().unwrap_or_default();
        let (secret, mot_de_passe) = (lire("BOX_SECRET"), lire("BOX_ADMIN_MOT_DE_PASSE"));
        if secret.len() < 16 || mot_de_passe.len() < 8 {
            return Err(
                "BOX_SECRET (16 caractères ou plus) et BOX_ADMIN_MOT_DE_PASSE (8 ou plus) requis : lancez `aphrody-box preparer`"
                    .into(),
            );
        }
        Ok(Self {
            utilisateur: env.get("BOX_ADMIN_UTILISATEUR").cloned().unwrap_or_else(|| "admin".into()),
            domaine: env.get("BOX_DOMAINE").filter(|d| !d.is_empty()).cloned(),
            mot_de_passe,
            secret,
            env,
        })
    }

    pub fn val(&self, cle: &str) -> String {
        self.env.get(cle).cloned().unwrap_or_default()
    }
}

pub struct Etat {
    pub config: Config,
    pub docker: docker::Docker,
    pub ollama: ollama::Ollama,
    /// Client des sondes HTTP (sans redirection, 2,5 s).
    pub sondes: reqwest::Client,
    /// Téléchargements de modèles en cours ou récents, par nom.
    pub telechargements: Arc<Mutex<HashMap<String, Progression>>>,
    pub tentatives: session::Tentatives,
}

static ETAT: OnceLock<Etat> = OnceLock::new();

pub fn installer(e: Etat) {
    if ETAT.set(e).is_err() {
        panic!("état de la console déjà installé");
    }
}

pub fn etat() -> &'static Etat {
    ETAT.get().expect("état de la console non installé")
}

/// Espace libre et total du système de fichiers (statvfs).
pub fn disque(chemin: &str) -> Option<(u64, u64)> {
    #[cfg(unix)]
    {
        let c = std::ffi::CString::new(chemin).ok()?;
        let mut s = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        // SAFETY: `c` est une chaîne C valide et `s` un tampon de la taille de `statvfs`, rempli par l'appel.
        if unsafe { libc::statvfs(c.as_ptr(), s.as_mut_ptr()) } != 0 {
            return None;
        }
        // SAFETY: statvfs a réussi, la structure est initialisée.
        let s = unsafe { s.assume_init() };
        let bloc = s.f_frsize as u64;
        Some((s.f_blocks as u64 * bloc, s.f_bavail as u64 * bloc))
    }
    #[cfg(not(unix))]
    {
        let _ = chemin;
        None
    }
}
