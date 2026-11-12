//! Session de l'administrateur : cookie `box_session=<expiration>.<HMAC-SHA256>`, HttpOnly et SameSite=Strict ;
//! limite de tentatives de connexion par adresse.
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const COOKIE: &str = "box_session";
pub const DUREE: u64 = 12 * 3600;

fn mac(secret: &str, valeur: &str) -> Hmac<Sha256> {
    let mut m = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepte toute longueur de clé");
    m.update(valeur.as_bytes());
    m
}

fn maintenant() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Valeur du cookie, valable `DUREE` secondes.
pub fn emettre(secret: &str) -> String {
    let exp = (maintenant() + DUREE).to_string();
    let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac(secret, &exp).finalize().into_bytes());
    format!("{exp}.{sig}")
}

/// Vérification en temps constant de la signature, puis de l'expiration.
pub fn valide(secret: &str, valeur: &str) -> bool {
    let Some((exp, sig)) = valeur.split_once('.') else { return false };
    let Ok(sig) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(sig) else { return false };
    mac(secret, exp).verify_slice(&sig).is_ok() && exp.parse::<u64>().is_ok_and(|e| e > maintenant())
}

/// Cookie de session de l'en-tête `Cookie`.
pub fn lire_cookie(entete: &str) -> Option<&str> {
    entete.split(';').map(str::trim).find_map(|c| c.strip_prefix(COOKIE)?.strip_prefix('='))
}

pub fn egal(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 10 tentatives par quart d'heure et par adresse.
#[derive(Default)]
pub struct Tentatives(Mutex<HashMap<IpAddr, (u32, Instant)>>);

const FENETRE: Duration = Duration::from_secs(15 * 60);

impl Tentatives {
    pub fn bloquee(&self, ip: IpAddr) -> bool {
        self.0.lock().unwrap().get(&ip).is_some_and(|(n, depuis)| *n >= 10 && depuis.elapsed() < FENETRE)
    }
    pub fn echec(&self, ip: IpAddr) {
        let mut t = self.0.lock().unwrap();
        let e = t.entry(ip).or_insert((0, Instant::now()));
        if e.1.elapsed() >= FENETRE {
            *e = (0, Instant::now());
        }
        e.0 += 1;
    }
    pub fn reussite(&self, ip: IpAddr) {
        self.0.lock().unwrap().remove(&ip);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_signee() {
        let v = emettre("secret-de-test-assez-long");
        assert!(valide("secret-de-test-assez-long", &v));
        assert!(!valide("autre-secret-assez-long", &v));
        let (exp, sig) = v.split_once('.').unwrap();
        assert!(!valide("secret-de-test-assez-long", &format!("{}.{sig}", exp.parse::<u64>().unwrap() + 1)));
        assert!(!valide("secret-de-test-assez-long", "1.abc"));
    }

    #[test]
    fn cookie_et_egalite() {
        assert_eq!(lire_cookie("a=1; box_session=x.y; b=2"), Some("x.y"));
        assert_eq!(lire_cookie("box_sessionx=1"), None);
        assert!(egal("abc", "abc"));
        assert!(!egal("abc", "abd"));
    }

    #[test]
    fn limite_de_tentatives() {
        let t = Tentatives::default();
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        for _ in 0..9 {
            t.echec(ip);
        }
        assert!(!t.bloquee(ip));
        t.echec(ip);
        assert!(t.bloquee(ip));
        t.reussite(ip);
        assert!(!t.bloquee(ip));
    }
}
