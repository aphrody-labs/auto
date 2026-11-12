// Captures de communication : application réelle, base jetable et données fictives BTP.
import { demarrerBanc, chrome } from "../apps/web/e2e/support";
import { enregistrerRecue, enregistrerDevisRecu, withTenant } from "../packages/store/src";

const root = `${process.cwd()}/dist/lancement-btp`;
await Bun.write(`${root}/captures/.keep`, "");
const exe = chrome();
if (!exe) throw new Error("Chromium requis");
const banc = await demarrerBanc(exe);
const manifest: unknown[] = [];
try {
  const session = await banc.inscrire("presentation@batir-ensemble.example", "Bâtir ensemble · Démonstration");
  const appel = async (path: string, body?: unknown, method?: string) => {
    const res = await fetch(new URL(path, banc.api.url), {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.json() as Promise<any>;
  };
  const client = await appel("/v1/clients", {
    nom: "Maison Moreau",
    adresse: "12 allée des Pins, Lyon",
    email: "maison.moreau@example.fr",
    siret: "",
  });
  const fournisseur = await appel("/v1/fournisseurs", {
    nom: "Matériaux Provence",
    contact: "Service livraison",
    email: "materiaux@example.fr",
  });
  const chantier = await appel("/v1/chantiers", {
    nom: "Villa des Pins",
    code: "CH-001",
    clientId: client.id,
    adresse: "12 allée des Pins, Lyon",
    budgetHtCents: 4800000,
    avancement: 70,
    statut: "en_cours",
  });
  const doc = async (type: "devis" | "facture", prix: number, designation: string) => {
    const d = await appel("/v1/documents", {
      type,
      clientId: client.id,
      client: {
        nom: "Maison Moreau",
        adresse: "12 allée des Pins, Lyon",
        email: "maison.moreau@example.fr",
        siret: "",
      },
      lignes: [{ designation, quantite: 1, prixUnitaireHtCents: prix, tva: 200 }],
      date: "2026-10-25",
      datePrestation: "2026-10-25",
      echeance: "2026-11-25",
    });
    await appel(`/v1/documents/${d.id}/chantier`, { chantierId: chantier.id }, "PUT");
    return d;
  };
  const devis = await doc("devis", 4800000, "Rénovation Villa des Pins — maçonnerie et menuiseries");
  const facture = await doc("facture", 2000000, "Travaux de maçonnerie — première phase du chantier");
  await appel(`/v1/documents/${facture.id}/emettre`, {});
  await appel(`/v1/documents/${facture.id}/paiements`, { date: "2026-10-25", montantCents: 1200000, mode: "virement" });
  const moi = await appel("/v1/moi");
  await withTenant(banc.sql, moi.tenantId, (tx) =>
    enregistrerDevisRecu(
      tx,
      null,
      {
        contenu: new TextEncoder().encode("Devis fictif : pose de deux fenêtres, 600 euros TTC"),
        nom: "devis-menuiserie.pdf",
        typeMime: "application/pdf",
        canal: "api",
      },
      {
        devis: {
          type: "devis",
          numero: "DEV-PROVENCE",
          date: "2026-10-25",
          devise: "EUR",
          fournisseur: { nom: "Menuiserie Provence", siret: "73282932000074", adresse: "1 rue des Artisans" },
          lignes: [
            { designation: "Pose des fenêtres", quantite: 2, prixUnitaireHtCents: 25000, tauxTva: 200, htCents: 50000 },
          ],
          totaux: { htCents: 50000, tvaCents: 10000, ttcCents: 60000 },
        },
        texte: "Pose de deux fenêtres, 600 euros TTC",
        anomalies: [],
      },
    ),
  );
  const recu = await withTenant(banc.sql, moi.tenantId, (tx) =>
    enregistrerRecue(
      tx,
      null,
      {
        contenu: new TextEncoder().encode("Pièce fictive de démonstration BTP"),
        typeMime: "application/pdf",
        canal: "api",
      },
      {
        source: "ocr",
        statut: "a_verifier",
        anomalies: [],
        facture: {
          type: "facture",
          numero: "MAT-2026-084",
          date: "2026-10-25",
          devise: "EUR",
          fournisseur: { nom: "Matériaux Provence" },
          lignes: [],
          totaux: { htCents: 850000, tvaCents: 170000, ttcCents: 1020000 },
        },
      },
    ),
  );
  await appel(
    `/v1/factures-recues/${recu.id}/affectation`,
    { fournisseurId: fournisseur.id, chantierId: chantier.id },
    "PUT",
  );
  const sessionCtx = await banc.connecte(session, 1600);
  await Bun.write(`${root}/parcours-brut/.keep`, "");
  const ctx = await banc.navigateur.newContext({
    viewport: { width: 1600, height: 900 },
    locale: "fr-FR",
    recordVideo: { dir: `${root}/parcours-brut`, size: { width: 1600, height: 900 } },
  });
  await ctx.addCookies(await sessionCtx.cookies());
  await sessionCtx.close();
  const p = await ctx.newPage();
  const erreurs: string[] = [];
  p.on("pageerror", (e) => erreurs.push(e.message));
  const snap = async (name: string, path: string, heading?: string) => {
    await p.goto(banc.url(path), { waitUntil: "networkidle" });
    if (heading) await p.getByRole("heading", { name: heading, exact: true }).waitFor();
    await p.evaluate(() => document.fonts.ready);
    const titre = await p.locator("h1").first().innerText();
    if (/introuvable|connexion/i.test(titre)) throw new Error(`Écran inattendu pour ${path} : ${titre}`);
    await p.screenshot({ path: `${root}/captures/${name}.png`, animations: "disabled" });
    manifest.push({
      file: `${name}.png`,
      origin: "Application réelle sur base jetable",
      path,
      date: "2026-10-25",
      demo: true,
      heading: titre,
    });
    console.log("capture", name);
  };
  await snap("tableau", "/app");
  await snap("chantiers", "/app/chantiers");
  await snap("chantier", `/app/chantiers/${chantier.id}`, "Villa des Pins");
  await p.getByRole("link", { name: "Créer un devis", exact: true }).click();
  await p.getByLabel("Désignation, ligne 1").fill("Travaux de maçonnerie et pose des fenêtres");
  await p.getByLabel("Prix unitaire HT (€)").fill("48000");
  await p.screenshot({ path: `${root}/captures/devis-editeur.png`, animations: "disabled" });
  manifest.push({
    file: "devis-editeur.png",
    origin: "Éditeur réel, saisie dans le navigateur",
    path: "/app/documents/nouveau",
    demo: true,
  });
  await snap("devis", "/app/devis");
  await snap("devis-detail", `/app/documents/${devis.id}`);
  await snap("facture", `/app/documents/${facture.id}`);
  await snap("achats", "/app/achats");
  await p.getByRole("button", { name: "Valider", exact: true }).click();
  await snap("analytique", `/app/chantiers/${chantier.id}`, "Villa des Pins");
  await snap("livraisons", "/app/livraisons");
  await p.getByRole("button", { name: "Nouvelle pièce", exact: true }).click();
  const modale = p.getByRole("dialog");
  await modale.getByLabel("Référence fournisseur").fill("BL-042");
  await modale.getByRole("combobox", { name: /^Fournisseur/ }).selectOption({ label: "Matériaux Provence" });
  await modale.getByRole("combobox", { name: /^Chantier/ }).selectOption({ label: "CH-001 · Villa des Pins" });
  await modale.getByLabel("Désignation").fill("Ciment 35 kg");
  await modale.getByLabel("Quantité").fill("40");
  await modale.getByLabel("Prix unitaire HT (€)").fill("8.50");
  await modale.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await p.getByText("BL-042", { exact: true }).waitFor();
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.screenshot({ path: `${root}/captures/livraisons.png`, animations: "disabled" });
  await snap("recherche", "/app/recherche");
  await p.getByLabel("Votre recherche").fill("Villa des Pins");
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${root}/captures/recherche.png`, animations: "disabled" });
  await snap("sources", "/app/sources-fichiers");
  await snap("exports", "/app/exports");
  await snap("parametres", "/app/parametres");
  for (const [nom, chemin] of [
    ["factures", "/app/factures"],
    ["avoirs", "/app/avoirs"],
    ["clients", "/app/clients"],
    ["fournisseurs", "/app/fournisseurs"],
    ["produits", "/app/produits"],
    ["commandes", "/app/commandes"],
    ["devis-recus", "/app/devis-recus"],
    ["courrier", "/app/courrier"],
    ["atelier", "/app/atelier"],
    ["fichiers", "/app/fichiers"],
    ["imports", "/app/imports"],
    ["automatisations", "/app/automatisations"],
    ["employes", "/app/employes"],
    ["absences", "/app/absences"],
  ] as const)
    await snap(nom, chemin);
  await p.goto(banc.url("/app/devis-recus"), { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Vérifier", exact: true }).click();
  await p.getByRole("dialog").getByLabel("Référence du devis").waitFor();
  await p.screenshot({ path: `${root}/captures/devis-recu-detail.png`, animations: "disabled" });
  manifest.push({
    file: "devis-recu-detail.png",
    origin: "Application réelle, extraction préparée dans la base de démonstration ; ne qualifie pas un modèle IA",
    path: "/app/devis-recus",
    demo: true,
  });
  if (erreurs.length) throw new Error(`Erreurs navigateur : ${erreurs.join(" ; ")}`);
  await p.setViewportSize({ width: 430, height: 900 });
  await snap("mobile", `/app/chantiers/${chantier.id}`);
  await ctx.close();
  // Site public actuel, sans création de compte ou transmission de données.
  const publicCtx = await banc.navigateur.newContext({
    viewport: { width: 1600, height: 900 },
    locale: "fr-FR",
    colorScheme: "light",
  });
  const publicPage = await publicCtx.newPage();
  for (const [name, path] of [
    ["site", "/"],
    ["connexion", "/app/connexion"],
    ["inscription", "/app/inscription"],
  ]) {
    await publicPage.goto(`https://auto.aphrody.com${path}`, { waitUntil: "networkidle" });
    await publicPage.screenshot({ path: `${root}/captures/${name}.png`, animations: "disabled" });
    manifest.push({
      file: `${name}.png`,
      origin: "Site de production réel, sans session",
      url: publicPage.url(),
      date: "2026-10-25",
    });
  }
  // Seule la validation locale du premier formulaire est activée ; aucune inscription envoyée.
  await publicPage.getByLabel("E-mail professionnel").fill("presentation@batir-ensemble.example");
  await publicPage.locator('input[type="password"]').fill("Exemple-video-uniquement-2026");
  await publicPage.getByRole("button", { name: /Continuer/ }).click();
  await publicPage.screenshot({ path: `${root}/captures/entreprise.png`, animations: "disabled" });
  manifest.push({
    file: "entreprise.png",
    origin: "Site réel, formulaire non soumis",
    path: "/app/inscription",
    demo: true,
  });
  await publicCtx.close();
  await Bun.write(`${root}/captures/provenance.json`, JSON.stringify(manifest, null, 2));
} finally {
  await Bun.write(`${root}/captures/provenance.json`, JSON.stringify(manifest, null, 2));
  await banc.arreter();
}
