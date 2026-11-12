// Icône de la marque auto, dessinée en code (aucune image binaire versionnée) : extension, application web
// installable, coques natives. PNG RVBA encodé ici, sans dépendance.
import { deflateSync } from "node:zlib";
import { palettes } from "./tokens";

/** PNG RVBA non entrelacé (filtre 0 par ligne), compressé en zlib. */
export function png(largeur: number, hauteur: number, rvba: Uint8Array): Uint8Array {
  const morceau = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    v.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, largeur);
  new DataView(ihdr.buffer).setUint32(4, hauteur);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const brut = new Uint8Array(hauteur * (1 + largeur * 4));
  for (let y = 0; y < hauteur; y++)
    brut.set(rvba.subarray(y * largeur * 4, (y + 1) * largeur * 4), y * (1 + largeur * 4) + 1);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    morceau("IHDR", ihdr),
    // Flux zlib (en-tête 78) exigé par PNG : Bun.deflateSync de ce runtime ignore windowBits et produit du deflate brut.
    morceau("IDAT", deflateSync(brut, { level: 9 })),
    morceau("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

const rvb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/**
 * Icône : carré arrondi couleur primaire M3, document blanc à coin replié et trois lignes de texte. Chaque pixel est
 * suréchantillonné (4 × 4) pour un bord lissé à toutes les tailles.
 */
export function icone(taille: number): Uint8Array {
  const fond = rvb(palettes.clair.primaire);
  const page = rvb(palettes.clair.surPrimaire);
  const N = 4;
  const r = 0.22; // rayon du carré, en fraction de la taille
  const dans = (x: number, y: number): [number, number, number] | null => {
    // Carré arrondi.
    const cx = Math.min(Math.max(x, r), 1 - r);
    const cy = Math.min(Math.max(y, r), 1 - r);
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;
    // Document : 0,30..0,70 en x, 0,20..0,80 en y, coin replié de 0,14 en haut à droite.
    const [g, d, h, b, pli] = [0.3, 0.7, 0.2, 0.8, 0.14];
    if (x >= g && x <= d && y >= h && y <= b && !(x > d - pli && y < h + pli && x - (d - pli) > y - h)) {
      const ligne = [0.42, 0.53, 0.64].some(
        (ly, i) => y >= ly && y <= ly + 0.045 && x >= g + 0.07 && x <= d - (i === 2 ? 0.16 : 0.07),
      );
      return ligne ? fond : page;
    }
    return fond;
  };
  const px = new Uint8Array(taille * taille * 4);
  for (let y = 0; y < taille; y++)
    for (let x = 0; x < taille; x++) {
      let [sr, sg, sb, sa] = [0, 0, 0, 0];
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const c = dans((x + (i + 0.5) / N) / taille, (y + (j + 0.5) / N) / taille);
          if (!c) continue;
          sr += c[0];
          sg += c[1];
          sb += c[2];
          sa++;
        }
      const o = (y * taille + x) * 4;
      if (sa)
        px.set([Math.round(sr / sa), Math.round(sg / sa), Math.round(sb / sa), Math.round((255 * sa) / (N * N))], o);
    }
  return png(taille, taille, px);
}
