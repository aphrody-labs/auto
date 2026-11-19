//! Embedded interface localization built on `craft-i18n`.

use std::borrow::Cow;
use std::sync::OnceLock;

pub use craft_i18n::{Embedded, I18n, Lang};

include!(concat!(env!("OUT_DIR"), "/embedded_locales.rs"));

/// Supported interface languages in canonical order (`"en"` first).
pub const SUPPORTED_LANGS: &[&str] = &["en", "fr"];

/// Localized wrapper around a `craft_i18n::I18n` catalog.
pub struct Catalog {
    inner: I18n,
}

impl Catalog {
    /// Builds a catalog from an embedded `(locale, common_tsv, app_tsv)` slice.
    pub fn from_embedded(embedded: &'static Embedded) -> Self {
        let (inner, _warnings) = I18n::new(embedded, SUPPORTED_LANGS);
        Self { inner }
    }

    /// Resolves `"en"` / `"fr"` (or `Accept-Language` / `?lang=` tags) to a loaded `Lang`.
    pub fn lang(&self, tag: &str) -> Lang {
        let code = resolve_lang(Some(tag));
        self.inner.from_code(code).unwrap_or(Lang::EN)
    }

    /// Translates `source` with empty context, falling back to English `source`.
    pub fn tr<'a>(&'a self, lang: &str, source: &'a str) -> Cow<'a, str> {
        let l = self.lang(lang);
        Cow::Borrowed(self.inner.t(l, source))
    }

    /// Translates `source` in `ctx`, falling back to `""` then English `source`.
    pub fn tr_ctx<'a>(&'a self, lang: &str, ctx: &str, source: &'a str) -> Cow<'a, str> {
        let l = self.lang(lang);
        Cow::Borrowed(self.inner.tc(l, ctx, source))
    }

    /// Translates a singular/plural pair using `n`.
    pub fn tr_plural(&self, lang: &str, one: &str, other: &str, n: u64, args: &[(&str, &str)]) -> String {
        let l = self.lang(lang);
        let tpl = self.inner.trn_plain(l, n, one, other);
        format_with(&tpl, Some(n), args)
    }

    /// Translates `source` and formats `{name}` placeholders cleanly without bidi isolates.
    pub fn tr_args(&self, lang: &str, ctx: Option<&str>, source: &str, args: &[(&str, &str)]) -> String {
        let l = self.lang(lang);
        let tpl = match ctx {
            Some(c) if !c.is_empty() => self.inner.tc(l, c, source),
            _ => self.inner.t(l, source),
        };
        format_with(tpl, None, args)
    }

    /// Returns underlying `craft_i18n::I18n`.
    pub fn inner(&self) -> &I18n {
        &self.inner
    }
}

fn format_with(template: &str, count: Option<u64>, args: &[(&str, &str)]) -> String {
    if let Some(n) = count
        && !args.iter().any(|(k, _)| *k == "n")
    {
        let n_str = n.to_string();
        let mut combined = Vec::with_capacity(args.len() + 1);
        combined.push(("n", n_str.as_str()));
        combined.extend_from_slice(args);
        return craft_i18n::fmt_plain(template, &combined);
    }
    craft_i18n::fmt_plain(template, args)
}

static DEFAULT_CATALOG: OnceLock<Catalog> = OnceLock::new();

/// Returns the default workspace catalog compiled from `CRAFT_I18N`.
pub fn catalog() -> &'static Catalog {
    DEFAULT_CATALOG.get_or_init(|| Catalog::from_embedded(CRAFT_I18N))
}

/// Returns supported canonical locale codes (`&["en", "fr"]`).
pub fn supported_langs() -> &'static [&'static str] {
    SUPPORTED_LANGS
}

/// Normalizes a locale tag, query string (`?lang=fr`), or `Accept-Language` header to `"en"` or `"fr"`.
pub fn resolve_lang(input: Option<&str>) -> &'static str {
    let Some(raw) = input.map(str::trim).filter(|s| !s.is_empty()) else {
        return "en";
    };

    // Handle `?lang=...` or `?locale=...` query fragments.
    let candidate = if let Some((_, rest)) = raw.split_once('?') {
        rest.split('&')
            .filter_map(|kv| kv.split_once('='))
            .find(|(k, _)| matches!(*k, "lang" | "locale"))
            .map(|(_, v)| v)
            .unwrap_or(raw)
    } else {
        raw
    };

    // Split Accept-Language lists (`fr-FR,fr;q=0.9,en;q=0.8`) by `,`, strip `;q=...`.
    for part in candidate.split(',') {
        let tag = part.split(';').next().unwrap_or("").trim();
        let primary = tag.split(['-', '_', '.']).next().unwrap_or("").to_ascii_lowercase();
        match primary.as_str() {
            "fr" => return "fr",
            "en" => return "en",
            _ => {}
        }
    }
    "en"
}

/// Translates `source` using the default catalog.
pub fn tr<'a>(lang: &str, source: &'a str) -> Cow<'a, str> {
    catalog().tr(lang, source)
}

/// Translates `source` with context `ctx` using the default catalog.
pub fn tr_ctx<'a>(lang: &str, ctx: &str, source: &'a str) -> Cow<'a, str> {
    catalog().tr_ctx(lang, ctx, source)
}

/// Translates a plural template (`one` / `other`) for `n` with optional `{name}` placeholders.
pub fn tr_plural(lang: &str, one: &str, other: &str, n: u64, args: &[(&str, &str)]) -> String {
    catalog().tr_plural(lang, one, other, n, args)
}

/// Translates `source` (with optional context) and substitutes `{name}` arguments cleanly.
pub fn tr_args(lang: &str, ctx: Option<&str>, source: &str, args: &[(&str, &str)]) -> String {
    catalog().tr_args(lang, ctx, source, args)
}

#[cfg(test)]
mod tests {
    use super::*;

    static SAMPLE_EMBEDDED: &Embedded = &[(
        "fr",
        "",
        "pdf\tInvoice\tFacture\n@plural\t{n} day|{n} days\t{n} jour|{n} jours\n\tPayment due in {days} days\tPaiement sous {days} jours\n",
    )];

    #[test]
    fn resolves_locales_cleanly() {
        assert_eq!(resolve_lang(None), "en");
        assert_eq!(resolve_lang(Some("")), "en");
        assert_eq!(resolve_lang(Some("fr")), "fr");
        assert_eq!(resolve_lang(Some("fr-FR,en-US;q=0.9")), "fr");
        assert_eq!(resolve_lang(Some("fr_CA.UTF-8")), "fr");
        assert_eq!(resolve_lang(Some("https://example.test/doc?lang=fr&x=1")), "fr");
        assert_eq!(resolve_lang(Some("de-DE,en;q=0.8")), "en");
        assert_eq!(supported_langs(), &["en", "fr"]);
    }

    #[test]
    fn translates_with_fallback_and_plurals() {
        let cat = Catalog::from_embedded(SAMPLE_EMBEDDED);
        assert_eq!(cat.tr_ctx("en", "pdf", "Invoice"), "Invoice");
        assert_eq!(cat.tr_ctx("fr", "pdf", "Invoice"), "Facture");
        assert_eq!(cat.tr("fr", "Missing key"), "Missing key");
        assert_eq!(cat.tr_plural("fr", "{n} day", "{n} days", 1, &[]), "1 jour");
        assert_eq!(cat.tr_plural("fr", "{n} day", "{n} days", 3, &[]), "3 jours");
        assert_eq!(cat.tr_plural("en", "{n} day", "{n} days", 1, &[]), "1 day");
        assert_eq!(cat.tr_args("fr", None, "Payment due in {days} days", &[("days", "30")]), "Paiement sous 30 jours");
    }

    #[test]
    fn default_catalog_loads_and_passes_through_missing() {
        assert_eq!(tr("en", "Invoice"), "Invoice");
        assert_eq!(tr_ctx("fr", "pdf", "Untranslated Key"), "Untranslated Key");
    }
}
