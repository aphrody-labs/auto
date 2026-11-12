//! Rendu PDF A4 d'un devis, d'une facture, d'un acompte ou d'un avoir : en-têtes émetteur et
//! client, tableau paginé, totaux par taux de TVA, mentions légales, pied de page numéroté.
//! Polices Inter (OFL) embarquées : la sortie peut être convertie en PDF/A-3b pour Factur-X.

use auto_modele::{Facture, INDEMNITE, MENTION_FRANCHISE, TypeDocument, date_fr, eur, pourcent};
use pdfcraft_cos::{Dict, Document, ObjRef, Object, PdfString, SaveOptions, Stream, write_full};
use pdfcraft_fonts::pdf::Metrics;
use std::fmt::Write;

static INTER: &[u8] = include_bytes!("../../../vendor/suite/assets/pdfcraft/fonts/Inter-Regular.ttf");
static INTER_SEMIBOLD: &[u8] =
    include_bytes!("../../../vendor/suite/assets/pdfcraft/fonts/Inter-SemiBold.ttf");

const L: f64 = 595.28;
const H: f64 = 841.89;
const MARGE: f64 = 42.0;
const BAS: f64 = 64.0;

#[derive(Debug, thiserror::Error)]
pub enum Erreur {
    #[error("PDF : {0}")]
    Pdf(#[from] pdfcraft_cos::CosError),
    #[error("rendu : {0}")]
    Rendu(String),
}

struct Police {
    res: String,
    m: Metrics,
}

impl Police {
    fn hex(&self, s: &str) -> String {
        let bytes = self.m.encode(s).unwrap_or_else(|| {
            s.chars()
                .flat_map(|c| self.m.encode(&c.to_string()).or_else(|| self.m.encode("?")).unwrap_or_default())
                .collect()
        });
        bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut o, b| {
            let _ = write!(o, "{b:02X}");
            o
        })
    }

    fn largeur(&self, s: &str, taille: f64) -> f64 {
        let bytes = self.m.encode(s).unwrap_or_default();
        self.m.codes(&bytes).into_iter().map(|(c, _)| self.m.width(c)).sum::<f64>() * taille
    }

    /// Découpe en lignes de largeur ≤ `max` (mots longs coupés).
    fn couper(&self, texte: &str, taille: f64, max: f64) -> Vec<String> {
        let mut lignes = Vec::new();
        for para in texte.split('\n') {
            let mut cur = String::new();
            for mot in para.split_whitespace() {
                let essai = if cur.is_empty() { mot.to_string() } else { format!("{cur} {mot}") };
                if self.largeur(&essai, taille) <= max {
                    cur = essai;
                    continue;
                }
                if !cur.is_empty() {
                    lignes.push(std::mem::take(&mut cur));
                }
                let mut morceau = String::new();
                for c in mot.chars() {
                    morceau.push(c);
                    if self.largeur(&morceau, taille) > max {
                        morceau.pop();
                        lignes.push(std::mem::take(&mut morceau));
                        morceau.push(c);
                    }
                }
                cur = morceau;
            }
            lignes.push(cur);
        }
        lignes
    }
}

struct Page {
    ops: String,
}

struct Rendu {
    reg: Police,
    sb: Police,
    pages: Vec<Page>,
    y: f64,
    /// Couleur d'accent du gabarit (composantes 0..1).
    accent: Option<(f64, f64, f64)>,
}

/// Style de texte : semi-gras, taille (pt), niveau de gris (0 = noir).
#[derive(Clone, Copy)]
struct St(bool, f64, f64);

#[derive(Clone, Copy)]
enum Align {
    Gauche,
    Droite,
}

impl Rendu {
    fn page(&mut self) -> &mut String {
        &mut self.pages.last_mut().expect("au moins une page").ops
    }

    fn texte(&mut self, St(gras, taille, gris): St, x: f64, y: f64, align: Align, s: &str) {
        let p = if gras { &self.sb } else { &self.reg };
        let x = match align {
            Align::Gauche => x,
            Align::Droite => x - p.largeur(s, taille),
        };
        let (res, hex) = (p.res.clone(), p.hex(s));
        let _ = writeln!(self.page(), "BT {gris:.2} g /{res} {taille} Tf 1 0 0 1 {x:.2} {y:.2} Tm <{hex}> Tj ET");
    }

    /// Fond teinté : 12 % de l'accent sur blanc, sinon gris clair.
    fn fond(&mut self, x: f64, y: f64, w: f64, h: f64) {
        match self.accent {
            Some((r, g, b)) => {
                let t = |c: f64| 1.0 - 0.12 * (1.0 - c);
                let _ =
                    writeln!(self.page(), "{:.3} {:.3} {:.3} rg {x:.2} {y:.2} {w:.2} {h:.2} re f", t(r), t(g), t(b));
            }
            None => self.rect(0.93, x, y, w, h),
        }
    }

    fn rect(&mut self, gris: f64, x: f64, y: f64, w: f64, h: f64) {
        let _ = writeln!(self.page(), "{gris:.2} g {x:.2} {y:.2} {w:.2} {h:.2} re f");
    }

    fn trait_h(&mut self, x1: f64, x2: f64, y: f64) {
        let _ = writeln!(self.page(), "0.75 G 0.5 w {x1:.2} {y:.2} m {x2:.2} {y:.2} l S");
    }

    fn nouvelle_page(&mut self) {
        self.pages.push(Page { ops: String::new() });
        self.y = H - MARGE;
    }

    /// Bloc de lignes (gauche) ; renvoie le y sous le bloc.
    fn bloc(&mut self, x: f64, mut y: f64, max: f64, lignes: &[(bool, f64, String)]) -> f64 {
        for (gras, taille, t) in lignes {
            let p = if *gras { &self.sb } else { &self.reg };
            for l in p.couper(t, *taille, max) {
                self.texte(St(*gras, *taille, 0.0), x, y, Align::Gauche, &l);
                y -= taille * 1.35;
            }
        }
        y
    }
}

// Colonnes du tableau : désignation | qté | PU HT | TVA | total HT (bords droits).
const C_DESIGNATION: f64 = MARGE + 6.0;
const C_QTE: f64 = 352.0;
const C_PU: f64 = 432.0;
const C_TVA: f64 = 478.0;
const C_TOTAL: f64 = L - MARGE - 6.0;

fn quantite(q: f64) -> String {
    let s = format!("{q:.3}");
    s.trim_end_matches('0').trim_end_matches('.').replace('.', ",")
}

fn embarquer(doc: &mut Document, fonts: &mut Dict, bytes: &[u8], famille: &str) -> Result<Police, Erreur> {
    let res = pdfcraft_fonts::embedding::embed(doc, fonts, bytes, famille).map_err(Erreur::Rendu)?;
    let d = doc.dict(fonts.get(res.as_bytes()).ok_or_else(|| Erreur::Rendu("police absente".into()))?);
    let m = Metrics::from_dict(doc, &d.ok_or_else(|| Erreur::Rendu("police illisible".into()))?);
    Ok(Police { res, m })
}

/// PDF A4 du document. `numero` vide : brouillon.
pub fn rendre(f: &Facture) -> Result<Vec<u8>, Erreur> {
    let mut doc = pdfcraft_create::blank(L, H, 1).map_err(|e| Erreur::Rendu(e.to_string()))?;
    let mut fonts = Dict::new();
    let reg = embarquer(&mut doc, &mut fonts, INTER, "Inter")?;
    let sb = embarquer(&mut doc, &mut fonts, INTER_SEMIBOLD, "Inter-SemiBold")?;
    let gabarit = f.gabarit.clone().unwrap_or_default();
    let mut r = Rendu { reg, sb, pages: vec![Page { ops: String::new() }], y: H - MARGE, accent: gabarit.rvb() };
    let mut xobjets = Dict::new();
    // Logo en haut à gauche : 48 pt de haut au plus, 160 pt de large au plus.
    let mut haut_logo = 0.0;
    if let Some(l) = &gabarit.logo {
        let jpeg = auto_modele::base64(&l.jpeg).ok_or_else(|| Erreur::Rendu("logo : base64 invalide".into()))?;
        if l.largeur == 0 || l.hauteur == 0 || !jpeg.starts_with(&[0xFF, 0xD8]) {
            return Err(Erreur::Rendu("logo : JPEG attendu".into()));
        }
        let mut d = Dict::new();
        d.set(b"Type".to_vec(), Object::name("XObject"));
        d.set(b"Subtype".to_vec(), Object::name("Image"));
        d.set(b"Width".to_vec(), Object::Int(i64::from(l.largeur)));
        d.set(b"Height".to_vec(), Object::Int(i64::from(l.hauteur)));
        d.set(b"ColorSpace".to_vec(), Object::name("DeviceRGB"));
        d.set(b"BitsPerComponent".to_vec(), Object::Int(8));
        d.set(b"Filter".to_vec(), Object::name("DCTDecode"));
        let img = doc.add(Object::Stream(Stream::from_raw(d, jpeg)));
        xobjets.set(b"Logo".to_vec(), Object::Ref(img));
        let ratio = f64::from(l.largeur) / f64::from(l.hauteur);
        let (h, w) = if 48.0 * ratio > 160.0 { (160.0 / ratio, 160.0) } else { (48.0, 48.0 * ratio) };
        let _ = writeln!(r.page(), "q {w:.2} 0 0 {h:.2} {MARGE:.2} {:.2} cm /Logo Do Q", H - MARGE - h);
        haut_logo = h + 12.0;
    }
    let t = f.totaux();
    let est_facture = f.type_ != TypeDocument::Devis;

    // En-tête : émetteur à gauche, titre et dates à droite.
    let e = &f.emetteur;
    let mut lignes = vec![(true, 13.0, e.nom.clone()), (false, 9.0, e.adresse.clone())];
    if !e.siret.is_empty() {
        lignes.push((false, 9.0, format!("SIRET : {}", e.siret)));
    }
    if let Some(tva) = e.tva_intracom.as_deref().filter(|s| !s.is_empty()) {
        lignes.push((false, 9.0, format!("N° TVA : {tva}")));
    }
    if let Some(m) = e.email.as_deref().filter(|s| !s.is_empty()) {
        lignes.push((false, 9.0, m.to_string()));
    }
    let y_gauche = r.bloc(MARGE, H - MARGE - 6.0 - haut_logo, 250.0, &lignes);

    let x_droite = 330.0;
    let numero = if f.numero.is_empty() { "brouillon".to_string() } else { f.numero.clone() };
    let mut y = H - MARGE - 10.0;
    r.texte(St(true, 18.0, 0.0), x_droite, y, Align::Gauche, f.type_.libelle());
    if let Some((cr, cg, cb)) = r.accent {
        // Filet d'accent sous le titre.
        let _ = writeln!(
            r.page(),
            "{cr:.3} {cg:.3} {cb:.3} RG 1.5 w {x_droite:.2} {:.2} m {:.2} {:.2} l S",
            y - 6.0,
            L - MARGE,
            y - 6.0
        );
    }
    y -= 18.0;
    r.texte(St(false, 10.0, 0.0), x_droite, y, Align::Gauche, &format!("N° {numero}"));
    y -= 14.0;
    let mut dates = vec![format!("Date : {}", date_fr(&f.date))];
    if let Some(d) = &f.date_prestation {
        dates.push(format!("Date de prestation : {}", date_fr(d)));
    }
    if let (true, Some(d)) = (est_facture, &f.echeance) {
        dates.push(format!("Échéance : {}", date_fr(d)));
    }
    if let (TypeDocument::Devis, Some(j)) = (f.type_, f.validite_jours) {
        dates.push(format!("Validité : {j} jours"));
    }
    if let (TypeDocument::Avoir, Some(o)) = (f.type_, &f.origine) {
        dates.push(format!("Avoir sur la facture {o}"));
    }
    for d in dates {
        r.texte(St(false, 9.0, 0.25), x_droite, y, Align::Gauche, &d);
        y -= 12.0;
    }

    // Client.
    let c = &f.client;
    let y_client = y.min(y_gauche) - 16.0;
    r.texte(St(false, 8.0, 0.45), x_droite, y_client, Align::Gauche, "CLIENT");
    let mut lc = vec![(true, 10.5, c.nom.clone()), (false, 9.0, c.adresse.clone())];
    if let Some(a) = c.adresse_livraison.as_deref().filter(|s| !s.is_empty()) {
        lc.push((false, 9.0, format!("Livraison : {a}")));
    }
    if !c.siret.is_empty() {
        lc.push((false, 9.0, format!("SIRET : {}", c.siret)));
    }
    if let Some(tva) = c.tva_intracom.as_deref().filter(|s| !s.is_empty()) {
        lc.push((false, 9.0, format!("N° TVA : {tva}")));
    }
    r.y = r.bloc(x_droite, y_client - 14.0, L - MARGE - x_droite, &lc) - 22.0;

    // Tableau.
    let entete = |r: &mut Rendu| {
        let y = r.y;
        r.fond(MARGE, y - 6.0, L - 2.0 * MARGE, 20.0);
        for (x, a, s) in [
            (C_DESIGNATION, Align::Gauche, "Désignation"),
            (C_QTE, Align::Droite, "Qté"),
            (C_PU, Align::Droite, "PU HT"),
            (C_TVA, Align::Droite, "TVA"),
            (C_TOTAL, Align::Droite, "Total HT"),
        ] {
            r.texte(St(true, 8.5, 0.2), x, y, a, s);
        }
        r.y -= 24.0;
    };
    entete(&mut r);
    for l in &f.lignes {
        let mut texte = l.designation.clone();
        if let Some(u) = l.unite.as_deref().filter(|s| !s.is_empty()) {
            texte = format!("{texte} ({u})");
        }
        if l.remise_bp > 0 {
            texte = format!("{texte} — remise {}", auto_modele::pourcent_bp(l.remise_bp));
        }
        let lignes = r.reg.couper(&texte, 9.5, C_QTE - 60.0 - C_DESIGNATION);
        let hauteur = lignes.len() as f64 * 12.5 + 9.0;
        if r.y - hauteur < BAS {
            r.nouvelle_page();
            entete(&mut r);
        }
        let y0 = r.y;
        for (i, s) in lignes.iter().enumerate() {
            r.texte(St(false, 9.5, 0.0), C_DESIGNATION, y0 - i as f64 * 12.5, Align::Gauche, s);
        }
        r.texte(St(false, 9.5, 0.0), C_QTE, y0, Align::Droite, &quantite(l.quantite));
        r.texte(St(false, 9.5, 0.0), C_PU, y0, Align::Droite, &eur(l.prix_unitaire_ht_cents));
        let taux = if f.franchise_tva { "—".to_string() } else { pourcent(l.tva) };
        r.texte(St(false, 9.5, 0.0), C_TVA, y0, Align::Droite, &taux);
        r.texte(St(false, 9.5, 0.0), C_TOTAL, y0, Align::Droite, &eur(l.ht_cents()));
        // Filet sous la dernière ligne de texte (descendantes comprises).
        r.trait_h(MARGE, L - MARGE, y0 - (lignes.len() as f64 - 1.0) * 12.5 - 5.5);
        r.y -= hauteur;
    }

    // Totaux.
    let n_taux = if f.franchise_tva { 0 } else { t.par_taux.len() };
    let besoin = 30.0 + 14.0 * (n_taux as f64 + 2.0);
    if r.y - besoin < BAS {
        r.nouvelle_page();
    }
    r.y -= 10.0;
    let x_lib = 380.0;
    let ligne_total = |r: &mut Rendu, gras: bool, lib: &str, val: &str| {
        let y = r.y;
        r.texte(St(gras, 9.5, 0.0), x_lib, y, Align::Gauche, lib);
        r.texte(St(gras, 9.5, 0.0), C_TOTAL, y, Align::Droite, val);
        r.y -= 14.0;
    };
    ligne_total(&mut r, false, "Total HT", &eur(t.ht_cents));
    if !f.franchise_tva {
        for (taux, (base, tva)) in &t.par_taux {
            ligne_total(&mut r, false, &format!("TVA {} sur {}", pourcent(*taux), eur(*base)), &eur(*tva));
        }
    }
    let y = r.y + 4.0;
    r.fond(x_lib - 6.0, y - 14.0, L - MARGE - x_lib + 6.0, 18.0);
    let lib_ttc = if f.type_ == TypeDocument::Avoir { "Total TTC à déduire" } else { "Total TTC" };
    ligne_total(&mut r, true, lib_ttc, &eur(t.ttc_cents));

    // Mentions.
    let mut mentions: Vec<(bool, f64, String)> = Vec::new();
    if f.franchise_tva {
        mentions.push((false, 8.5, MENTION_FRANCHISE.into()));
    }
    if let Some(c) = &f.conditions_paiement {
        mentions.push((false, 8.5, format!("Conditions de paiement : {c}")));
    }
    if est_facture {
        if let Some(p) = &f.penalites_retard {
            mentions.push((false, 8.5, format!("Pénalités de retard : {p}")));
        }
        mentions.push((false, 8.5, INDEMNITE.into()));
        if let Some(e) = &f.escompte {
            mentions.push((false, 8.5, format!("Escompte : {e}")));
        }
    } else {
        mentions.push((false, 8.5, "Bon pour accord : date, signature et mention « Bon pour accord »".into()));
    }
    if let Some(n) = f.notes.as_deref().filter(|s| !s.is_empty()) {
        mentions.push((false, 8.5, n.to_string()));
    }
    let hauteur: usize = mentions.iter().map(|(_, s, t)| r.reg.couper(t, *s, L - 2.0 * MARGE).len()).sum();
    if r.y - 20.0 - hauteur as f64 * 11.5 < BAS {
        r.nouvelle_page();
    }
    let y = r.y - 14.0;
    r.y = r.bloc(MARGE, y, L - 2.0 * MARGE, &mentions);

    // Pieds de page.
    let n = r.pages.len();
    for i in 0..n {
        let pied = format!("{} — SIRET {} — {} {} — page {}/{}", e.nom, e.siret, f.type_.libelle(), numero, i + 1, n);
        let largeur = r.reg.largeur(&pied, 7.5);
        let (res, hex) = (r.reg.res.clone(), r.reg.hex(&pied));
        let _ =
            writeln!(r.pages[i].ops, "BT 0.45 g /{res} 7.5 Tf 1 0 0 1 {:.2} 30 Tm <{hex}> Tj ET", (L - largeur) / 2.0);
        if let Some(p) = gabarit.pied_de_page.as_deref().filter(|s| !s.is_empty()) {
            let largeur = r.reg.largeur(p, 7.5);
            let (res, hex) = (r.reg.res.clone(), r.reg.hex(p));
            let _ = writeln!(
                r.pages[i].ops,
                "BT 0.45 g /{res} 7.5 Tf 1 0 0 1 {:.2} 40 Tm <{hex}> Tj ET",
                ((L - largeur) / 2.0).max(MARGE)
            );
        }
    }

    assembler(doc, fonts, xobjets, r.pages, &format!("{} {numero}", f.type_.libelle()), &e.nom)
}

fn assembler(
    mut doc: Document,
    fonts: Dict,
    xobjets: Dict,
    pages: Vec<Page>,
    titre: &str,
    auteur: &str,
) -> Result<Vec<u8>, Erreur> {
    let premiere =
        pdfcraft_model::pages(&doc).into_iter().next().ok_or_else(|| Erreur::Rendu("page absente".into()))?;
    let parent: ObjRef = match premiere.dict.get(b"Parent") {
        Some(Object::Ref(p)) => *p,
        _ => return Err(Erreur::Rendu("arbre de pages illisible".into())),
    };
    let mut res = Dict::new();
    res.set(b"Font".to_vec(), Object::Dict(fonts));
    if !xobjets.is_empty() {
        res.set(b"XObject".to_vec(), Object::Dict(xobjets));
    }
    let res = doc.add(Object::Dict(res));
    let mut kids = vec![Object::Ref(premiere.obj)];
    for (i, p) in pages.into_iter().enumerate() {
        let contenu = doc.add(Object::Stream(Stream::flate(Dict::new(), p.ops.as_bytes())));
        if i == 0 {
            doc.update_dict(premiere.obj, |d| {
                d.set(b"Resources".to_vec(), Object::Ref(res));
                d.set(b"Contents".to_vec(), Object::Ref(contenu));
            })?;
            continue;
        }
        let mut d = Dict::new();
        d.set(b"Type".to_vec(), Object::name("Page"));
        d.set(b"Parent".to_vec(), Object::Ref(parent));
        d.set(
            b"MediaBox".to_vec(),
            Object::Array(vec![Object::Int(0), Object::Int(0), Object::Real(L), Object::Real(H)]),
        );
        d.set(b"Resources".to_vec(), Object::Ref(res));
        d.set(b"Contents".to_vec(), Object::Ref(contenu));
        kids.push(Object::Ref(doc.add(Object::Dict(d))));
    }
    let n = kids.len() as i64;
    doc.update_dict(parent, |d| {
        d.set(b"Kids".to_vec(), Object::Array(kids));
        d.set(b"Count".to_vec(), Object::Int(n));
    })?;
    let mut info = Dict::new();
    info.set(b"Title".to_vec(), PdfString::text(titre));
    info.set(b"Author".to_vec(), PdfString::text(auteur));
    info.set(b"Producer".to_vec(), PdfString::text("auto"));
    let info = doc.add(Object::Dict(info));
    doc.trailer_mut().set(b"Info".to_vec(), Object::Ref(info));
    Ok(write_full(&doc, &SaveOptions::default())?)
}
