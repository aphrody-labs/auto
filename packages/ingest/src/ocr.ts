// OCR des PDF reçus sans XML. Interface : PDF → texte (vide si rien n'est lisible).
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textePdf } from "@auto/native";

export type Ocr = (pdf: Uint8Array) => Promise<string>;

async function executer(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [sortie, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return code === 0 ? sortie : "";
}

/** PDF écrit dans un répertoire temporaire propre à l'appel, supprimé ensuite. */
async function avecFichier<T>(pdf: Uint8Array, fn: (fichier: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "auto-ocr-"));
  try {
    const fichier = join(dir, "recu.pdf");
    await Bun.write(fichier, pdf);
    return await fn(fichier, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Couche texte du PDF (`pdftotext` de poppler ou xpdf), si l'outil est présent. */
export const texteDuPdf: Ocr = async (pdf) => {
  const bin = Bun.which("pdftotext");
  if (bin) return avecFichier(pdf, (f) => executer([bin, "-layout", "-enc", "UTF-8", f, "-"]));
  try {
    return textePdf(pdf).join("\n");
  } catch {
    return "";
  }
};

/** OCR d'image : `aphrody-ocr <fichier>`, sinon `pdftoppm` + `tesseract` (fra), s'ils sont présents. */
export const ocrImage: Ocr = async (pdf) => {
  const ocr = Bun.which("aphrody-ocr");
  const pdftoppm = Bun.which("pdftoppm");
  const tesseract = Bun.which("tesseract");
  const estPdf = new TextDecoder().decode(pdf.subarray(0, 4)) === "%PDF";
  if (!ocr && !(tesseract && (!estPdf || pdftoppm))) return "";
  return avecFichier(pdf, async (fichier, dir) => {
    if (ocr) return executer([ocr, fichier]);
    if (!estPdf) return tesseract ? executer([tesseract, fichier, "-", "-l", "fra"]) : "";
    await executer([pdftoppm!, "-r", "300", "-png", fichier, join(dir, "p")]);
    const pages = (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    const textes = [];
    for (const p of pages) textes.push(await executer([tesseract!, join(dir, p), "-", "-l", "fra"]));
    return textes.join("\n\f\n");
  });
};

/** Par défaut : la couche texte si elle existe (≥ 20 caractères utiles), sinon l'OCR d'image. */
export const ocrParDefaut: Ocr = async (pdf) => {
  const t = await texteDuPdf(pdf);
  if (t.replace(/\s/g, "").length >= 20) return t;
  return ocrImage(pdf);
};
