//! Modèle des documents commerciaux, identique au JSON de `@auto/domain` (`Document` + `numero`,
//! en camelCase), et calcul des totaux à l'identique (arrondi de `Math.round`).

use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Partie {
    pub nom: String,
    #[serde(default)]
    pub siret: String,
    pub adresse: String,
    pub adresse_livraison: Option<String>,
    pub tva_intracom: Option<String>,
    pub email: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ligne {
    pub designation: String,
    pub quantite: f64,
    pub prix_unitaire_ht_cents: i64,
    /// Taux en dixièmes de pourcent : 200 = 20 %.
    pub tva: i64,
    pub unite: Option<String>,
    /// Remise en points de base : 1000 = 10 %.
    #[serde(default)]
    pub remise_bp: i64,
}

impl Ligne {
    /// HT brut, avant remise.
    pub fn brut_cents(&self) -> i64 {
        round_js(self.quantite * self.prix_unitaire_ht_cents as f64)
    }

    /// HT net : même ordre d'opérations que `htLigne` de @auto/domain.
    pub fn ht_cents(&self) -> i64 {
        round_js(self.quantite * self.prix_unitaire_ht_cents as f64 * (10000 - self.remise_bp) as f64 / 10000.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TypeDocument {
    Devis,
    Facture,
    Acompte,
    Avoir,
}

impl TypeDocument {
    /// Code UNTDID 1001 (factures seulement).
    pub fn code(self) -> Option<&'static str> {
        match self {
            TypeDocument::Devis => None,
            TypeDocument::Facture => Some("380"),
            TypeDocument::Acompte => Some("386"),
            TypeDocument::Avoir => Some("381"),
        }
    }

    pub fn libelle(self) -> &'static str {
        match self {
            TypeDocument::Devis => "Devis",
            TypeDocument::Facture => "Facture",
            TypeDocument::Acompte => "Facture d'acompte",
            TypeDocument::Avoir => "Avoir",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Facture {
    #[serde(default)]
    pub numero: String,
    #[serde(rename = "type")]
    pub type_: TypeDocument,
    pub date: String,
    pub emetteur: Partie,
    pub client: Partie,
    pub lignes: Vec<Ligne>,
    pub date_prestation: Option<String>,
    pub echeance: Option<String>,
    pub conditions_paiement: Option<String>,
    pub penalites_retard: Option<String>,
    pub escompte: Option<String>,
    #[serde(default)]
    pub franchise_tva: bool,
    pub origine: Option<String>,
    pub validite_jours: Option<u32>,
    pub notes: Option<String>,
    /// Mise en forme propre au tenant (couleur, logo, pied de page) ; absente : rendu neutre.
    #[serde(default)]
    pub gabarit: Option<Gabarit>,
}

/// Mise en forme d'un tenant. Le logo est un JPEG RVB (converti côté Bun), embarqué tel quel.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gabarit {
    /// Couleur d'accent « #RRGGBB ».
    pub couleur: Option<String>,
    pub logo: Option<Logo>,
    /// Ligne ajoutée au pied de page (capital, RCS, coordonnées bancaires…).
    pub pied_de_page: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Logo {
    /// JPEG encodé en base64.
    pub jpeg: String,
    pub largeur: u32,
    pub hauteur: u32,
}

impl Gabarit {
    /// Couleur d'accent en composantes 0..1 ; `None` si absente ou mal formée.
    pub fn rvb(&self) -> Option<(f64, f64, f64)> {
        let h = self.couleur.as_deref()?.strip_prefix('#')?;
        if h.len() != 6 {
            return None;
        }
        let c = |i: usize| u8::from_str_radix(h.get(i..i + 2)?, 16).ok().map(|v| f64::from(v) / 255.0);
        Some((c(0)?, c(2)?, c(4)?))
    }
}

/// Décodage base64 standard (avec ou sans remplissage) ; `None` si un caractère est invalide.
pub fn base64(s: &str) -> Option<Vec<u8>> {
    let val = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let octets: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace() && *c != b'=').collect();
    let mut out = Vec::with_capacity(octets.len() * 3 / 4);
    for bloc in octets.chunks(4) {
        let v: Vec<u8> = bloc.iter().map(|c| val(*c)).collect::<Option<_>>()?;
        if v.len() < 2 {
            return None;
        }
        let n = v.iter().enumerate().fold(0u32, |n, (i, x)| n | (u32::from(*x) << (18 - 6 * i)));
        out.extend_from_slice(&n.to_be_bytes()[1..v.len()]);
    }
    Some(out)
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Totaux {
    pub ht_cents: i64,
    /// Taux (dixièmes de %) → (base HT, TVA).
    pub par_taux: BTreeMap<i64, (i64, i64)>,
    pub tva_cents: i64,
    pub ttc_cents: i64,
}

/// `Math.round` de JavaScript (demi vers +∞), pour des totaux identiques à `@auto/domain`.
pub fn round_js(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

#[derive(Debug)]
pub struct ErreurJson(pub String);

impl std::fmt::Display for ErreurJson {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ErreurJson {}

pub const MENTION_FRANCHISE: &str = "TVA non applicable, art. 293 B du CGI";
pub const INDEMNITE: &str = "Indemnité forfaitaire pour frais de recouvrement en cas de retard de paiement : 40 €";

impl Facture {
    pub fn depuis_json(json: &str) -> Result<Self, ErreurJson> {
        serde_json::from_str(json).map_err(|e| ErreurJson(e.to_string()))
    }

    pub fn type_document(&self) -> TypeDocument {
        self.type_
    }

    pub fn totaux(&self) -> Totaux {
        let mut t = Totaux::default();
        for l in &self.lignes {
            t.par_taux.entry(l.tva).or_default().0 += l.ht_cents();
        }
        for (taux, (base, tva)) in t.par_taux.iter_mut() {
            *tva = round_js(*base as f64 * *taux as f64 / 1000.0);
            t.ht_cents += *base;
            t.tva_cents += *tva;
        }
        t.ttc_cents = t.ht_cents + t.tva_cents;
        t
    }
}

/// Centimes → « 1 234,50 € ».
pub fn eur(c: i64) -> String {
    let s = if c < 0 { "-" } else { "" };
    let e = (c.abs() / 100).to_string();
    let mut groupes = String::new();
    for (i, ch) in e.chars().enumerate() {
        if i > 0 && (e.len() - i).is_multiple_of(3) {
            groupes.push('\u{202F}');
        }
        groupes.push(ch);
    }
    format!("{s}{groupes},{:02} €", c.abs() % 100)
}

/// Dixièmes de % → « 20 % », « 5,5 % ».
pub fn pourcent(t: i64) -> String {
    if t % 10 == 0 { format!("{} %", t / 10) } else { format!("{},{} %", t / 10, t % 10) }
}

/// Points de base → « 10 % », « 12,5 % ».
pub fn pourcent_bp(bp: i64) -> String {
    let s = format!("{},{:02}", bp / 100, bp % 100);
    format!("{} %", s.trim_end_matches('0').trim_end_matches(','))
}

/// « 2026-10-22 » → « 22/10/2026 ».
pub fn date_fr(d: &str) -> String {
    let p: Vec<&str> = d.get(..10).unwrap_or(d).split('-').collect();
    match p.as_slice() {
        [a, m, j] => format!("{j}/{m}/{a}"),
        _ => d.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_fr() {
        assert_eq!(eur(123_456_789), "1\u{202F}234\u{202F}567,89 €");
        assert_eq!(eur(5), "0,05 €");
        assert_eq!(pourcent(55), "5,5 %");
        assert_eq!(pourcent(200), "20 %");
        assert_eq!(date_fr("2026-10-22"), "22/10/2026");
        assert_eq!(pourcent_bp(1000), "10 %");
        assert_eq!(pourcent_bp(1250), "12,5 %");
        assert_eq!(pourcent_bp(10000), "100 %");
        assert_eq!(pourcent_bp(5), "0,05 %");
    }
}

#[cfg(test)]
mod remises {
    use super::*;

    /// Mêmes valeurs que le test « remises identiques à auto-modele » de @auto/domain.
    #[test]
    fn totaux_avec_remises() {
        let l = |q: f64, pu: i64, bp: i64| Ligne {
            designation: String::new(),
            quantite: q,
            prix_unitaire_ht_cents: pu,
            tva: 200,
            unite: None,
            remise_bp: bp,
        };
        assert_eq!(l(3.0, 33333, 1250).ht_cents(), 87499);
        assert_eq!(l(1.5, 19999, 1000).ht_cents(), 26999);
        assert_eq!(l(7.0, 1999, 333).ht_cents(), 13527);
        assert_eq!(l(3.0, 33333, 1250).brut_cents(), 99999);
    }
}

#[cfg(test)]
mod tests_gabarit {
    use super::*;

    #[test]
    fn base64_et_couleur() {
        assert_eq!(base64("aGVsbG8=").as_deref(), Some(&b"hello"[..]));
        assert_eq!(base64("aGVsbG8").as_deref(), Some(&b"hello"[..]));
        assert_eq!(base64("/9j/").as_deref(), Some(&[0xFF, 0xD8, 0xFF][..]));
        assert_eq!(base64("a"), None);
        assert_eq!(base64("a$bc"), None);
        let g = Gabarit { couleur: Some("#0F6B5C".into()), ..Gabarit::default() };
        let (r, v, b) = g.rvb().expect("couleur");
        assert!((r - 15.0 / 255.0).abs() < 1e-9 && (v - 107.0 / 255.0).abs() < 1e-9 && (b - 92.0 / 255.0).abs() < 1e-9);
        assert_eq!(Gabarit { couleur: Some("vert".into()), ..Gabarit::default() }.rvb(), None);
    }
}
