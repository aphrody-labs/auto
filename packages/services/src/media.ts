// Nœuds média et navigateur des automatisations, sur les API natives du runtime : Bun.Image (transformation et
// encodage), Bun.Video (métadonnées, image extraite, GIF ; fournisseur Rust FilmCraft) et Bun.WebView (page web
// rendue, capture, texte). Vérifiés sur le runtime de production (bun 1.4.5 : Bun.Image, Bun.Video.available,
// Bun.WebView présents). Le navigateur exige Chrome ou Chromium sur la machine : sans lui, le nœud échoue clairement.
import type { OperationsImage, Services } from "@auto/automate";

const TYPES = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" } as const;
type Encodable = keyof typeof TYPES;
const ENCODABLES = Object.keys(TYPES) as Encodable[];

function encoder(img: Bun.Image, format: keyof typeof TYPES, qualite: number) {
  if (format === "jpeg") return img.jpeg({ quality: qualite });
  if (format === "png") return img.png();
  return img.webp({ quality: qualite });
}

async function transformer(octets: Uint8Array, o: OperationsImage) {
  let img = new Bun.Image(octets);
  const source = await img.metadata();
  if (o.recadrer) img = img.extract(o.recadrer);
  if (o.rotation) img = img.rotate(o.rotation);
  if (o.largeur || o.hauteur)
    img = img.resize(o.largeur ?? 0, o.hauteur ?? 0, { fit: o.ajustement, withoutEnlargement: true });
  if (o.niveauxDeGris || o.luminosite !== 1)
    img = img.modulate({ brightness: o.luminosite, saturation: o.niveauxDeGris ? 0 : 1 });
  // « origine » : format source s'il est encodable ici (jpeg, png, webp), sinon PNG.
  const format: Encodable =
    o.format !== "origine"
      ? o.format
      : ENCODABLES.includes(source.format as Encodable)
        ? (source.format as Encodable)
        : "png";
  const sortie = await encoder(img, format, o.qualite).bytes();
  return {
    octets: sortie,
    type: TYPES[format],
    largeur: img.width,
    hauteur: img.height,
    source: { largeur: source.width, hauteur: source.height, format: source.format },
  };
}

/** Une seule page à la fois par processus (le backend Chrome pilote un navigateur par processus). */
let file: Promise<unknown> = Promise.resolve();

export function chromeDisponible(): boolean {
  return Boolean(
    Bun.env.BUN_CHROME_PATH ||
    Bun.which("chromium") ||
    Bun.which("chromium-browser") ||
    Bun.which("google-chrome") ||
    Bun.which("chrome") ||
    Bun.which("msedge") ||
    process.platform === "win32" ||
    process.platform === "darwin",
  );
}

export const servicesMedia = (verifierUrl: (u: string) => URL): Pick<Services, "image" | "video" | "navigateur"> => ({
  image: transformer,
  video: {
    async metadonnees(octets) {
      if (!Bun.Video?.available) throw new Error("décodeur vidéo indisponible");
      const m = await new Bun.Video(octets).metadata();
      return {
        largeur: m.width,
        hauteur: m.height,
        dureeS: m.duration,
        codec: m.codec,
        conteneur: m.container,
        images: m.frameCount,
        audio: (m.audioStreams ?? []).length > 0,
      };
    },
    async image(octets, secondes, largeur) {
      if (!Bun.Video?.available) throw new Error("décodeur vidéo indisponible");
      let f = new Bun.Video(octets).frame(secondes);
      if (largeur) f = f.resize(largeur);
      return f.jpeg({ quality: 85 }).bytes();
    },
    async gif(octets, debut, duree, largeur) {
      if (!Bun.Video?.available) throw new Error("décodeur vidéo indisponible");
      return new Uint8Array(
        await new Bun.Video(octets).gif({ start: debut, duration: duree, fps: 10, width: largeur }),
      );
    },
  },
  async navigateur(url, o) {
    verifierUrl(url);
    if (!chromeDisponible()) throw new Error("aucun navigateur Chrome ou Chromium sur ce serveur");
    const tache = file.then(async () => {
      await using vue = new Bun.WebView({
        width: o.largeur,
        height: o.hauteur,
        // Toujours un Chrome sans interface lancé par le serveur : jamais de rattachement au navigateur d'un poste.
        backend: {
          type: "chrome",
          url: false,
          ...(Bun.env.AUTO_CHROME_ARGS ? { argv: Bun.env.AUTO_CHROME_ARGS.split(" ").filter(Boolean) } : {}),
        },
      });
      await vue.navigate(url);
      if (o.attendreMs) await Bun.sleep(o.attendreMs);
      const titre = (await vue.evaluate("document.title")) as string;
      const texte = o.texte
        ? ((await vue.evaluate("document.body?.innerText ?? ''")) as string).slice(0, 200_000)
        : null;
      const capture = o.capture ? await vue.screenshot({ format: "png", encoding: "buffer" }) : null;
      return { titre, texte, capture };
    });
    file = tache.catch(() => undefined);
    return tache;
  },
});
