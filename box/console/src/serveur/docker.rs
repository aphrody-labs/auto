//! Client minimal du Docker Engine par son socket Unix (HTTP/1.1 avec hyper) : conteneurs du projet compose,
//! redémarrage, journal et capacités de l'hôte. Aucun SDK : l'API HTTP du moteur suffit.
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq)]
pub struct Conteneur {
    pub id: String,
    pub service: String,
    pub etat: String,
    pub statut: String,
    pub sante: Option<&'static str>,
}

#[derive(Deserialize)]
struct ConteneurBrut {
    #[serde(rename = "Id")]
    id: String,
    #[serde(rename = "State")]
    state: String,
    #[serde(rename = "Status")]
    status: String,
    #[serde(rename = "Labels", default)]
    labels: HashMap<String, String>,
}

#[derive(Deserialize)]
struct InfoBrute {
    #[serde(rename = "NCPU")]
    ncpu: u64,
    #[serde(rename = "MemTotal")]
    mem_total: u64,
}

/// Santé lue dans le statut (« Up 2 minutes (healthy) ») : la liste ne la donne pas autrement.
pub fn sante(statut: &str) -> Option<&'static str> {
    if statut.contains("(healthy)") {
        Some("healthy")
    } else if statut.contains("(unhealthy)") {
        Some("unhealthy")
    } else if statut.contains("(health: starting)") {
        Some("starting")
    } else {
        None
    }
}

/// Flux multiplexé stdout/stderr (en-têtes de 8 octets) en texte ; un flux TTY est déjà brut.
pub fn demultiplexer(o: &[u8]) -> String {
    if o.len() < 8 || o[0] > 2 || o[1..4] != [0, 0, 0] {
        return String::from_utf8_lossy(o).into_owned();
    }
    let mut sortie = Vec::with_capacity(o.len());
    let mut i = 0;
    while i + 8 <= o.len() {
        let n = u32::from_be_bytes([o[i + 4], o[i + 5], o[i + 6], o[i + 7]]) as usize;
        let fin = (i + 8 + n).min(o.len());
        sortie.extend_from_slice(&o[i + 8..fin]);
        i = fin;
    }
    String::from_utf8_lossy(&sortie).into_owned()
}

pub struct Docker {
    socket: String,
    projet: String,
}

impl Docker {
    pub fn new(socket: impl Into<String>, projet: impl Into<String>) -> Self {
        Self { socket: socket.into(), projet: projet.into() }
    }

    #[cfg(unix)]
    async fn appel(&self, methode: &str, chemin: &str) -> Result<Vec<u8>, String> {
        use http_body_util::{BodyExt, Empty};
        use hyper::body::Bytes;
        let flux = tokio::net::UnixStream::connect(&self.socket)
            .await
            .map_err(|e| format!("socket Docker {} : {e}", self.socket))?;
        let (mut envoi, connexion) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(flux))
            .await
            .map_err(|e| e.to_string())?;
        tokio::spawn(connexion);
        let requete = hyper::Request::builder()
            .method(methode)
            .uri(chemin)
            .header(hyper::header::HOST, "docker")
            .body(Empty::<Bytes>::new())
            .map_err(|e| e.to_string())?;
        let reponse = tokio::time::timeout(std::time::Duration::from_secs(20), envoi.send_request(requete))
            .await
            .map_err(|_| "Docker ne répond pas".to_string())?
            .map_err(|e| e.to_string())?;
        let statut = reponse.status();
        let corps = reponse.into_body().collect().await.map_err(|e| e.to_string())?.to_bytes().to_vec();
        if !statut.is_success() {
            return Err(format!("Docker {statut} : {}", String::from_utf8_lossy(&corps).chars().take(200).collect::<String>()));
        }
        Ok(corps)
    }

    #[cfg(not(unix))]
    async fn appel(&self, _methode: &str, _chemin: &str) -> Result<Vec<u8>, String> {
        Err(format!("socket Docker {} : Unix uniquement", self.socket))
    }

    pub async fn conteneurs(&self) -> Result<Vec<Conteneur>, String> {
        let filtres = serde_json::json!({ "label": [format!("com.docker.compose.project={}", self.projet)] }).to_string();
        let chemin = format!("/containers/json?all=1&filters={}", encoder(&filtres));
        let liste: Vec<ConteneurBrut> = serde_json::from_slice(&self.appel("GET", &chemin).await?).map_err(|e| e.to_string())?;
        Ok(liste
            .into_iter()
            .map(|c| Conteneur {
                sante: sante(&c.status),
                service: c.labels.get("com.docker.compose.service").cloned().unwrap_or_default(),
                id: c.id,
                etat: c.state,
                statut: c.status,
            })
            .collect())
    }

    pub async fn redemarrer(&self, id: &str) -> Result<(), String> {
        self.appel("POST", &format!("/containers/{}/restart?t=10", encoder(id))).await.map(|_| ())
    }

    pub async fn journal(&self, id: &str, lignes: u32) -> Result<String, String> {
        let o = self.appel("GET", &format!("/containers/{}/logs?stdout=1&stderr=1&tail={lignes}", encoder(id))).await?;
        Ok(demultiplexer(&o))
    }

    pub async fn info(&self) -> Result<(u64, u64), String> {
        let i: InfoBrute = serde_json::from_slice(&self.appel("GET", "/info").await?).map_err(|e| e.to_string())?;
        Ok((i.ncpu, i.mem_total))
    }
}

/// Encodage d'URL des caractères hors [A-Za-z0-9-._~].
fn encoder(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sante_du_statut() {
        assert_eq!(sante("Up 3 minutes (healthy)"), Some("healthy"));
        assert_eq!(sante("Up 1 second (health: starting)"), Some("starting"));
        assert_eq!(sante("Exited (1) 2 hours ago"), None);
    }

    #[test]
    fn journal_multiplexe_et_brut() {
        let mut o = vec![1, 0, 0, 0, 0, 0, 0, 3];
        o.extend_from_slice(b"ab\n");
        o.extend_from_slice(&[2, 0, 0, 0, 0, 0, 0, 4]);
        o.extend_from_slice(b"err\n");
        assert_eq!(demultiplexer(&o), "ab\nerr\n");
        assert_eq!(demultiplexer(b"texte brut\n"), "texte brut\n");
    }

    #[test]
    fn encodage() {
        assert_eq!(encoder("{\"a\":1}"), "%7B%22a%22%3A1%7D");
    }
}
