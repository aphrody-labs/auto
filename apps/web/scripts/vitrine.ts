// Captures réelles pour la page d'accueil publique : une entreprise fictive (« Atelier Morel », studio de design à Lyon)
// avec clients, devis, factures, achats, équipe et absences, photographiée en 1440×900 en clair et en sombre.
// Usage : bun apps/web/scripts/vitrine.ts  →  apps/web/public/img/<nom>.webp et <nom>-sombre.webp
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { testDb, type Sql } from "@auto/store";
import { chromium } from "playwright-core";
import { creerApp } from "@auto/api/app";
import { cookieSession } from "@auto/tenancy";
import { demarrerWeb } from "../src/serveur";

const SORTIE = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "img");
const MDP = "un mot de passe très long";
const SIRET = "73282932000074";

function chrome(): string | null {
  if (Bun.env.AUTO_CHROME) return Bun.env.AUTO_CHROME;
  const racine =
    Bun.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(Bun.env.LOCALAPPDATA ?? join(Bun.env.HOME ?? "", ".cache"), "ms-playwright");
  for (const m of [
    "chromium_headless_shell-*/chrome-headless-shell-win64/chrome-headless-shell.exe",
    "chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell",
    "chromium-*/chrome-win64/chrome.exe",
    "chromium-*/chrome-linux64/chrome",
  ])
    for (const f of existsSync(racine) ? new Bun.Glob(m).scanSync({ cwd: racine, onlyFiles: true }) : [])
      return join(racine, f);
  return null;
}

const executable = chrome();
if (!executable) throw new Error("Chromium Playwright introuvable (AUTO_CHROME ou %LOCALAPPDATA%\\ms-playwright)");

const { sql, drop }: { sql: Sql; drop: () => Promise<void> } = await testDb();
const api = Bun.serve({
  port: 0,
  routes: creerApp(sql),
  fetch: () => Response.json({ erreur: "route inconnue" }, { status: 404 }),
});
const web = demarrerWeb({ api: api.url });
const navigateur = await chromium.launch({ executablePath: executable });

async function appel(chemin: string, session: string, corps?: unknown, type = "application/json"): Promise<any> {
  const r = await fetch(new URL(chemin, api.url), {
    method: corps === undefined ? "GET" : "POST",
    headers: { "content-type": type, authorization: `Bearer ${session}` },
    ...(corps === undefined ? {} : { body: type === "application/json" ? JSON.stringify(corps) : (corps as string) }),
  });
  if (!r.ok) throw new Error(`${chemin} : ${r.status} ${await r.text()}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text();
}

async function inscrire(email: string, nom: string, adresse: string): Promise<string> {
  const r = await fetch(new URL("/v1/auth/inscription", api.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, motDePasse: MDP, entreprise: { nom, siret: SIRET, adresse } }),
  });
  if (!r.ok) throw new Error(`inscription ${nom} : ${r.status} ${await r.text()}`);
  return ((await r.json()) as { session: string }).session;
}

/** Date AAAA-MM-JJ située `n` jours avant aujourd'hui (négatif : dans le futur). */
const il_y_a = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

try {
  const atelier = await inscrire(
    "contact@atelier-morel.example",
    "Atelier Morel",
    "14 rue de la République, 69002 Lyon",
  );

  // Plan Pro actif : le plan Gratuit plafonne à 10 factures émises par mois, or toute l'histoire est émise aujourd'hui.
  await sql`INSERT INTO abonnement (tenant_id, plan, statut, periode_fin)
    SELECT id, 'pro', 'active', now() + interval '30 days' FROM tenant
    ON CONFLICT (tenant_id) DO UPDATE SET plan = 'pro', statut = 'active', periode_fin = EXCLUDED.periode_fin`;

  const CLIENTS = [
    ["Brasserie Lumière", "8 quai Saint-Antoine, 69002 Lyon", "compta@brasserie-lumiere.example"],
    ["Studio Hélios", "21 rue Garibaldi, 69003 Lyon", "admin@studio-helios.example"],
    ["Maison Verdier", "5 place Bellecour, 69002 Lyon", "factures@maison-verdier.example"],
    ["Atelier Fontaine", "32 rue des Tanneurs, 69007 Lyon", "bonjour@atelier-fontaine.example"],
    ["Cave des Pierres Dorées", "12 route de Villefranche, 69380 Lozanne", "gestion@cave-pierres-dorees.example"],
    ["Hôtel Belvédère", "2 montée de la Grande-Côte, 69001 Lyon", "direction@hotel-belvedere.example"],
    ["Librairie Cassis", "17 rue Mercière, 69002 Lyon", "contact@librairie-cassis.example"],
    ["Coopérative Les Voraces", "9 rue Imbert-Colomès, 69001 Lyon", "compta@voraces.example"],
  ] as const;
  const client = (i: number) => ({
    nom: CLIENTS[i]![0],
    siret: SIRET,
    adresse: CLIENTS[i]![1],
    email: CLIENTS[i]![2],
  });
  for (let i = 0; i < CLIENTS.length; i++) await appel("/v1/clients", atelier, client(i));

  /** Crée un document ; `etat` le mène jusqu'au statut voulu. */
  type Etat = "brouillon" | "emis" | "envoye" | "accepte" | "paye";
  async function doc(o: {
    type: "devis" | "facture" | "avoir";
    client: number;
    ilYa: number;
    designation: string;
    quantite: number;
    prixEuros: number;
    etat: Etat;
    echeanceJours?: number;
    origine?: string;
  }): Promise<{ id: string; numero: string }> {
    const date = il_y_a(o.ilYa);
    const d = await appel("/v1/documents", atelier, {
      type: o.type,
      date,
      client: client(o.client),
      lignes: [{ designation: o.designation, quantite: o.quantite, prixUnitaireHtCents: o.prixEuros * 100, tva: 200 }],
      ...(o.type === "devis"
        ? { echeance: il_y_a(o.ilYa - 30) }
        : { datePrestation: date, echeance: il_y_a(o.ilYa - (o.echeanceJours ?? 30)) }),
      ...(o.origine ? { origine: o.origine } : {}),
    });
    if (o.etat === "brouillon") return { id: d.id, numero: "" };
    const e = await appel(`/v1/documents/${d.id}/emettre`, atelier, {});
    if (o.etat === "envoye") await appel(`/v1/documents/${d.id}/statut`, atelier, { statut: "envoye" });
    if (o.etat === "accepte") await appel(`/v1/documents/${d.id}/statut`, atelier, { statut: "accepte" });
    if (o.etat === "paye") {
      const ttc = o.quantite * o.prixEuros * 120;
      await appel(`/v1/documents/${d.id}/paiements`, atelier, {
        date: il_y_a(Math.max(o.ilYa - 18, 1)),
        montantCents: ttc,
        mode: "virement",
      });
    }
    return { id: d.id, numero: e.numero };
  }

  // Chronologique (numérotation) : de juillet à ce mois-ci.
  await doc({
    type: "facture",
    client: 4,
    ilYa: 112,
    designation: "Étiquettes et coffret cuvée 2026",
    quantite: 3,
    prixEuros: 1300,
    etat: "paye",
  });
  await doc({
    type: "facture",
    client: 5,
    ilYa: 105,
    designation: "Signalétique intérieure de l'hôtel",
    quantite: 2,
    prixEuros: 800,
    etat: "paye",
  });
  await doc({
    type: "facture",
    client: 3,
    ilYa: 98,
    designation: "Identité visuelle : logotype et charte",
    quantite: 4,
    prixEuros: 550,
    etat: "paye",
  });
  await doc({
    type: "facture",
    client: 0,
    ilYa: 80,
    designation: "Carte et menus de la brasserie",
    quantite: 4,
    prixEuros: 600,
    etat: "paye",
  });
  await doc({
    type: "facture",
    client: 2,
    ilYa: 74,
    designation: "Maquettes du catalogue automne",
    quantite: 3,
    prixEuros: 600,
    etat: "envoye",
    echeanceJours: 30,
  });
  await doc({
    type: "facture",
    client: 6,
    ilYa: 68,
    designation: "Affiche des rencontres littéraires",
    quantite: 1,
    prixEuros: 300,
    etat: "paye",
  });
  await doc({
    type: "facture",
    client: 1,
    ilYa: 52,
    designation: "Direction artistique de la campagne",
    quantite: 5,
    prixEuros: 250,
    etat: "paye",
  });
  const hotel = await doc({
    type: "facture",
    client: 5,
    ilYa: 44,
    designation: "Refonte du site vitrine : maquettes",
    quantite: 6,
    prixEuros: 900,
    etat: "envoye",
    echeanceJours: 30,
  });
  await doc({
    type: "facture",
    client: 4,
    ilYa: 38,
    designation: "Brochure de la fête des vendanges",
    quantite: 2,
    prixEuros: 1550,
    etat: "paye",
  });
  await doc({
    type: "avoir",
    client: 5,
    ilYa: 20,
    designation: "Avoir : une maquette non livrée",
    quantite: 1,
    prixEuros: 900,
    etat: "emis",
    origine: hotel.numero,
  });
  await doc({
    type: "facture",
    client: 0,
    ilYa: 18,
    designation: "Packaging des bières de saison",
    quantite: 3,
    prixEuros: 1400,
    etat: "paye",
  });
  await doc({
    type: "facture",
    client: 2,
    ilYa: 9,
    designation: "Identité de la nouvelle gamme",
    quantite: 8,
    prixEuros: 850,
    etat: "envoye",
    echeanceJours: 30,
  });
  await doc({
    type: "facture",
    client: 1,
    ilYa: 6,
    designation: "Déclinaisons réseaux sociaux",
    quantite: 7,
    prixEuros: 400,
    etat: "emis",
    echeanceJours: 30,
  });
  await doc({
    type: "facture",
    client: 7,
    ilYa: 3,
    designation: "Rapport d'activité 2026 : mise en page",
    quantite: 4,
    prixEuros: 525,
    etat: "emis",
    echeanceJours: 30,
  });
  await doc({
    type: "facture",
    client: 3,
    ilYa: 1,
    designation: "Illustrations du livret",
    quantite: 2,
    prixEuros: 475,
    etat: "brouillon",
  });

  await doc({
    type: "devis",
    client: 6,
    ilYa: 25,
    designation: "Refonte de l'identité de la librairie",
    quantite: 4,
    prixEuros: 475,
    etat: "accepte",
  });
  await doc({
    type: "devis",
    client: 5,
    ilYa: 8,
    designation: "Livret d'accueil des chambres",
    quantite: 4,
    prixEuros: 800,
    etat: "envoye",
  });
  const devis = await doc({
    type: "devis",
    client: 3,
    ilYa: 2,
    designation: "Identité visuelle et site vitrine",
    quantite: 8,
    prixEuros: 575,
    etat: "emis",
  });
  await doc({
    type: "devis",
    client: 7,
    ilYa: 1,
    designation: "Signalétique du tiers-lieu",
    quantite: 3,
    prixEuros: 900,
    etat: "brouillon",
  });

  // Factures reçues : trois fournisseurs fictifs déposent leur Factur-X ; l'une a un total falsifié (à vérifier).
  const jeton = (await appel("/v1/jetons", atelier, { nom: "achats" })).jeton as string;
  const fournisseurs: [string, string, string, number, boolean][] = [
    ["Imprimerie du Rhône", "compta@imprimerie-rhone.example", "Impression offset : 2 000 brochures", 184000, false],
    [
      "Nuage Hébergement SAS",
      "factures@nuage-hebergement.example",
      "Hébergement et nom de domaine, 12 mois",
      54000,
      true,
    ],
    ["Papeterie Saint-Jean", "ventes@papeterie-saint-jean.example", "Papiers d'échantillons et reliures", 36500, false],
  ];
  for (const [nom, email, designation, prix, falsifie] of fournisseurs) {
    const f = await inscrire(email, nom, "1 zone artisanale, 69000 Lyon");
    const d = await appel("/v1/documents", f, {
      type: "facture",
      date: il_y_a(12),
      client: { nom: "Atelier Morel", siret: SIRET, adresse: "14 rue de la République, 69002 Lyon" },
      lignes: [{ designation, quantite: 1, prixUnitaireHtCents: prix, tva: 200 }],
      datePrestation: il_y_a(14),
      echeance: il_y_a(-18),
    });
    await appel(`/v1/documents/${d.id}/emettre`, f, {});
    let xml: string = await appel(`/v1/documents/${d.id}/xml`, f);
    if (falsifie) xml = xml.replace(/(<ram:GrandTotalAmount[^>]*>)[^<]+/, "$1699.00");
    await appel("/v1/factures-recues", jeton, xml, "application/xml");
  }

  // Équipe de cinq personnes et quelques absences.
  const EQUIPE = [
    ["Lefèvre", "Camille", "Directrice artistique", "cdi", "2021-09-01", 100, 410000],
    ["Marchand", "Théo", "Designer graphique", "cdi", "2022-03-14", 100, 320000],
    ["Benoît", "Salomé", "Illustratrice", "cdi", "2023-01-09", 80, 270000],
    ["Garnier", "Hugo", "Développeur front", "cdi", "2026-02-02", 100, 340000],
    ["Roussel", "Inès", "Apprentie designer", "apprentissage", "2025-09-01", 100, 130000],
  ] as const;
  const ids: string[] = [];
  for (const [nom, prenom, poste, contrat, dateEntree, tempsTravail, salaireBrutMensuelCents] of EQUIPE) {
    const e = await appel("/v1/employes", atelier, {
      nom,
      prenom,
      poste,
      contrat,
      dateEntree,
      tempsTravail,
      salaireBrutMensuelCents,
    });
    ids.push(e.id);
  }
  const absence = async (i: number, type: string, debut: string, fin: string, motif: string, decision?: string) => {
    const a = await appel(`/v1/employes/${ids[i]}/absences`, atelier, { type, debut, fin, motif });
    if (decision) await appel(`/v1/absences/${a.id}/decision`, atelier, { statut: decision });
  };
  await absence(0, "conges_payes", il_y_a(70), il_y_a(64), "Vacances d'été", "validee");
  await absence(1, "rtt", il_y_a(20), il_y_a(20), "RTT", "validee");
  await absence(2, "maladie", il_y_a(12), il_y_a(10), "Arrêt maladie", "validee");
  await absence(1, "conges_payes", il_y_a(-17), il_y_a(-20), "Vacances de la Toussaint");
  await absence(3, "conges_payes", il_y_a(-29), il_y_a(-30), "Pont de fin d'année");
  await absence(4, "evenement_familial", il_y_a(-8), il_y_a(-9), "Mariage d'un proche");

  // Captures.
  const ECRANS: [string, string, string][] = [
    ["hero-tableau", "/app", "Tableau de bord"],
    ["tour-factures", "/app/factures", "Factures"],
    ["tour-devis", `/app/documents/${devis.id}`, "Partager le lien"],
    ["tour-achats", "/app/achats", "Factures reçues"],
    ["tour-equipe", "/app/employes", "Employés"],
    ["tour-exports", "/app/exports", "Exports comptables"],
  ];
  mkdirSync(SORTIE, { recursive: true });
  let total = 0;
  for (const theme of ["clair", "sombre"] as const) {
    const ctx = await navigateur.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      locale: "fr-FR",
      colorScheme: theme === "sombre" ? "dark" : "light",
    });
    await ctx.addCookies([{ ...(await cookieSession(sql, atelier)), url: web.url.toString() }]);
    await ctx.addInitScript((t) => localStorage.setItem("auto-theme", t), theme);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error(`[navigateur] ${e.message}`));
    for (const [nom, chemin, attendu] of ECRANS) {
      await page.goto(new URL(chemin, web.url).toString(), { waitUntil: "networkidle" });
      if (nom === "tour-achats") await page.getByRole("button", { name: "Toutes" }).click();
      await page.getByText(attendu, { exact: false }).first().waitFor();
      await page.waitForFunction(() => !document.querySelector(".squelette"));
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);
      const png = await page.screenshot({ type: "png" });
      let q = 82;
      let octets = await new Bun.Image(png).webp({ quality: q }).bytes();
      const fichier = theme === "sombre" ? `${nom}-sombre.webp` : `${nom}.webp`;
      await Bun.write(join(SORTIE, fichier), octets);
      total += octets.byteLength;
      console.log(`${fichier} : ${(octets.byteLength / 1024).toFixed(0)} Ko`);
    }
    await ctx.close();
  }
  console.log(`Total : ${(total / 1024).toFixed(0)} Ko`);
} finally {
  await navigateur.close();
  await web.stop(true);
  await api.stop(true);
  await drop();
}
