import "./site";
import type { Catalogue, Distribution } from "../distributions";

const liste = document.getElementById("distributions")!;
const etat = document.getElementById("version-disponible")!;
const notes = document.getElementById("notes-distributions")!;
function texte<K extends keyof HTMLElementTagNameMap>(tag: K, contenu: string) {
  const e = document.createElement(tag);
  e.textContent = contenu;
  return e;
}
function carte(a: Distribution) {
  const article = document.createElement("article");
  article.className = "distribution";
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.classList.add("icone");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("width", "24");
  use.setAttribute("height", "24");
  use.setAttribute("href", "/icones/symboles.svg#FileDown");
  icon.append(use);
  article.append(
    icon,
    texte("h3", a.nom),
    texte(
      "p",
      `${a.architecture} · ${(a.octets / 1024 / 1024).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`,
    ),
  );
  const description =
    a.type === "autonome"
      ? "Serveur autonome : PostgreSQL et configuration nécessaires."
      : a.type === "apk"
        ? "APK Android : installation manuelle avec confirmation système."
        : a.type === "portable"
          ? "Version portable : décompressez le dossier complet avant le lancement."
          : "Installateur de l’application connectée à votre instance Auto.";
  article.append(texte("p", description));
  const lien = texte("a", `Télécharger ${a.nom}`);
  lien.className = "bouton bouton-primaire";
  lien.href = `/downloads/${encodeURIComponent(a.fichier)}`;
  lien.download = a.fichier;
  article.append(lien);
  const details = document.createElement("details");
  details.append(texte("summary", "Empreinte SHA-256"), texte("code", a.sha256));
  article.append(details);
  return article;
}
try {
  const r = await fetch("/api/distributions", { cache: "no-cache" });
  if (!r.ok) throw Error("catalogue");
  const c = (await r.json()) as Catalogue;
  if (!c.fichiers?.length) {
    liste.replaceChildren();
    etat.textContent = "Les paquets sont en cours de publication. Auto reste disponible dans votre navigateur.";
  } else {
    etat.textContent = `Version ${c.version} · publiée le ${new Date(c.date).toLocaleDateString("fr-FR")}`;
    liste.replaceChildren(...c.fichiers.map(carte));
    notes.textContent = c.notes ?? "";
  }
} catch {
  liste.replaceChildren();
  etat.textContent = "Le catalogue est momentanément indisponible. Vous pouvez utiliser Auto dans votre navigateur.";
}
