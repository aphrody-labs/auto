/// <reference types="chrome" />
// Service worker de l'extension auto : menu contextuel « Envoyer la facture à auto » et badge des factures à
// vérifier. Aucun état en variable globale : réglages et compteurs vivent dans chrome.storage.
import {
  INSTANCE_PAR_DEFAUT,
  TAILLE_MAX,
  erreurApi,
  messageDepot,
  motifHote,
  nomFichier,
  texteBadge,
  typeFichier,
  urlDepot,
  type Recue,
  type Reglages,
} from "./lib";

const MENU_LIEN = "envoyer-lien";
const MENU_PAGE = "envoyer-page";
const ALARME = "badge";
/** Couleur du badge : rôle M3 primary de @auto/ui (thème clair) ; l'API du badge exige une couleur explicite. */
const COULEUR_BADGE = "#056b5b";

async function reglages(): Promise<Reglages> {
  const r = await chrome.storage.local.get(["instance", "jeton"]);
  return { instance: (r.instance as string) || INSTANCE_PAR_DEFAUT, jeton: (r.jeton as string) || "" };
}

async function notifier(titre: string, message: string) {
  await chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title: titre,
    message,
  });
}

async function majBadge() {
  const { instance, jeton } = await reglages();
  if (!jeton) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  try {
    const r = await fetch(`${instance}/v1/factures-recues?statut=a_verifier`, {
      headers: { authorization: `Bearer ${jeton}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const n = ((await r.json()) as unknown[]).length;
    await chrome.storage.local.set({ aVerifier: n, derniereMaj: new Date().toISOString(), erreurBadge: null });
    await chrome.action.setBadgeBackgroundColor({ color: COULEUR_BADGE });
    await chrome.action.setBadgeText({ text: texteBadge(n) });
    await chrome.action.setTitle({
      title: n ? `auto : ${n} facture(s) à vérifier` : "auto : aucune facture à vérifier",
    });
  } catch (e) {
    await chrome.storage.local.set({ erreurBadge: e instanceof Error ? e.message : String(e) });
    await chrome.action.setBadgeText({ text: "" });
  }
}

async function envoyer(url: string, autorisation: Promise<boolean>) {
  try {
    if (!(await autorisation))
      return await notifier("Accès refusé", "Sans accès à ce site, auto ne peut pas récupérer la facture.");
    const { instance, jeton } = await reglages();
    if (!jeton) {
      await notifier("Extension à configurer", "Ajoutez votre jeton API auto dans les réglages de l'extension.");
      return await chrome.runtime.openOptionsPage();
    }
    const source = await fetch(url, { credentials: "include" });
    if (!source.ok) throw new Error(`Téléchargement impossible (HTTP ${source.status})`);
    const octets = new Uint8Array(await source.arrayBuffer());
    if (octets.length > TAILLE_MAX) throw new Error("Fichier trop volumineux (20 Mo au plus)");
    const type = typeFichier(octets);
    if (!type) throw new Error("Ce lien ne mène ni à un PDF ni à une facture XML");
    const nom = nomFichier(url, source.headers.get("content-disposition"), type);
    const r = await fetch(urlDepot(instance, nom), {
      method: "POST",
      headers: { authorization: `Bearer ${jeton}`, "content-type": type },
      body: octets,
    });
    const corps = await r.json().catch(() => null);
    if (!r.ok) throw new Error(erreurApi(r.status, corps));
    const m = messageDepot(corps as Recue, nom);
    await notifier(m.titre, m.message);
    await majBadge();
  } catch (e) {
    await notifier("Envoi impossible", e instanceof Error ? e.message : String(e));
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.create({ id: MENU_LIEN, title: "Envoyer la facture à auto", contexts: ["link"] });
  // Page ouverte dans le lecteur PDF de Chrome, ou XML affiché : même action sur la page elle-même.
  chrome.contextMenus.create({
    id: MENU_PAGE,
    title: "Envoyer cette facture à auto",
    contexts: ["page"],
    documentUrlPatterns: ["*://*/*.pdf", "*://*/*.pdf?*", "*://*/*.xml", "*://*/*.xml?*"],
  });
  await chrome.alarms.create(ALARME, { periodInMinutes: 15 });
  await majBadge();
});

chrome.runtime.onStartup.addListener(() => void majBadge());

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARME) void majBadge();
});

chrome.contextMenus.onClicked.addListener((info) => {
  const cible = info.menuItemId === MENU_LIEN ? info.linkUrl : info.pageUrl;
  if (!cible || !/^https?:/.test(cible)) {
    void notifier("Lien non pris en charge", "Seuls les liens http(s) vers un PDF ou un XML peuvent être envoyés.");
    return;
  }
  // Le clic donne accès à l'onglet courant (activeTab). Un fichier hébergé ailleurs exige une autorisation
  // demandée ici même, avant tout await : le geste de l'utilisateur ne survit pas à une attente.
  const autreSite = new URL(cible).origin !== new URL(info.pageUrl ?? cible).origin;
  const autorisation = autreSite ? chrome.permissions.request({ origins: [motifHote(cible)] }) : Promise.resolve(true);
  void envoyer(cible, autorisation);
});

// Messages des pages de l'extension uniquement (popup, tests) : mise à jour du badge, envoi d'une URL de facture.
chrome.runtime.onMessage.addListener((m: { type?: string; url?: string }, expediteur, repondre) => {
  // Pages de l'extension seulement : un script de contenu aurait l'URL d'une page web.
  if (expediteur.id !== chrome.runtime.id || !expediteur.url?.startsWith(chrome.runtime.getURL(""))) return false;
  const action =
    m?.type === "majBadge"
      ? majBadge
      : m?.type === "envoyer" && typeof m.url === "string" && /^https?:/.test(m.url)
        ? () => envoyer(m.url!, Promise.resolve(true))
        : null;
  if (!action) return false;
  (async () => {
    await action();
    repondre({ ok: true });
  })();
  return true;
});
