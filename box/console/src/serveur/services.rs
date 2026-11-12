//! Catalogue des services de la boîte : ce que l'administrateur voit, où le service répond dans le réseau compose
//! (sonde) et où il s'ouvre depuis son navigateur (port publié, ou sous-domaine quand BOX_DOMAINE est défini).

pub struct Service {
    pub id: &'static str,
    pub nom: &'static str,
    pub role: &'static str,
    /// Service compose (étiquette com.docker.compose.service).
    pub conteneur: &'static str,
    /// URL interne sondée ; une réponse < 500 compte comme « répond ».
    pub sonde: Option<&'static str>,
    pub port: Option<u16>,
    pub https: bool,
    pub sous: Option<&'static str>,
    pub couleur: &'static str,
    pub technique: bool,
}

const fn app(
    id: &'static str,
    nom: &'static str,
    role: &'static str,
    conteneur: &'static str,
    sonde: &'static str,
    port: u16,
    sous: &'static str,
    couleur: &'static str,
) -> Service {
    Service {
        id,
        nom,
        role,
        conteneur,
        sonde: Some(sonde),
        port: Some(port),
        https: false,
        sous: Some(sous),
        couleur,
        technique: false,
    }
}

const fn coulisse(
    id: &'static str,
    nom: &'static str,
    role: &'static str,
    conteneur: &'static str,
    sonde: Option<&'static str>,
) -> Service {
    Service { id, nom, role, conteneur, sonde, port: None, https: false, sous: None, couleur: "#334155", technique: true }
}

pub const SERVICES: &[Service] = &[
    app(
        "auto",
        "Auto",
        "Vos automatisations, factures et devis. Créez votre compte à la première visite.",
        "auto-web",
        "http://auto-web:3001/",
        8081,
        "auto",
        "#0f766e",
    ),
    app(
        "n8n",
        "n8n",
        "Éditeur de workflows : plus de 400 applications connectées.",
        "n8n",
        "http://n8n:5678/healthz",
        5678,
        "n8n",
        "#c2255c",
    ),
    app(
        "hermes",
        "Hermes",
        "Assistant IA qui agit pour vous : mémoire, outils, Telegram, Discord, Slack.",
        "hermes",
        "http://hermes:9119/",
        9119,
        "agent",
        "#a16207",
    ),
    Service {
        https: true,
        ..app(
            "obsidian",
            "Obsidian",
            "Vos notes dans le navigateur, rangées dans le dossier « coffre » de la boîte.",
            "obsidian",
            "http://obsidian:3000/",
            3001,
            "notes",
            "#6d28d9",
        )
    },
    app(
        "courrier",
        "Courrier",
        "Les courriels envoyés par la boîte, lisibles ici tant qu'aucun relais n'est configuré.",
        "mailpit",
        "http://mailpit:8025/",
        8025,
        "courrier",
        "#1d4ed8",
    ),
    coulisse("ollama", "Ollama", "Modèles d'IA locaux", "ollama", Some("http://ollama:11434/api/version")),
    coulisse("api", "API Auto", "Serveur d'Auto", "auto-api", Some("http://auto-api:3000/health")),
    coulisse("worker", "Tâches Auto", "Exécutions planifiées", "auto-worker", None),
    coulisse("postgres", "Base de données", "PostgreSQL", "postgres", None),
    coulisse("caddy", "HTTPS", "Certificats et domaines", "caddy", None),
];

pub fn service(id: &str) -> Option<&'static Service> {
    SERVICES.iter().find(|s| s.id == id)
}

/// Lien « Ouvrir » : sous-domaine HTTPS derrière Caddy, sinon port publié sur l'hôte de la requête.
pub fn lien(s: &Service, domaine: Option<&str>, hote: &str) -> Option<String> {
    match (domaine, s.sous, s.port) {
        (Some(d), Some(sous), _) => Some(format!("https://{sous}.{d}")),
        (_, _, Some(port)) => Some(format!("{}://{hote}:{port}", if s.https { "https" } else { "http" })),
        _ => None,
    }
}

/// Nom d'hôte d'un en-tête Host (« 192.168.1.20:8080 », « [::1]:8080 ») ; seuls des caractères d'hôte passent.
pub fn nom_hote(host: &str) -> String {
    let h = if host.starts_with('[') {
        host.split_once(']').map(|(a, _)| format!("{a}]")).unwrap_or_default()
    } else {
        host.split(':').next().unwrap_or_default().to_string()
    };
    if !h.is_empty() && h.chars().all(|c| c.is_ascii_alphanumeric() || ".-[]:".contains(c)) { h } else { "localhost".into() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn liens() {
        let n8n = service("n8n").unwrap();
        assert_eq!(lien(n8n, None, "192.168.1.20").as_deref(), Some("http://192.168.1.20:5678"));
        assert_eq!(lien(n8n, Some("maboite.fr"), "x").as_deref(), Some("https://n8n.maboite.fr"));
        assert_eq!(lien(service("obsidian").unwrap(), None, "h").as_deref(), Some("https://h:3001"));
        assert_eq!(lien(service("postgres").unwrap(), None, "h"), None);
    }

    #[test]
    fn hotes() {
        assert_eq!(nom_hote("192.168.1.20:8080"), "192.168.1.20");
        assert_eq!(nom_hote("[::1]:8080"), "[::1]");
        assert_eq!(nom_hote("box.local"), "box.local");
        assert_eq!(nom_hote("evil\"><script>"), "localhost");
    }

    #[test]
    fn identifiants_uniques() {
        let mut ids: Vec<_> = SERVICES.iter().map(|s| s.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), SERVICES.len());
    }
}
