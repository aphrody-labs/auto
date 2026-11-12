// Page publique d'une facture (/facture/<jeton>) : montants, Factur-X et paiement par carte (Stripe Checkout).
// Au retour de Stripe (?session=…), la session est confirmée côté serveur avant tout message de réussite.
import "./site";

interface Vue {
  numero: string;
  statut: string;
  emetteur: string;
  client: string;
  date: string;
  echeance: string | null;
  totaux: { htCents: number; tvaCents: number; ttcCents: number };
  resteCents: number;
  payable: boolean;
  enregistre?: boolean;
}

const jeton = decodeURIComponent(location.pathname.split("/").filter(Boolean).at(-1) ?? "");
const base = `/v1/public/factures/${encodeURIComponent(jeton)}`;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const eur = (c: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(c / 100);
const dateFr = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("fr-FR", { dateStyle: "long" });

function afficher(v: Vue) {
  document.title = `Facture ${v.numero} · ${v.emetteur}`;
  $("titre-facture").textContent = `Facture ${v.numero}`;
  const echeance = v.echeance ? `, à régler avant le ${dateFr(v.echeance)}` : "";
  $("parties").textContent = `De ${v.emetteur} pour ${v.client}, émise le ${dateFr(v.date)}${echeance}.`;
  $("total-ht").textContent = eur(v.totaux.htCents);
  $("total-tva").textContent = eur(v.totaux.tvaCents);
  $("total-ttc").textContent = eur(v.totaux.ttcCents);
  $("reste").textContent = eur(v.resteCents);
  $<HTMLAnchorElement>("pdf").href = `${base}/pdf`;
  $("payer").textContent = `Payer ${eur(v.resteCents)} par carte`;
  $("paiement").hidden = !v.payable;
  const reponse = $("reponse");
  reponse.hidden = v.payable;
  reponse.textContent =
    v.resteCents === 0
      ? "Cette facture est réglée. Merci."
      : "Le paiement en ligne n'est pas proposé pour cette facture : contactez l'émetteur.";
  $("etat").hidden = true;
  $("facture").hidden = false;
}

const erreurChargement = (status?: number) =>
  status === 404
    ? "Ce lien est invalide ou a expiré. Demandez un nouveau lien à l'émetteur de la facture."
    : "La facture ne peut pas être chargée pour le moment. Réessayez dans quelques minutes.";

async function charger() {
  const session = new URLSearchParams(location.search).get("session");
  const r = session
    ? await fetch(`${base}/confirmation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session }),
      }).catch(() => null)
    : await fetch(base, { headers: { accept: "application/json" } }).catch(() => null);
  if (!r?.ok) {
    $("etat").textContent = erreurChargement(r?.status);
    return;
  }
  const v = (await r.json()) as Vue;
  afficher(v);
  if (session) {
    history.replaceState(null, "", location.pathname);
    if (v.enregistre || v.resteCents === 0) {
      $("reponse").textContent = "Paiement reçu. Merci : l'émetteur est prévenu.";
      $("reponse").hidden = false;
      $("reponse").focus();
    }
  }
}

$("payer").addEventListener("click", async () => {
  const bouton = $<HTMLButtonElement>("payer");
  const erreur = $("erreur");
  bouton.disabled = true;
  erreur.hidden = true;
  const r = await fetch(`${base}/paiement`, { method: "POST" }).catch(() => null);
  if (r?.ok) {
    location.assign(((await r.json()) as { url: string }).url);
    return;
  }
  bouton.disabled = false;
  erreur.textContent =
    r?.status === 409
      ? "Cette facture n'attend plus de paiement."
      : "Le paiement ne peut pas être ouvert pour le moment. Réessayez dans quelques minutes.";
  erreur.hidden = false;
});

await charger();
