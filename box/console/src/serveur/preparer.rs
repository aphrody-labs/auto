//! Préparation d'une boîte : secrets tirés au hasard dans `.env` (les valeurs déjà présentes sont conservées),
//! configuration de Hermes branchée sur Ollama, coffre Obsidian ouvert d'office avec une note d'accueil.
//! `aphrody-box preparer /box [--gpu|--sans-gpu] [--email a@b.fr] [--domaine exemple.fr]`
use base64::Engine;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Default)]
pub struct Options {
    pub gpu: Option<bool>,
    pub email: Option<String>,
    pub domaine: Option<String>,
    /// Adresse de la machine vue des navigateurs (IP ou nom), pour les liens envoyés par courriel.
    pub hote: Option<String>,
    /// Utilisateur et groupe propriétaires des fichiers de la boîte (ceux du dossier ; 1000 si c'est root).
    pub proprietaire: Option<(u32, u32)>,
}

fn fixe(v: &'static str) -> impl Fn() -> String {
    move || v.to_string()
}

fn aleatoire(octets: usize) -> String {
    let mut o = vec![0u8; octets];
    getrandom::fill(&mut o).expect("source d'aléa du système");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(o)
}

/// Valeurs d'un `.env` (guillemets simples ou doubles retirés, commentaires ignorés).
pub fn lire_env(texte: &str) -> BTreeMap<String, String> {
    texte
        .lines()
        .filter_map(|l| {
            let (k, v) = l.trim().split_once('=')?;
            let k = k.trim();
            if k.is_empty() || k.starts_with('#') || !k.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_') {
                return None;
            }
            let v = v.trim();
            let v = v
                .strip_prefix('\'')
                .and_then(|v| v.strip_suffix('\''))
                .or_else(|| v.strip_prefix('"').and_then(|v| v.strip_suffix('"')))
                .unwrap_or(v);
            Some((k.to_string(), v.to_string()))
        })
        .collect()
}

/// Contenu du `.env` ; guillemets simples : compose n'interpole pas les `$` des empreintes bcrypt.
pub fn construire_env(existant: &BTreeMap<String, String>, o: &Options) -> String {
    let garder = |cle: &str, defaut: &dyn Fn() -> String| existant.get(cle).filter(|v| !v.is_empty()).cloned().unwrap_or_else(defaut);
    let n8n_mdp = garder("N8N_MOT_DE_PASSE", &|| aleatoire(12));
    let n8n_hash = match (existant.get("N8N_MOT_DE_PASSE"), existant.get("N8N_MOT_DE_PASSE_HASH")) {
        (Some(m), Some(h)) if *m == n8n_mdp && !h.is_empty() => h.clone(),
        _ => bcrypt::hash(&n8n_mdp, 10).expect("bcrypt"),
    };
    let compose = match o.gpu {
        Some(true) => "compose.yaml:compose.gpu.yaml".to_string(),
        Some(false) => "compose.yaml".to_string(),
        None => garder("COMPOSE_FILE", &fixe("compose.yaml")),
    };
    let cle_maitre = || {
        let mut o = [0u8; 32];
        getrandom::fill(&mut o).expect("source d'aléa du système");
        base64::engine::general_purpose::STANDARD.encode(o)
    };
    let domaine = o.domaine.clone().unwrap_or_else(|| existant.get("BOX_DOMAINE").cloned().unwrap_or_default());
    let hote = o.hote.clone().unwrap_or_else(|| garder("BOX_HOTE", &fixe("localhost")));
    let (url_auto, url_n8n) = if domaine.is_empty() {
        (format!("http://{hote}:8081"), format!("http://{hote}:5678/"))
    } else {
        (format!("https://auto.{domaine}"), format!("https://n8n.{domaine}/"))
    };
    let sections: Vec<(&str, Vec<(&str, String)>)> = vec![
        (
            "Accès",
            vec![
                ("BOX_ECOUTE", garder("BOX_ECOUTE", &fixe("0.0.0.0"))),
                ("BOX_DOMAINE", domaine.clone()),
                ("BOX_HOTE", hote),
                ("BOX_EMAIL", o.email.clone().unwrap_or_else(|| garder("BOX_EMAIL", &fixe("admin@box.local")))),
                ("BOX_ADMIN_UTILISATEUR", garder("BOX_ADMIN_UTILISATEUR", &fixe("admin"))),
                ("BOX_ADMIN_MOT_DE_PASSE", garder("BOX_ADMIN_MOT_DE_PASSE", &|| aleatoire(12))),
                ("BOX_SECRET", garder("BOX_SECRET", &|| aleatoire(32))),
            ],
        ),
        (
            "Modèles d'IA téléchargés au premier démarrage",
            vec![
                ("BOX_MODELE", garder("BOX_MODELE", &fixe("qwen3:4b"))),
                ("BOX_MODELE_EMBEDDINGS", garder("BOX_MODELE_EMBEDDINGS", &fixe("nomic-embed-text"))),
            ],
        ),
        (
            "Secrets des services (ne pas partager)",
            vec![
                ("BOX_PG_MOT_DE_PASSE", garder("BOX_PG_MOT_DE_PASSE", &|| aleatoire(24))),
                ("AUTO_CLE_MAITRE", garder("AUTO_CLE_MAITRE", &cle_maitre)),
                ("N8N_CLE_CHIFFREMENT", garder("N8N_CLE_CHIFFREMENT", &|| aleatoire(32))),
                ("N8N_MOT_DE_PASSE", n8n_mdp.clone()),
                ("N8N_MOT_DE_PASSE_HASH", n8n_hash),
                ("HERMES_MOT_DE_PASSE", garder("HERMES_MOT_DE_PASSE", &|| aleatoire(12))),
                ("HERMES_SECRET", garder("HERMES_SECRET", &|| aleatoire(32))),
                ("HERMES_CLE_API", garder("HERMES_CLE_API", &|| aleatoire(24))),
                ("OBSIDIAN_MOT_DE_PASSE", garder("OBSIDIAN_MOT_DE_PASSE", &|| aleatoire(12))),
            ],
        ),
        (
            "Relais de courriel réel (facultatif ; par défaut, courriels lisibles dans « Courrier »)",
            vec![
                ("AUTO_SMTP_HOTE", garder("AUTO_SMTP_HOTE", &fixe("mailpit"))),
                ("AUTO_SMTP_PORT", garder("AUTO_SMTP_PORT", &fixe("1025"))),
                ("AUTO_SMTP_SECURITE", garder("AUTO_SMTP_SECURITE", &fixe("aucune"))),
                ("AUTO_SMTP_UTILISATEUR", existant.get("AUTO_SMTP_UTILISATEUR").cloned().unwrap_or_default()),
                ("AUTO_SMTP_MOT_DE_PASSE", existant.get("AUTO_SMTP_MOT_DE_PASSE").cloned().unwrap_or_default()),
            ],
        ),
        (
            "Adresses publiques (déduites de BOX_DOMAINE et BOX_HOTE à chaque préparation)",
            vec![
                ("BOX_URL_AUTO", url_auto),
                ("BOX_URL_N8N", url_n8n),
                ("BOX_COOKIES_SECURISES", (!domaine.is_empty()).to_string()),
                ("COMPOSE_PROFILES", if domaine.is_empty() { String::new() } else { "https".into() }),
                ("BOX_UID", o.proprietaire.map_or_else(|| garder("BOX_UID", &fixe("1000")), |(u, _)| u.to_string())),
                ("BOX_GID", o.proprietaire.map_or_else(|| garder("BOX_GID", &fixe("1000")), |(_, g)| g.to_string())),
            ],
        ),
        (
            "Fichiers compose (carte graphique NVIDIA : compose.yaml:compose.gpu.yaml)",
            vec![("COMPOSE_FILE", compose), ("COMPOSE_PATH_SEPARATOR", ":".into())],
        ),
    ];
    let connues: Vec<&str> = sections.iter().flat_map(|(_, v)| v.iter().map(|(k, _)| *k)).collect();
    let autres: Vec<(&str, String)> =
        existant.iter().filter(|(k, _)| !connues.contains(&k.as_str())).map(|(k, v)| (k.as_str(), v.clone())).collect();
    let mut texte = String::from("# Aphrody Box : généré par `aphrody-box preparer`, vos modifications sont conservées.\n");
    for (titre, valeurs) in sections.iter().chain(std::iter::once(&("Ajouts", autres))) {
        if valeurs.is_empty() {
            continue;
        }
        texte.push_str(&format!("\n# {titre}\n"));
        for (k, v) in valeurs {
            texte.push_str(&format!("{k}='{}'\n", v.replace('\'', "")));
        }
    }
    texte
}

pub fn config_hermes(modele: &str) -> String {
    format!(
        "# Configuration de Hermes préparée par la boîte : modèle local servi par Ollama.
# Installez d'autres modèles depuis la console (Modèles d'IA), puis changez-le ici ou avec `hermes model`.
model:
  provider: custom
  default: {modele}
  base_url: http://ollama:11434/v1
  api_key: none
  # Hermes exige au moins 64 000 jetons : Ollama sert la même fenêtre (OLLAMA_CONTEXT_LENGTH du compose).
  context_length: 65536

# Tâches auxiliaires (compression, vision, compétences, MCP) sur le même modèle local, sans service extérieur.
auxiliary:
  compression:
    provider: main
  vision:
    provider: main
  skills_hub:
    provider: main
  mcp:
    provider: main
"
    )
}

const ACCUEIL: &str = "# Bienvenue dans votre coffre

Ce dossier est le coffre Obsidian de la boîte. Il est aussi lisible :

- par **Hermes**, dans `/opt/data/coffre` : demandez-lui de résumer ou de ranger vos notes ;
- par **n8n**, dans `/coffre` : un workflow peut y écrire un compte rendu chaque soir.

Sur la machine qui héberge la boîte, ce sont de simples fichiers Markdown du dossier `coffre`.
";

fn ecrire_si_absent(chemin: &Path, contenu: &str) -> std::io::Result<()> {
    if chemin.exists() {
        return Ok(());
    }
    if let Some(p) = chemin.parent() {
        std::fs::create_dir_all(p)?;
    }
    std::fs::write(chemin, contenu)
}

/// Propriétaire du dossier de la boîte ; root (préparateur lancé dans un conteneur sans correspondance
/// d'utilisateurs, Docker Desktop) devient 1000, l'utilisateur des images Hermes, Obsidian et n8n.
fn proprietaire(dossier: &Path) -> (u32, u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let Ok(m) = std::fs::metadata(dossier)
            && m.uid() != 0
        {
            return (m.uid(), m.gid());
        }
    }
    let _ = dossier;
    (1000, 1000)
}

/// Rend `chemin` (récursivement) à `(uid, gid)` ; sans effet hors Unix ou sans droit de changer de propriétaire.
fn rendre(chemin: &Path, (uid, gid): (u32, u32)) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        if !chemin.exists() {
            return Ok(());
        }
        match std::os::unix::fs::lchown(chemin, Some(uid), Some(gid)) {
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => return Ok(()),
            r => r?,
        }
        if chemin.is_dir() && !chemin.is_symlink() {
            for e in std::fs::read_dir(chemin)? {
                rendre(&e?.path(), (uid, gid))?;
            }
        }
    }
    #[cfg(not(unix))]
    let _ = (chemin, uid, gid);
    Ok(())
}

pub fn preparer(dossier: &Path, o: &Options) -> std::io::Result<BTreeMap<String, String>> {
    let qui = o.proprietaire.unwrap_or_else(|| proprietaire(dossier));
    let o = &Options { proprietaire: Some(qui), gpu: o.gpu, email: o.email.clone(), domaine: o.domaine.clone(), hote: o.hote.clone() };
    let fichier = dossier.join(".env");
    let existant = std::fs::read_to_string(&fichier).map(|t| lire_env(&t)).unwrap_or_default();
    let env = construire_env(&existant, o);
    std::fs::write(&fichier, &env)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fichier, std::fs::Permissions::from_mode(0o600))?;
    }
    let v = lire_env(&env);
    ecrire_si_absent(&dossier.join("donnees/hermes/config.yaml"), &config_hermes(&v["BOX_MODELE"]))?;
    // Coffre déjà enregistré et ouvert : Obsidian démarre dessus au lieu du sélecteur de coffres.
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    ecrire_si_absent(
        &dossier.join("donnees/obsidian/.config/obsidian/obsidian.json"),
        &format!("{{\"vaults\":{{\"coffre\":{{\"path\":\"/config/Coffre\",\"ts\":{ts},\"open\":true}}}}}}\n"),
    )?;
    ecrire_si_absent(&dossier.join("coffre/.obsidian/app.json"), "{\"promptDelete\":true}\n")?;
    ecrire_si_absent(&dossier.join("coffre/Bienvenue.md"), ACCUEIL)?;
    for chemin in [".env", "donnees", "coffre"] {
        rendre(&dossier.join(chemin), qui)?;
    }
    // Coffre partagé avec n8n (utilisateur 1000, membre du groupe de la boîte) : écriture par le groupe.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dossier.join("coffre"), std::fs::Permissions::from_mode(0o2775))?;
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_complet_puis_conserve() {
        let premier = construire_env(&BTreeMap::new(), &Options { email: Some("moi@exemple.fr".into()), ..Default::default() });
        let v = lire_env(&premier);
        assert_eq!(v["BOX_EMAIL"], "moi@exemple.fr");
        assert_eq!(v["COMPOSE_FILE"], "compose.yaml");
        assert!(v["BOX_SECRET"].len() >= 40);
        assert!(bcrypt::verify(&v["N8N_MOT_DE_PASSE"], &v["N8N_MOT_DE_PASSE_HASH"]).unwrap());
        assert!(premier.contains("N8N_MOT_DE_PASSE_HASH='$2b$10$"));

        let mut modifie = v.clone();
        modifie.insert("BOX_MODELE".into(), "llama3.2:3b".into());
        modifie.insert("MA_VARIABLE".into(), "x".into());
        let second = lire_env(&construire_env(&modifie, &Options { gpu: Some(true), ..Default::default() }));
        for cle in ["BOX_SECRET", "BOX_ADMIN_MOT_DE_PASSE", "N8N_MOT_DE_PASSE_HASH", "AUTO_CLE_MAITRE", "BOX_EMAIL"] {
            assert_eq!(second[cle], v[cle], "{cle}");
        }
        assert_eq!(second["BOX_MODELE"], "llama3.2:3b");
        assert_eq!(second["MA_VARIABLE"], "x");
        assert_eq!(second["COMPOSE_FILE"], "compose.yaml:compose.gpu.yaml");
        assert_eq!((second["BOX_UID"].as_str(), second["BOX_GID"].as_str()), ("1000", "1000"));
        let tiers = lire_env(&construire_env(&second, &Options { proprietaire: Some((1001, 1002)), ..Default::default() }));
        assert_eq!((tiers["BOX_UID"].as_str(), tiers["BOX_GID"].as_str()), ("1001", "1002"));
    }

    #[test]
    fn lecture_env() {
        let v = lire_env("# c\nA='1'\nB=\"deux\"\nC=trois\nminuscule=x\n");
        assert_eq!((v["A"].as_str(), v["B"].as_str(), v["C"].as_str()), ("1", "deux", "trois"));
        assert!(!v.contains_key("minuscule"));
    }

    #[test]
    fn dossier_prepare() {
        let d = std::env::temp_dir().join(format!("aphrody-box-{}", aleatoire(6)));
        std::fs::create_dir_all(&d).unwrap();
        let v = preparer(&d, &Options::default()).unwrap();
        assert!(std::fs::read_to_string(d.join("donnees/hermes/config.yaml")).unwrap().contains(&v["BOX_MODELE"]));
        assert!(d.join("coffre/Bienvenue.md").exists());
        let avant = std::fs::read_to_string(d.join(".env")).unwrap();
        preparer(&d, &Options::default()).unwrap();
        assert_eq!(lire_env(&avant), lire_env(&std::fs::read_to_string(d.join(".env")).unwrap()));
        std::fs::remove_dir_all(&d).unwrap();
    }
}
