// Tracés SVG des seules icônes de la vitrine (Material Symbols Rounded 400, Apache-2.0) : l'accueil n'a plus à
// télécharger la police d'icônes complète (374 Ko), que seule l'application garde (noms d'icônes dynamiques).
// Usage : bun apps/web/scripts/icones.ts  →  src/site/icones.gen.ts
import { dirname, join } from "node:path";

const ICONES = [
  "add",
  "arrow_forward",
  "check",
  "description",
  "dns",
  "keyboard_arrow_down",
  "folder_open",
  "open_in_new",
  "play_arrow",
  "receipt_long",
  "shopping_cart",
] as const;

const ui = dirname(Bun.resolveSync("@auto/ui/package.json", import.meta.dir));
const racine = dirname(Bun.resolveSync("@material-symbols/svg-400/package.json", ui));
const lignes: string[] = [];
for (const nom of ICONES) {
  const svg = await Bun.file(join(racine, "rounded", `${nom}.svg`)).text();
  const d = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]).join(" ");
  if (!d) throw new Error(`${nom} : tracé introuvable`);
  lignes.push(`  ${nom}: ${JSON.stringify(d)},`);
}
await Bun.write(
  join(import.meta.dir, "../src/site/icones.gen.ts"),
  `// Généré par apps/web/scripts/icones.ts depuis @material-symbols/svg-400 (Rounded, 400) : ne pas modifier à la main.
// Material Symbols, Google, licence Apache-2.0.
export const ICONES = {
${lignes.join("\n")}
} as const;
`,
);
console.log(`${lignes.length} icônes`);
