/// <reference types="chrome" />
// Popup : réglages (instance, jeton API) testés contre /v1/moi, et état des factures à vérifier.
import { INSTANCE_PAR_DEFAUT, erreurApi, jetonValide, motifHote, normaliserInstance } from "./lib";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("reglages");
const champInstance = $<HTMLInputElement>("instance");
const champJeton = $<HTMLInputElement>("jeton");
const erreur = $<HTMLParagraphElement>("erreur");
const bouton = $<HTMLButtonElement>("enregistrer");

function afficherErreur(message: string | null, champ?: HTMLInputElement) {
  for (const c of [champInstance, champJeton]) c.removeAttribute("aria-invalid");
  erreur.hidden = !message;
  erreur.textContent = message ?? "";
  if (champ) {
    champ.setAttribute("aria-invalid", "true");
    champ.setAttribute("aria-errormessage", "erreur");
    champ.focus();
  }
}

async function afficherEtat() {
  const s = await chrome.storage.local.get(["instance", "jeton", "aVerifier", "entreprise", "erreurBadge"]);
  const instance = (s.instance as string) || INSTANCE_PAR_DEFAUT;
  champInstance.value = instance;
  const resume = $("resume");
  const ouvrir = $<HTMLAnchorElement>("ouvrir");
  if (!s.jeton) {
    resume.textContent = "Extension non configurée : renseignez votre jeton API ci-dessous.";
    ouvrir.hidden = true;
    return;
  }
  const n = Number(s.aVerifier ?? 0);
  const qui = s.entreprise ? `${s.entreprise} : ` : "";
  resume.textContent = s.erreurBadge
    ? `Connexion à ${new URL(instance).host} impossible : ${s.erreurBadge}`
    : `${qui}${n === 0 ? "aucune facture à vérifier." : `${n} facture(s) à vérifier.`}`;
  ouvrir.href = `${instance}/app/achats`;
  ouvrir.hidden = false;
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  let instance: string;
  try {
    instance = normaliserInstance(champInstance.value || INSTANCE_PAR_DEFAUT);
  } catch (err) {
    afficherErreur((err as Error).message, champInstance);
    return;
  }
  const jeton = champJeton.value.trim();
  if (!jetonValide(jeton)) {
    afficherErreur("Jeton invalide : il commence par « auto_ ».", champJeton);
    return;
  }
  // Une instance autre que auto.aphrody.com demande son autorisation dans le geste de l'utilisateur, avant tout await.
  const autorisation =
    instance === INSTANCE_PAR_DEFAUT
      ? Promise.resolve(true)
      : chrome.permissions.request({ origins: [motifHote(instance)] });
  void (async () => {
    bouton.disabled = true;
    bouton.textContent = "Test en cours…";
    try {
      if (!(await autorisation)) {
        afficherErreur("Accès à l'instance refusé : rien n'a été enregistré.");
        return;
      }
      const r = await fetch(`${instance}/v1/moi`, { headers: { authorization: `Bearer ${jeton}` } });
      const corps = await r.json().catch(() => null);
      if (!r.ok) {
        afficherErreur(erreurApi(r.status, corps), r.status === 401 ? champJeton : undefined);
        return;
      }
      const moi = corps as { entreprise?: { nom?: string } };
      await chrome.storage.local.set({ instance, jeton, entreprise: moi.entreprise?.nom ?? null });
      champJeton.value = "";
      afficherErreur(null);
      await chrome.runtime.sendMessage({ type: "majBadge" });
      await afficherEtat();
    } catch (err) {
      afficherErreur(`Instance injoignable : ${(err as Error).message}`, champInstance);
    } finally {
      bouton.disabled = false;
      bouton.textContent = "Enregistrer et tester";
    }
  })();
});

void afficherEtat();
