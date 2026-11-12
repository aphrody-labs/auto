/**
 * Jetons de design « auto », alignés sur Material 3 (`@aphrody/m3-tokens`) : chaque couleur est un rôle
 * `--md-sys-color-*` dérivé de la graine de marque, ou une couleur personnalisée M3 (succès, avertissement)
 * dérivée de sa propre graine. tokens.css en est le miroir (vérifié par test).
 */
import { schemeFromSeed, type ColorRoleMap } from "@aphrody/m3-tokens/dynamic-color";

export type Theme = "clair" | "sombre";

/** Graine de marque (vert-teal) et graines des couleurs personnalisées. */
export const graines = { marque: "#0F6B5C", succes: "#1E8E3E", avertissement: "#B26A00" } as const;

/** Rôles M3 résolus par thème, pour la marque et chaque couleur personnalisée. */
export const roles = {
  clair: schemeFromSeed(graines.marque),
  sombre: schemeFromSeed(graines.marque, { dark: true }),
} satisfies Record<Theme, ColorRoleMap>;

const perso = (graine: string, t: Theme) => schemeFromSeed(graine, { dark: t === "sombre" });
const succes = { clair: perso(graines.succes, "clair"), sombre: perso(graines.succes, "sombre") };
const avertissement = { clair: perso(graines.avertissement, "clair"), sombre: perso(graines.avertissement, "sombre") };

const r = (t: Theme, role: string) => roles[t][`--md-sys-color-${role}`]!;
const roleDe = (role: Role, t: Theme) => (typeof role === "string" ? role : role[t]);

export interface Palette {
  fond: string;
  surface: string;
  surfaceAlt: string;
  bordure: string;
  /** Bordure des champs et contrôles : au moins 3:1 sur la surface (WCAG 1.4.11). */
  bordureControle: string;
  texte: string;
  texteAttenue: string;
  primaire: string;
  surPrimaire: string;
  focus: string;
  danger: string;
  surDanger: string;
  succes: string;
  avertissement: string;
}

type Role = string | Record<Theme, string>;

/**
 * Correspondance des jetons « auto » vers les rôles M3 ; succès et avertissement sont des couleurs personnalisées.
 * Les cartes reposent sur `surface-container-lowest` en clair mais `surface-container` en sombre, pour rester
 * plus claires que la page dans les deux thèmes.
 */
export const correspondance: Record<Exclude<keyof Palette, "succes" | "avertissement">, Role> = {
  fond: "surface",
  surface: { clair: "surface-container-lowest", sombre: "surface-container" },
  surfaceAlt: "surface-container-high",
  bordure: "outline-variant",
  bordureControle: "outline",
  texte: "on-surface",
  texteAttenue: "on-surface-variant",
  primaire: "primary",
  surPrimaire: "on-primary",
  focus: "primary",
  danger: "error",
  surDanger: "on-error",
};

const palette = (t: Theme): Palette => ({
  ...(Object.fromEntries(Object.entries(correspondance).map(([k, role]) => [k, r(t, roleDe(role, t))])) as Omit<
    Palette,
    "succes" | "avertissement"
  >),
  succes: succes[t]["--md-sys-color-primary"]!,
  avertissement: avertissement[t]["--md-sys-color-primary"]!,
});

export const palettes: Record<Theme, Palette> = { clair: palette("clair"), sombre: palette("sombre") };

/** Statuts de `@auto/domain` plus `en_retard` (dérivé de l'échéance, non stocké). */
export type StatutVisuel =
  | "brouillon"
  | "emis"
  | "envoye"
  | "accepte"
  | "refuse"
  | "depose"
  | "rejete"
  | "paye"
  | "annule"
  | "en_retard";

export interface CouleurStatut {
  texte: string;
  fond: string;
  /** Libellé affiché : le statut n'est jamais transmis par la couleur seule. */
  libelle: string;
  /** Nom de pictogramme (jeu libre Lucide). */
  icone: string;
}

/** Conteneur M3 (texte `on-*-container` sur fond `*-container`) de chaque statut. */
const conteneurs: Record<
  StatutVisuel,
  "primary" | "secondary" | "tertiary" | "error" | "neutre" | "succes" | "avertissement"
> = {
  brouillon: "neutre",
  emis: "primary",
  envoye: "tertiary",
  accepte: "succes",
  refuse: "error",
  depose: "avertissement",
  rejete: "error",
  paye: "succes",
  annule: "neutre",
  en_retard: "error",
};

const libelles: Record<StatutVisuel, Pick<CouleurStatut, "libelle" | "icone">> = {
  brouillon: { libelle: "Brouillon", icone: "pencil" },
  emis: { libelle: "Émise", icone: "file-check" },
  envoye: { libelle: "Envoyée", icone: "send" },
  accepte: { libelle: "Acceptée", icone: "circle-check" },
  refuse: { libelle: "Refusée", icone: "circle-x" },
  depose: { libelle: "Déposée", icone: "upload" },
  rejete: { libelle: "Rejetée", icone: "triangle-alert" },
  paye: { libelle: "Payée", icone: "banknote" },
  annule: { libelle: "Annulée", icone: "ban" },
  en_retard: { libelle: "En retard", icone: "clock-alert" },
};

function couleurStatut(t: Theme, s: StatutVisuel): CouleurStatut {
  const c = conteneurs[s];
  const src = c === "succes" ? succes[t] : c === "avertissement" ? avertissement[t] : roles[t];
  const [fond, texte] =
    c === "neutre"
      ? [r(t, "surface-container-highest"), r(t, "on-surface-variant")]
      : [
          src[`--md-sys-color-${c === "succes" || c === "avertissement" ? "primary" : c}-container`]!,
          src[`--md-sys-color-on-${c === "succes" || c === "avertissement" ? "primary" : c}-container`]!,
        ];
  return { texte, fond, ...libelles[s] };
}

const tous = Object.keys(conteneurs) as StatutVisuel[];
export const statuts: Record<Theme, Record<StatutVisuel, CouleurStatut>> = {
  clair: Object.fromEntries(tous.map((s) => [s, couleurStatut("clair", s)])) as Record<StatutVisuel, CouleurStatut>,
  sombre: Object.fromEntries(tous.map((s) => [s, couleurStatut("sombre", s)])) as Record<StatutVisuel, CouleurStatut>,
};

/** Échelle de 4 px. */
export const espacement = {
  0: "0",
  1: "4px",
  2: "8px",
  3: "12px",
  4: "16px",
  5: "20px",
  6: "24px",
  8: "32px",
  10: "40px",
  12: "48px",
  16: "64px",
} as const;

/**
 * Forme, élévation et mouvement viennent des jetons système M3 de `@aphrody/m3-tokens/m3-tokens.css` (importé
 * par base.css) : chaque alias `--auto-*` pointe sur le jeton `--md-sys-*` correspondant.
 */
export const rayons = { sm: "extra-small", md: "small", lg: "medium", pleine: "full" } as const;

export const ombres = { sm: "level1", md: "level2", lg: "level3" } as const;

/**
 * Polices de marque : elles remplacent les typefaces de référence M3, que les composants M3 suivent aussi. Les
 * « repli » (polices-repli.css) sont Arial aux métriques de la police attendue : pas de décalage au chargement.
 */
export const typographie = {
  titre: '"Plus Jakarta Sans", "Plus Jakarta Sans repli", system-ui, sans-serif',
  /** Corps et chiffres : Inter avec `font-variant-numeric: tabular-nums`. */
  corps: '"Inter", "Inter repli", system-ui, sans-serif',
  taille: { xs: "12px", sm: "14px", base: "16px", lg: "18px", xl: "24px", xxl: "32px" },
  interligne: { serre: 1.25, corps: 1.5 },
} as const;

/** Durées et courbe M3 (`--md-sys-motion-*`). */
export const mouvement = {
  rapide: "duration-short3",
  normal: "duration-short4",
  sortie: "duration-short3",
  courbe: "easing-standard",
} as const;

/** Classes de fenêtre M3 (compact, medium, expanded, large, extra-large). */
export { BREAKPOINTS as pointsDeRupture } from "@aphrody/m3-tokens/breakpoints";
export const zIndex = { base: 0, collant: 10, menu: 20, modale: 40, toast: 100 } as const;

/** Luminance relative WCAG 2.x. */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  const canaux = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * canaux[0]! + 0.7152 * canaux[1]! + 0.0722 * canaux[2]!;
}

export function contraste(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
const nomStatut = (s: string) => s.replace("_", "-");

/** Valeurs propres au thème : rôles M3 et couleurs personnalisées (succès, avertissement). */
function blocTheme(t: Theme, indent: string): string {
  const persos = { succes: succes[t], avertissement: avertissement[t] };
  return [
    ...Object.entries(roles[t]).map(([k, v]) => `${indent}${k}: ${v};`),
    ...Object.entries(correspondance)
      .filter(([, role]) => typeof role !== "string")
      .map(([k, role]) => `${indent}--auto-${kebab(k)}: var(--md-sys-color-${roleDe(role, t)});`),
    ...Object.entries(persos).flatMap(([nom, sc]) =>
      Object.entries(rolesPerso).map(
        ([suffixe, role]) => `${indent}--auto-${nom}-${suffixe}: ${sc[`--md-sys-color-${role}`]};`,
      ),
    ),
  ].join("\n");
}

/** Rôles exposés pour chaque couleur personnalisée M3. */
const rolesPerso = {
  base: "primary",
  sur: "on-primary",
  container: "primary-container",
  "on-container": "on-primary-container",
} as const;

/** Alias « auto » vers les rôles M3 : identiques pour les deux thèmes, la cascade fait le reste. */
function alias(): string {
  const conteneur = (c: (typeof conteneurs)[StatutVisuel]) =>
    c === "neutre"
      ? ["surface-container-highest", "on-surface-variant"].map((x) => `var(--md-sys-color-${x})`)
      : c === "succes" || c === "avertissement"
        ? [`var(--auto-${c}-container)`, `var(--auto-${c}-on-container)`]
        : [`var(--md-sys-color-${c}-container)`, `var(--md-sys-color-on-${c}-container)`];
  return [
    ...Object.entries(correspondance)
      .filter(([, role]) => typeof role === "string")
      .map(([k, role]) => `  --auto-${kebab(k)}: var(--md-sys-color-${role});`),
    "  --auto-succes: var(--auto-succes-base);",
    "  --auto-avertissement: var(--auto-avertissement-base);",
    ...Object.entries(conteneurs).flatMap(([k, c]) => {
      const [fond, texte] = conteneur(c);
      return [`  --auto-statut-${nomStatut(k)}-texte: ${texte};`, `  --auto-statut-${nomStatut(k)}-fond: ${fond};`];
    }),
  ].join("\n");
}

/** Génère le CSS des variables (contenu de tokens.css). */
export function genererCss(): string {
  const fixes = [
    ...Object.entries(espacement).map(([k, v]) => `  --auto-espace-${k}: ${v};`),
    ...Object.entries(rayons).map(([k, v]) => `  --auto-rayon-${k}: var(--md-sys-shape-corner-${v});`),
    ...Object.entries(ombres).map(([k, v]) => `  --auto-ombre-${k}: var(--md-sys-elevation-${v});`),
    `  --md-ref-typeface-brand: ${typographie.titre};`,
    `  --md-ref-typeface-plain: ${typographie.corps};`,
    `  --auto-police-titre: var(--md-ref-typeface-brand);`,
    `  --auto-police-corps: var(--md-ref-typeface-plain);`,
    ...Object.entries(typographie.taille).map(([k, v]) => `  --auto-taille-${k}: ${v};`),
    ...Object.entries(mouvement).map(([k, v]) => `  --auto-mouvement-${k}: var(--md-sys-motion-${v});`),
  ].join("\n");
  return `/* Généré depuis src/tokens.ts (bun packages/ui/src/gen.ts) : ne pas modifier à la main. */
/* Rôles Material 3 (@aphrody/m3-tokens, graine ${graines.marque}) et alias --auto-* ; à charger après @aphrody/m3-tokens/m3-tokens.css. */
:root {
  color-scheme: light dark;
${fixes}
${alias()}
${blocTheme("clair", "  ")}
}

/* Thème clair imposé sur un système sombre : les contrôles natifs (barres de défilement, listes) suivent. */
:root[data-theme="clair"] {
  color-scheme: light;
}

:root[data-theme="sombre"] {
  color-scheme: dark;
${blocTheme("sombre", "  ")}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="clair"]) {
${blocTheme("sombre", "    ")}
  }
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --auto-mouvement-rapide: 0ms;
    --auto-mouvement-normal: 0ms;
    --auto-mouvement-sortie: 0ms;
  }
}
`;
}
