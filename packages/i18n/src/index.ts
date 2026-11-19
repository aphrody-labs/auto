import frAutoRaw from "../../../locales/fr/auto.tsv" with { type: "text" };
import frCommonRaw from "../../../locales/fr/common.tsv" with { type: "text" };

export type Locale = "en" | "fr";

export const SUPPORTED_LOCALES = ["en", "fr"] as const;

export type Vars = Record<string, string | number | boolean>;

export type CatalogKind = "common" | "app";

export interface CatalogEntry {
  readonly ctx: string;
  readonly source: string;
  readonly translation: string;
  readonly line: number;
}

export interface CatalogProblem {
  readonly code: string;
  readonly message: string;
  readonly line?: number;
}

export interface Catalog {
  readonly exact: ReadonlyMap<string, string>;
  readonly byId: ReadonlyMap<string, string>;
  readonly plurals: ReadonlyMap<string, readonly string[]>;
  readonly languageName?: string;
}

interface LocaleBundle {
  readonly common?: Catalog;
  readonly app?: Catalog;
}

const KEY_SEP = "\u0000";
const RESERVED_CONTEXTS = new Set(["@plural", "@id", "@msg"]);
const CLDR_ORDER = ["zero", "one", "two", "few", "many", "other"] as const;
const REGION_SUFFIX_RE = /^([a-z]{2}|\d{3})$/;

function hasForbiddenControlChar(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if ((code <= 0x1f && code !== 0x09) || (code >= 0x7f && code <= 0x9f) || code === 0xfeff) {
      return true;
    }
  }
  return false;
}

function makeKey(ctx: string, source: string): string {
  return `${ctx}${KEY_SEP}${source}`;
}

export function unescapeField(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === "n") {
        out += "\n";
        i++;
        continue;
      }
      if (next === "t") {
        out += "\t";
        i++;
        continue;
      }
      if (next === "\\") {
        out += "\\";
        i++;
        continue;
      }
    }
    if (ch !== undefined) {
      out += ch;
    }
  }
  return out;
}

function checkEscapes(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\\") {
      if (i + 1 >= raw.length) return false;
      const next = raw[i + 1];
      if (next !== "n" && next !== "t" && next !== "\\") return false;
      i++;
    }
  }
  return true;
}

export function normalizeTag(raw: string): string {
  let s = raw.trim();
  const dotIdx = s.indexOf(".");
  if (dotIdx !== -1) s = s.slice(0, dotIdx);
  const atIdx = s.indexOf("@");
  if (atIdx !== -1) s = s.slice(0, atIdx);
  return s.replaceAll("_", "-").trim().toLowerCase();
}

export function localeChain(tag: string): string[] {
  const norm = normalizeTag(tag);
  if (!norm) return [];
  const parts = norm.split("-").filter((p) => p.length > 0);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    if (last !== undefined && REGION_SUFFIX_RE.test(last)) {
      const parent = parts.slice(0, -1).join("-");
      return [norm, parent];
    }
  }
  return [norm];
}

export function extractPlaceholders(text: string): string[] {
  const names: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "{") {
      const close = text.indexOf("}", i + 1);
      if (close !== -1) {
        const name = text.slice(i + 1, close);
        if (name.length > 0 && !name.includes("{")) {
          names.push(name);
          i = close + 1;
          continue;
        }
      }
    }
    i++;
  }
  names.sort();
  return names;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function validateMsgTemplate(text: string): string | undefined {
  let literalChars = 0;
  let i = 0;
  let prevWasPlaceholder = false;
  while (i < text.length) {
    if (text[i] === "{") {
      const close = text.indexOf("}", i + 1);
      if (close === -1) return "unclosed '{' in @msg template";
      const inner = text.slice(i + 1, close);
      if (inner.length === 0 || inner.includes("{")) {
        return "malformed placeholder in @msg template";
      }
      if (prevWasPlaceholder) return "adjacent placeholders without separator in @msg template";
      prevWasPlaceholder = true;
      i = close + 1;
    } else {
      literalChars++;
      prevWasPlaceholder = false;
      i++;
    }
  }
  if (literalChars === 0) return "@msg template must contain literal text";
  return undefined;
}

function splitLines(tsv: string): string[] {
  const clean = tsv.startsWith("\ufeff") ? tsv.slice(1) : tsv;
  return clean.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

export function parseCatalogRows(tsv: string): CatalogEntry[] {
  const lines = splitLines(tsv);
  const rows: CatalogEntry[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx];
    if (rawLine === undefined) continue;
    if (rawLine.length === 0 || rawLine.startsWith("#")) continue;
    const cols = rawLine.split("\t");
    if (cols.length !== 3) continue;
    const rawCtx = cols[0] ?? "";
    const rawSrc = cols[1] ?? "";
    const rawTr = cols[2] ?? "";
    rows.push({
      ctx: unescapeField(rawCtx),
      source: unescapeField(rawSrc),
      translation: unescapeField(rawTr),
      line: idx + 1,
    });
  }
  return rows;
}

export function parseCatalog(tsv: string): Catalog {
  const exact = new Map<string, string>();
  const byId = new Map<string, string>();
  const plurals = new Map<string, string[]>();
  let languageName: string | undefined;

  for (const row of parseCatalogRows(tsv)) {
    if (row.source.length === 0 || row.translation.length === 0) continue;
    if (row.ctx === "@id") {
      if (!byId.has(row.source)) {
        byId.set(row.source, row.translation);
      }
      if (row.source === "language.name" && languageName === undefined) {
        languageName = row.translation;
      }
      continue;
    }
    if (row.ctx === "@plural") {
      if (!plurals.has(row.source)) {
        plurals.set(row.source, row.translation.split("|"));
      }
      continue;
    }
    const key = makeKey(row.ctx, row.source);
    if (!exact.has(key)) {
      exact.set(key, row.translation);
    }
  }

  return { exact, byId, plurals, languageName };
}

export function validateCatalog(
  tsv: string,
  options?: { kind?: CatalogKind; locale?: string; commonRows?: readonly CatalogEntry[] },
): CatalogProblem[] {
  const kind = options?.kind ?? "app";
  const locale = options?.locale ?? "fr";
  const expectedPluralForms = pluralCategoryOrder(locale).length;
  const problems: CatalogProblem[] = [];

  const commonSet = new Set<string>();
  if (options?.commonRows) {
    for (const r of options.commonRows) {
      commonSet.add(`${r.ctx}${KEY_SEP}${r.source}${KEY_SEP}${r.translation}`);
    }
  }

  const lines = splitLines(tsv);
  const hasCleanRoom = lines.some((line) => line.startsWith("# Clean room:"));
  if (!hasCleanRoom) {
    problems.push({ code: "missing-clean-room", message: "Missing '# Clean room:' header line" });
  }

  const seenKeys = new Set<string>();
  let hasLanguageName = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    const rawLine = lines[idx];
    if (rawLine === undefined) continue;
    if (rawLine.length === 0) continue;
    if (rawLine.startsWith("#")) continue;

    if (rawLine.trim().length === 0) {
      problems.push({ code: "whitespace-line", message: "Whitespace-only line", line: lineNo });
      continue;
    }

    const cols = rawLine.split("\t");
    if (cols.length !== 3) {
      problems.push({
        code: "bad-columns",
        message: `Expected 3 tab-separated columns, found ${cols.length}`,
        line: lineNo,
      });
      continue;
    }

    const rawCtx = cols[0] ?? "";
    const rawSrc = cols[1] ?? "";
    const rawTr = cols[2] ?? "";

    for (const [colName, colVal] of [
      ["context", rawCtx],
      ["source", rawSrc],
      ["translation", rawTr],
    ] as const) {
      if (hasForbiddenControlChar(colVal)) {
        problems.push({
          code: "control-char",
          message: `Forbidden control character in ${colName}`,
          line: lineNo,
        });
      }
      if (!checkEscapes(colVal)) {
        problems.push({
          code: "bad-escape",
          message: `Invalid backslash escape in ${colName} (only \\n, \\t, \\\\ allowed)`,
          line: lineNo,
        });
      }
    }

    const ctx = unescapeField(rawCtx);
    const source = unescapeField(rawSrc);
    const translation = unescapeField(rawTr);

    if (source.length === 0) {
      problems.push({ code: "empty-source", message: "Empty source string", line: lineNo });
      continue;
    }
    if (translation.length === 0) {
      problems.push({ code: "empty-translation", message: "Empty translation string", line: lineNo });
      continue;
    }

    if (ctx.startsWith("@") && !RESERVED_CONTEXTS.has(ctx)) {
      problems.push({
        code: "unknown-at-context",
        message: `Unknown '@' context '${ctx}' (only @plural, @id, @msg allowed)`,
        line: lineNo,
      });
    }

    const key = makeKey(ctx, source);
    if (seenKeys.has(key)) {
      problems.push({
        code: "duplicate-entry",
        message: `Duplicate entry for (${ctx}, ${source})`,
        line: lineNo,
      });
    }
    seenKeys.add(key);

    if (ctx === "@id" && source === "language.name") {
      hasLanguageName = true;
    }

    if (kind === "app" && commonSet.has(`${ctx}${KEY_SEP}${source}${KEY_SEP}${translation}`)) {
      problems.push({
        code: "identical-common-override",
        message: `Identical to common.tsv for (${ctx}, ${source})`,
        line: lineNo,
      });
    }

    if (source.endsWith("…") !== translation.endsWith("…")) {
      problems.push({
        code: "ellipsis-mismatch",
        message: `Trailing ellipsis '…' mismatch for '${source}' -> '${translation}'`,
        line: lineNo,
      });
    }

    if (ctx === "@plural") {
      const srcForms = source.split("|");
      const trForms = translation.split("|");
      if (srcForms.length !== 2 || srcForms.some((f) => f.length === 0)) {
        problems.push({
          code: "bad-plural-source",
          message: `@plural source must be 'one|other' with 2 nonempty forms: '${source}'`,
          line: lineNo,
        });
      } else {
        const onePh = extractPlaceholders(srcForms[0] ?? "");
        const otherPh = extractPlaceholders(srcForms[1] ?? "");
        if (!arraysEqual(onePh, otherPh)) {
          problems.push({
            code: "plural-source-placeholders",
            message: `@plural source forms differ in placeholders: '${source}'`,
            line: lineNo,
          });
        }
        if (trForms.length !== expectedPluralForms || trForms.some((f) => f.length === 0)) {
          problems.push({
            code: "bad-plural-forms",
            message: `Expected ${expectedPluralForms} nonempty plural forms for '${locale}', got ${trForms.length}: '${translation}'`,
            line: lineNo,
          });
        } else {
          for (let fi = 0; fi < trForms.length; fi++) {
            const formPh = extractPlaceholders(trForms[fi] ?? "");
            if (!arraysEqual(otherPh, formPh)) {
              problems.push({
                code: "plural-placeholder-mismatch",
                message: `@plural form #${fi + 1} placeholder mismatch for '${source}': '${translation}'`,
                line: lineNo,
              });
            }
          }
        }
      }
      continue;
    }

    const srcPh = extractPlaceholders(source);
    const trPh = extractPlaceholders(translation);
    if (!arraysEqual(srcPh, trPh)) {
      problems.push({
        code: "placeholder-mismatch",
        message: `Placeholder mismatch for '${source}': expected [${srcPh.join(", ")}], got [${trPh.join(", ")}]`,
        line: lineNo,
      });
    }

    if (ctx === "@msg") {
      const msgErr = validateMsgTemplate(translation);
      if (msgErr !== undefined) {
        problems.push({
          code: "invalid-msg-template",
          message: `${msgErr} in '${translation}'`,
          line: lineNo,
        });
      }
    }
  }

  if (kind === "common" && !hasLanguageName) {
    problems.push({ code: "missing-language-name", message: "Missing '@id\\tlanguage.name' entry" });
  }

  return problems;
}

const pluralCache = new Map<
  string,
  { readonly rules: Intl.PluralRules; readonly order: readonly Intl.LDMLPluralRule[] }
>();

function getPluralConfig(locale: string): {
  readonly rules: Intl.PluralRules;
  readonly order: readonly Intl.LDMLPluralRule[];
} {
  const norm = normalizeTag(locale) || "en";
  const cached = pluralCache.get(norm);
  if (cached !== undefined) return cached;

  let rules: Intl.PluralRules;
  try {
    rules = new Intl.PluralRules(norm);
  } catch {
    rules = new Intl.PluralRules("en");
  }

  const seen = new Set<Intl.LDMLPluralRule>();
  for (let n = 0; n <= 1000; n++) {
    seen.add(rules.select(n));
  }
  const order = CLDR_ORDER.filter((cat) => seen.has(cat));
  const finalOrder: readonly Intl.LDMLPluralRule[] = order.length > 0 ? order : ["one", "other"];
  const entry = { rules, order: finalOrder };
  pluralCache.set(norm, entry);
  return entry;
}

export function pluralCategoryOrder(locale: string): readonly Intl.LDMLPluralRule[] {
  return getPluralConfig(locale).order;
}

function selectPluralIndex(locale: string, count: number): number {
  const { rules, order } = getPluralConfig(locale);
  const cat = rules.select(count);
  const idx = order.indexOf(cat);
  if (idx !== -1) return idx;
  const fewIdx = order.indexOf("few");
  if (fewIdx !== -1) return fewIdx;
  return order.length - 1;
}

export function formatVars(template: string, vars?: Vars): string {
  if (vars === undefined || !template.includes("{")) return template;
  let out = "";
  let i = 0;
  while (i < template.length) {
    if (template[i] === "{") {
      const close = template.indexOf("}", i + 1);
      if (close !== -1) {
        const key = template.slice(i + 1, close);
        if (key.length > 0 && !key.includes("{") && Object.hasOwn(vars, key)) {
          const val = vars[key];
          if (val !== undefined) {
            out += String(val);
            i = close + 1;
            continue;
          }
        }
      }
    }
    const ch = template[i];
    if (ch !== undefined) {
      out += ch;
    }
    i++;
  }
  return out;
}

export interface I18nInstance {
  t(locale: Locale | (string & {}), source: string, vars?: Vars): string;
  tc(locale: Locale | (string & {}), ctx: string, source: string, vars?: Vars): string;
  tp(locale: Locale | (string & {}), oneOther: string, count: number, vars?: Vars): string;
  tid(locale: Locale | (string & {}), id: string, fallback: string, vars?: Vars): string;
  get(locale: Locale | (string & {}), source: string): string | undefined;
  languageName(locale: Locale | (string & {})): string | undefined;
}

export function createI18n(bundles: Record<string, LocaleBundle>): I18nInstance {
  function lookupExact(locale: string, ctx: string, source: string): string | undefined {
    const key = makeKey(ctx, source);
    const plainKey = ctx.length > 0 ? makeKey("", source) : undefined;
    for (const tag of localeChain(locale)) {
      const bundle = bundles[tag];
      if (!bundle) continue;
      const appHit = bundle.app?.exact.get(key);
      if (appHit !== undefined) return appHit;
      const commonHit = bundle.common?.exact.get(key);
      if (commonHit !== undefined) return commonHit;
      if (plainKey !== undefined) {
        const appPlain = bundle.app?.exact.get(plainKey);
        if (appPlain !== undefined) return appPlain;
        const commonPlain = bundle.common?.exact.get(plainKey);
        if (commonPlain !== undefined) return commonPlain;
      }
    }
    return undefined;
  }

  function lookupId(locale: string, id: string): string | undefined {
    for (const tag of localeChain(locale)) {
      const bundle = bundles[tag];
      if (!bundle) continue;
      const appHit = bundle.app?.byId.get(id);
      if (appHit !== undefined) return appHit;
      const commonHit = bundle.common?.byId.get(id);
      if (commonHit !== undefined) return commonHit;
    }
    return undefined;
  }

  function lookupPlural(
    locale: string,
    oneOther: string,
  ): { forms: readonly string[]; matchedLocale: string } | undefined {
    for (const tag of localeChain(locale)) {
      const bundle = bundles[tag];
      if (!bundle) continue;
      const appHit = bundle.app?.plurals.get(oneOther);
      if (appHit !== undefined) return { forms: appHit, matchedLocale: tag };
      const commonHit = bundle.common?.plurals.get(oneOther);
      if (commonHit !== undefined) return { forms: commonHit, matchedLocale: tag };
    }
    return undefined;
  }

  return {
    get(locale, source) {
      return lookupExact(locale, "", source);
    },

    t(locale, source, vars) {
      const raw = lookupExact(locale, "", source) ?? source;
      return formatVars(raw, vars);
    },

    tc(locale, ctx, source, vars) {
      const raw = lookupExact(locale, ctx, source) ?? source;
      return formatVars(raw, vars);
    },

    tp(locale, oneOther, count, vars) {
      const hit = lookupPlural(locale, oneOther);
      let template: string;
      if (hit !== undefined) {
        const idx = selectPluralIndex(hit.matchedLocale, count);
        template = hit.forms[idx] ?? hit.forms[hit.forms.length - 1] ?? oneOther;
      } else {
        const srcForms = oneOther.split("|");
        const idx = Math.min(selectPluralIndex("en", count), Math.max(0, srcForms.length - 1));
        template = srcForms[idx] ?? srcForms[srcForms.length - 1] ?? oneOther;
      }
      const mergedVars: Vars = vars !== undefined ? { n: count, count, ...vars } : { n: count, count };
      return formatVars(template, mergedVars);
    },

    tid(locale, id, fallback, vars) {
      const raw = lookupId(locale, id) ?? lookupExact(locale, "", fallback) ?? fallback;
      return formatVars(raw, vars);
    },

    languageName(locale) {
      const norm = normalizeTag(locale);
      if (norm === "en" || norm.startsWith("en-")) {
        return lookupId(norm, "language.name") ?? "English";
      }
      return lookupId(locale, "language.name");
    },
  };
}

function parseLocaleTag(tag: string): Locale | undefined {
  for (const candidate of localeChain(tag)) {
    if (candidate === "fr") return "fr";
    if (candidate === "en") return "en";
  }
  return undefined;
}

export function resolveLocale(acceptLanguageOrQuery?: string | null, fallback: Locale = "en"): Locale {
  if (!acceptLanguageOrQuery) return fallback;
  const trimmed = acceptLanguageOrQuery.trim();
  if (trimmed.length === 0) return fallback;

  if (trimmed.startsWith("?") || /(?:^|&)(?:lang|locale)=/i.test(trimmed)) {
    const queryStr = trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
    const params = new URLSearchParams(queryStr);
    const paramTag = params.get("lang") ?? params.get("locale");
    if (paramTag !== null) {
      const matched = parseLocaleTag(paramTag);
      if (matched !== undefined) return matched;
    }
    return fallback;
  }

  const candidates = trimmed
    .split(",")
    .map((part, order) => {
      const segments = part.split(";");
      const rawTag = (segments[0] ?? "").trim();
      let q = 1;
      for (let i = 1; i < segments.length; i++) {
        const seg = segments[i]?.trim() ?? "";
        if (seg.toLowerCase().startsWith("q=")) {
          const parsed = Number(seg.slice(2).trim());
          q = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
        }
      }
      return { rawTag, q, order };
    })
    .filter((item) => item.rawTag.length > 0 && item.rawTag !== "*" && item.q > 0)
    .sort((a, b) => b.q - a.q || a.order - b.order);

  for (const candidate of candidates) {
    const matched = parseLocaleTag(candidate.rawTag);
    if (matched !== undefined) return matched;
  }

  return fallback;
}

export const frCommonCatalog = parseCatalog(frCommonRaw);
export const frAutoCatalog = parseCatalog(frAutoRaw);
export const rawCatalogs = {
  frCommon: frCommonRaw,
  frAuto: frAutoRaw,
} as const;

const defaultI18n = createI18n({
  fr: {
    common: frCommonCatalog,
    app: frAutoCatalog,
  },
});

export function t(locale: Locale | (string & {}), source: string, vars?: Vars): string {
  return defaultI18n.t(locale, source, vars);
}

export function tc(locale: Locale | (string & {}), ctx: string, source: string, vars?: Vars): string {
  return defaultI18n.tc(locale, ctx, source, vars);
}

export function tp(locale: Locale | (string & {}), oneOther: string, count: number, vars?: Vars): string {
  return defaultI18n.tp(locale, oneOther, count, vars);
}

export function tid(locale: Locale | (string & {}), id: string, fallback: string, vars?: Vars): string {
  return defaultI18n.tid(locale, id, fallback, vars);
}

export function get(locale: Locale | (string & {}), source: string): string | undefined {
  return defaultI18n.get(locale, source);
}

export function languageName(locale: Locale | (string & {})): string | undefined {
  return defaultI18n.languageName(locale);
}
