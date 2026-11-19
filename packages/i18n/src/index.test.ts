import { describe, expect, test } from "bun:test";
import {
  createI18n,
  extractPlaceholders,
  formatVars,
  frAutoCatalog,
  frCommonCatalog,
  get,
  languageName,
  localeChain,
  normalizeTag,
  parseCatalog,
  parseCatalogRows,
  pluralCategoryOrder,
  rawCatalogs,
  resolveLocale,
  t,
  tc,
  tid,
  tp,
  unescapeField,
  validateCatalog,
} from "./index";

const CLEAN_ROOM_HEADER = ["# Clean room: written from plain English meaning.", ""].join("\n");

describe("locale normalization and resolution", () => {
  test("normalizeTag strips encoding/modifiers and lowercases", () => {
    expect(normalizeTag("fr_FR.UTF-8")).toBe("fr-fr");
    expect(normalizeTag("fr_FR@euro")).toBe("fr-fr");
    expect(normalizeTag("  EN_US  ")).toBe("en-us");
  });

  test("localeChain strips trailing region/UN-M49 tags only", () => {
    expect(localeChain("fr-CA")).toEqual(["fr-ca", "fr"]);
    expect(localeChain("es-419")).toEqual(["es-419", "es"]);
    expect(localeChain("sr-Latn")).toEqual(["sr-latn"]);
    expect(localeChain("fr")).toEqual(["fr"]);
  });

  test("resolveLocale handles Accept-Language quality weights and query params", () => {
    expect(resolveLocale(undefined)).toBe("en");
    expect(resolveLocale(null, "fr")).toBe("fr");
    expect(resolveLocale("")).toBe("en");
    expect(resolveLocale("fr")).toBe("fr");
    expect(resolveLocale("fr-FR,fr;q=0.9,en;q=0.8")).toBe("fr");
    expect(resolveLocale("en-US,en;q=0.9,fr;q=0.8")).toBe("en");
    expect(resolveLocale("de-DE,fr-CA;q=0.8,en;q=0.9")).toBe("en");
    expect(resolveLocale("de-DE,fr_CA.UTF-8;q=0.95,en;q=0.8")).toBe("fr");
    expect(resolveLocale("fr;q=0, en;q=0.5")).toBe("en");
    expect(resolveLocale("de,es", "fr")).toBe("fr");
    expect(resolveLocale("?lang=fr")).toBe("fr");
    expect(resolveLocale("?foo=1&locale=fr")).toBe("fr");
    expect(resolveLocale("lang=en&tab=quotes", "fr")).toBe("en");
  });
});

describe("translation lookups and overrides", () => {
  test("app catalog overrides common catalog and falls back seamlessly", () => {
    expect(t("fr", "Settings")).toBe("Paramètres");
    expect(t("fr", "Edit")).toBe("Modifier");
    expect(t("fr", "All")).toBe("Tous");
    expect(tc("fr", "feminine", "All")).toBe("Toutes");
    expect(t("fr", "Save")).toBe("Enregistrer");
    expect(t("fr-CA", "Save")).toBe("Enregistrer");
    expect(t("en", "Settings")).toBe("Settings");
    expect(get("en", "Settings")).toBeUndefined();
    expect(get("fr", "Settings")).toBe("Paramètres");
  });

  test("contextual translations and fallback to plain context", () => {
    expect(tc("fr", "masculine", "Issued")).toBe("Émis");
    expect(tc("fr", "feminine", "Issued")).toBe("Émise");
    expect(tc("fr", "pdf", "Quote")).toBe("Devis");
    expect(tc("fr", "pdf", "Invoice")).toBe("Facture");
    expect(tc("fr", "pdf", "Deposit")).toBe("Acompte");
    expect(tc("fr", "pdf", "Credit note")).toBe("Avoir");
    expect(tc("fr", "pdf", "Credit note on invoice {o}", { o: "F-2026-0001" })).toBe("Avoir sur facture F-2026-0001");
    expect(tc("fr", "pdf", 'Sign & date with "Agreed"')).toBe("Bon pour accord — Date et signature");
    expect(tc("fr", "pdf", "Page {page}/{pages}", { page: 1, pages: 3 })).toBe("Page 1/3");
    expect(tc("fr", "nonexistent-ctx", "Invoice")).toBe("Facture");
  });

  test("dual-mode, self-hosted controller, auto-update and GPUI keys", () => {
    expect(tc("fr", "desktop", "Serverless")).toBe("Serverless (Cloudflare)");
    expect(tc("fr", "desktop", "Self-hosted")).toBe("Auto-hébergé");
    expect(tc("fr", "desktop", "Self-hosted controller")).toBe("Contrôleur auto-hébergé");
    expect(tc("fr", "update", "Check for updates")).toBe("Rechercher des mises à jour");
    expect(tc("fr", "update", "Install and restart")).toBe("Installer et redémarrer");
    expect(tc("fr", "update", "Release verified")).toBe("Version vérifiée");
    expect(tc("fr", "gpui", "Frame rate")).toBe("Fréquence d'images");
    expect(tc("fr", "gpui", "Frame time")).toBe("Temps d'image");
  });

  test("tid and languageName", () => {
    expect(tid("fr", "language.name", "English")).toBe("Français");
    expect(tid("en", "language.name", "English")).toBe("English");
    expect(tid("fr", "missing.id", "Balance due")).toBe("Net à payer");
    expect(languageName("fr")).toBe("Français");
    expect(languageName("fr-BE")).toBe("Français");
    expect(languageName("en")).toBe("English");
  });
});

describe("pluralization and formatting", () => {
  test("pluralCategoryOrder for French has 2 forms [one, other]", () => {
    expect(pluralCategoryOrder("fr")).toEqual(["one", "other"]);
    expect(pluralCategoryOrder("en")).toEqual(["one", "other"]);
  });

  test("tp selects French 2-form plurals accurately including 0, 1, 2, and 1_000_000", () => {
    expect(tp("fr", "{n} invoice|{n} invoices", 0)).toBe("0 facture");
    expect(tp("fr", "{n} invoice|{n} invoices", 1)).toBe("1 facture");
    expect(tp("fr", "{n} invoice|{n} invoices", 2)).toBe("2 factures");
    expect(tp("fr", "{n} invoice|{n} invoices", 15)).toBe("15 factures");
    expect(tp("fr", "{n} invoice|{n} invoices", 1_000_000)).toBe("1000000 factures");
  });

  test("tp selects English plurals accurately on fallback", () => {
    expect(tp("en", "{n} invoice|{n} invoices", 0)).toBe("0 invoices");
    expect(tp("en", "{n} invoice|{n} invoices", 1)).toBe("1 invoice");
    expect(tp("en", "{n} invoice|{n} invoices", 2)).toBe("2 invoices");
    expect(tp("en", "{n} invoice|{n} invoices", 1_000_000)).toBe("1000000 invoices");
  });

  test("formatVars performs single-pass substitution without re-expanding user values", () => {
    expect(formatVars("Hello {a}, {b}", { a: "{b}", b: "world" })).toBe("Hello {b}, world");
    expect(formatVars("Keep {missing}", {})).toBe("Keep {missing}");
  });

  test("unescapeField decodes only backslash escapes n, t, backslash", () => {
    expect(unescapeField("Line 1\\nLine 2\\t\\\\end")).toBe("Line 1\nLine 2\t\\end");
  });
});

describe("catalog format invariants for locales/fr/common.tsv and locales/fr/auto.tsv", () => {
  test("fr/common.tsv passes all catalog validation checks", () => {
    const problems = validateCatalog(rawCatalogs.frCommon, { kind: "common", locale: "fr" });
    expect(problems).toEqual([]);
    expect(frCommonCatalog.languageName).toBe("Français");
    expect(frCommonCatalog.exact.size).toBeGreaterThan(1000);
  });

  test("fr/auto.tsv passes all catalog validation checks and has no identical common duplicates", () => {
    const commonRows = parseCatalogRows(rawCatalogs.frCommon);
    const problems = validateCatalog(rawCatalogs.frAuto, {
      kind: "app",
      locale: "fr",
      commonRows,
    });
    expect(problems).toEqual([]);
    expect(frAutoCatalog.exact.size).toBeGreaterThan(1000);
    expect(frAutoCatalog.plurals.size).toBeGreaterThan(40);
  });

  test("validator catches malformed catalogs", () => {
    expect(validateCatalog("ctx\tsrc\ttr", { kind: "app", locale: "fr" }).map((p) => p.code)).toContain(
      "missing-clean-room",
    );

    const dupCommon = parseCatalogRows(rawCatalogs.frCommon).slice(0, 1);
    const sample = dupCommon[0]!;
    const dupTsv = `${CLEAN_ROOM_HEADER}${sample.ctx}\t${sample.source}\t${sample.translation}\n`;
    expect(validateCatalog(dupTsv, { kind: "app", locale: "fr", commonRows: dupCommon }).map((p) => p.code)).toContain(
      "identical-common-override",
    );

    const badTsv = [
      CLEAN_ROOM_HEADER,
      "\tHello {name}\tBonjour",
      "\tLoading…\tChargement",
      "@foo\tBar\tBaz",
      "@plural\t{n} cat|{n} cats\t{n} chat",
      "@msg\tHi {a}{b}\tSalut {a}{b}",
      "\tEsc\tBad\\qescape",
      "\tDup\tA",
      "\tDup\tB",
    ].join("\n");

    const codes = new Set(validateCatalog(badTsv, { kind: "app", locale: "fr" }).map((p) => p.code));
    expect(codes.has("placeholder-mismatch")).toBe(true);
    expect(codes.has("ellipsis-mismatch")).toBe(true);
    expect(codes.has("unknown-at-context")).toBe(true);
    expect(codes.has("bad-plural-forms")).toBe(true);
    expect(codes.has("invalid-msg-template")).toBe(true);
    expect(codes.has("bad-escape")).toBe(true);
    expect(codes.has("duplicate-entry")).toBe(true);
  });

  test("custom instance respects first-wins duplicates and placeholder multiset", () => {
    expect(extractPlaceholders("Total {b} / {a} / {a}")).toEqual(["a", "a", "b"]);
    const custom = createI18n({
      fr: {
        common: parseCatalog(`${CLEAN_ROOM_HEADER}\tKey\tFirst\n\tKey\tSecond\n`),
      },
    });
    expect(custom.t("fr", "Key")).toBe("First");
  });
});
