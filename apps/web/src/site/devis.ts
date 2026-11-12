// Page publique d'un devis (/devis/<jeton>) : consultation, PDF et réponse du client, sans compte.
// Tout le contenu est inséré en texte (aucun HTML venu de l'API).
import "./site";

interface Vue {
  numero: string;
  statut: string;
  emetteur: string;
  client: string;
  date: string;
  validiteJours: number | null;
  lignes: { designation: string; quantite: number; prixUnitaireHtCents: number }[];
  totaux: { htCents: number; tvaCents: number; ttcCents: number };
  decidable: boolean;
}

const jeton = decodeURIComponent(location.pathname.split("/").filter(Boolean).at(-1) ?? "");
const base = `/v1/public/devis/${encodeURIComponent(jeton)}`;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const eur = (c: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(c / 100);
const dateFr = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("fr-FR", { dateStyle: "long" });
const REPONSES: Record<string, string> = {
  accepte: "Devis accepté. L'émetteur est prévenu et vous enverra la suite.",
  refuse: "Devis refusé. L'émetteur est prévenu.",
};

function afficher(v: Vue) {
  document.title = `Devis ${v.numero} · ${v.emetteur}`;
  $("titre-devis").textContent = `Devis ${v.numero}`;
  const validite = v.validiteJours ? `, valable ${v.validiteJours} jours` : "";
  $("parties").textContent = `De ${v.emetteur} pour ${v.client}, émis le ${dateFr(v.date)}${validite}.`;
  $("lignes").replaceChildren(
    ...v.lignes.map((l) => {
      const tr = document.createElement("tr");
      for (const [texte, num] of [
        [l.designation, false],
        [new Intl.NumberFormat("fr-FR").format(l.quantite), true],
        [eur(l.prixUnitaireHtCents), true],
      ] as const) {
        const td = document.createElement("td");
        td.textContent = texte;
        if (num) td.className = "num";
        tr.append(td);
      }
      return tr;
    }),
  );
  $("total-ht").textContent = eur(v.totaux.htCents);
  $("total-tva").textContent = eur(v.totaux.tvaCents);
  $("total-ttc").textContent = eur(v.totaux.ttcCents);
  $<HTMLAnchorElement>("pdf").href = `${base}/pdf`;
  $("decision").hidden = !v.decidable;
  const reponse = $("reponse");
  reponse.hidden = v.decidable;
  reponse.textContent = REPONSES[v.statut] ?? "Ce devis n'attend plus de réponse.";
  $("etat").hidden = true;
  $("devis").hidden = false;
}

async function charger() {
  const r = await fetch(base, { headers: { accept: "application/json" } }).catch(() => null);
  if (!r?.ok) {
    $("etat").textContent =
      r?.status === 404
        ? "Ce lien est invalide ou a expiré. Demandez un nouveau lien à l'émetteur du devis."
        : "Le devis ne peut pas être chargé pour le moment. Réessayez dans quelques minutes.";
    return;
  }
  afficher((await r.json()) as Vue);
}

$<HTMLFormElement>("decision").addEventListener("submit", async (e) => {
  e.preventDefault();
  const bouton = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  const champ = $<HTMLInputElement>("nom");
  const erreur = $("erreur");
  const nom = champ.value.trim();
  if (!nom) {
    erreur.textContent = "Indiquez votre nom et votre fonction.";
    erreur.hidden = false;
    champ.setAttribute("aria-invalid", "true");
    champ.focus();
    return;
  }
  champ.removeAttribute("aria-invalid");
  erreur.hidden = true;
  for (const b of $("decision").querySelectorAll("button")) b.disabled = true;
  const r = await fetch(`${base}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: bouton?.value, nom }),
  }).catch(() => null);
  if (r?.ok) {
    afficher((await r.json()) as Vue);
    $("reponse").focus();
    return;
  }
  for (const b of $("decision").querySelectorAll("button")) b.disabled = false;
  erreur.textContent =
    r?.status === 409
      ? "Ce devis a déjà reçu une réponse."
      : "La réponse n'a pas pu être enregistrée. Réessayez dans quelques minutes.";
  erreur.hidden = false;
});

await charger();
