// Automatisations dans Chrome headless, sur l'API réelle : état vide et modèles, création d'un workflow dans
// l'éditeur (palette, paramètres, aide aux expressions), essai avec résultats sur les nœuds, enregistrement,
// historique d'exécution, secrets, import n8n, éditeur sur mobile. Captures dans AUTO_CAPTURES (ou .cache/).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { auditer } from "./audit";
import { chrome, demarrerBanc, type Banc } from "./support";

setDefaultTimeout(60_000);
const executable = chrome();
const CAPTURES = Bun.env.AUTO_CAPTURES ?? join(import.meta.dir, "../../../.cache/automatisations");
let b: Banc;
let session: string;

beforeAll(async () => {
  if (!executable) return;
  b = await demarrerBanc(executable);
  session = await b.inscrire("flux@exemple.fr", "Atelier Flux");
  mkdirSync(CAPTURES, { recursive: true });
}, 60_000);
afterAll(async () => {
  await b?.arreter();
}, 30_000);

const capture = (page: Page, nom: string) => page.screenshot({ path: join(CAPTURES, `${nom}.png`) });

test.skipIf(!executable)(
  "liste vide, modèles, puis workflow construit, testé et enregistré dans l'éditeur",
  async () => {
    const ctx = await b.connecte(session, 1440);
    const page = await ctx.newPage();
    const erreurs: string[] = [];
    page.on("pageerror", (e) => erreurs.push(e.message));

    await page.goto(b.url("/app/automatisations"), { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Automatisez votre gestion" }).waitFor();
    expect(await page.getByRole("link", { name: "Automatisations" }).count()).toBeGreaterThan(0);
    expect(await page.getByRole("link", { name: "Utiliser ce modèle" }).count()).toBe(3);
    expect(await page.evaluate(auditer)).toEqual([]);
    await capture(page, "liste-vide");

    await page.getByRole("tab", { name: "Modèles" }).click();
    await page.getByRole("tabpanel").getByRole("heading", { level: 3 }).first().waitFor();
    await capture(page, "modeles");

    // Nouveau workflow : lancement manuel, puis « Définir des champs » ajouté à sa suite depuis la palette.
    await page.goto(b.url("/app/automatisations/nouveau"), { waitUntil: "networkidle" });
    await page.locator(".react-flow__node").first().waitFor();
    await page.getByLabel("Nom du workflow").fill("Bonjour client");
    await page.locator(".react-flow__node").first().click();
    await page.getByLabel("Données d'essai").fill('{ "client": "Durand", "total": 12000 }');
    await page.getByLabel("Données d'essai").blur();
    await page.getByLabel("Rechercher un nœud").fill("définir");
    await page.getByRole("button", { name: /Définir des champs/ }).click();
    expect(await page.locator(".react-flow__node").count()).toBe(2);
    await page.locator(".react-flow__edge").first().waitFor({ state: "attached" });
    expect(await page.locator(".react-flow__edge").count()).toBe(1);
    await page.getByLabel("Nom, ligne 1").fill("message");
    await page
      .getByLabel("Valeur, ligne 1")
      .fill("Bonjour {{ $json.client | majuscules }} : {{ $json.total | centimes }}");

    await page.getByRole("button", { name: "Tester" }).click();
    await page.locator(".flux-noeud-resultat").nth(1).waitFor();
    expect(await page.locator(".flux-noeud[data-statut='succes']").count()).toBe(2);
    // Le panneau montre l'aperçu de l'expression résolue sur l'entrée de l'essai et le JSON produit.
    await page
      .getByText(/Bonjour DURAND : 120,00.€/)
      .first()
      .waitFor();
    await page.getByRole("tab", { name: /Résultat/ }).click();
    expect(await page.locator(".flux-json").textContent()).toContain("Bonjour DURAND");
    await page.getByRole("tab", { name: /Paramètres/ }).click();
    await page.locator("summary", { hasText: "Expressions et filtres" }).click();
    await capture(page, "editeur-essai");

    await page.getByRole("button", { name: "Enregistrer" }).click();
    await page.waitForURL(/\/app\/automatisations\/[0-9a-f-]{36}$/);
    await page.getByText("Enregistré", { exact: true }).waitFor();
    const id = page.url().split("/").pop()!;
    const enregistre = await b.appel(`/v1/automatisations/${id}`, session);
    expect(enregistre.nom).toBe("Bonjour client");
    expect(enregistre.definition.noeuds.map((n: { type: string }) => n.type)).toEqual([
      "declencheur.manuel",
      "donnees.definir",
    ]);
    expect(enregistre.definition.connexions).toEqual([{ de: "declencheur", sortie: 0, vers: "definir" }]);

    // Suppression au clavier d'un nœud sélectionné, puis abandon des modifications.
    await page.locator(".react-flow__node").nth(1).click();
    await page.keyboard.press("Delete");
    expect(await page.locator(".react-flow__node").count()).toBe(1);
    await page.getByRole("button", { name: "Retour aux automatisations" }).click();
    await page.getByRole("button", { name: "Quitter" }).click();
    await page.getByRole("heading", { name: "Automatisations", level: 1 }).waitFor();
    await page.getByRole("link", { name: "Bonjour client" }).waitFor();
    await page.getByRole("switch", { name: /Activer « Bonjour client »/ }).click();
    await page.getByText("« Bonjour client » activé").waitFor();
    expect((await b.appel(`/v1/automatisations/${id}`, session)).actif).toBe(true);
    expect(await page.getByRole("switch", { name: /Désactiver « Bonjour client »/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await page.waitForTimeout(500);
    await capture(page, "liste");

    // Historique : exécution réelle et détail par étape.
    await page.goto(b.url(`/app/automatisations/${id}/executions`), { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Exécuter maintenant" }).click();
    await page.locator(".flux-etape").nth(1).waitFor();
    expect(await page.locator(".flux-etape").count()).toBe(2);
    expect(await page.evaluate(auditer)).toEqual([]);
    await capture(page, "historique");

    expect(erreurs).toEqual([]);
    await ctx.close();
  },
);

test.skipIf(!executable)("secrets : ajout masqué, puis proposés dans l'aide aux expressions", async () => {
  const ctx = await b.connecte(session, 1280);
  const page = await ctx.newPage();
  await page.goto(b.url("/app/automatisations?vue=secrets"), { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Ajouter un secret" }).click();
  await page.getByLabel("Nom").fill("slack_ventes");
  await page.getByLabel("Valeur").fill("https://hooks.slack.com/services/T/B/X");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await page.getByText("{{ $secret.slack_ventes }}").waitFor();
  expect(await page.content()).not.toContain("hooks.slack.com");
  await capture(page, "secrets");

  await page.goto(b.url("/app/automatisations/nouveau?modele=facture-slack"), { waitUntil: "networkidle" });
  await page.locator(".react-flow__node").nth(2).click();
  await page.locator("summary", { hasText: "Expressions et filtres" }).click();
  await page.getByRole("button", { name: "{{ $secret.slack_ventes }}" }).waitFor();
  // Le « Si » expose ses sorties libellées « vrai » et « faux ».
  expect(await page.locator(".flux-sortie-libelle").allTextContents()).toEqual(["vrai", "faux"]);
  await capture(page, "editeur-modele");
  await ctx.close();
});

test.skipIf(!executable)("import n8n : conversion, avertissements, ouverture dans l'éditeur", async () => {
  const ctx = await b.connecte(session, 1280);
  const page = await ctx.newPage();
  await page.goto(b.url("/app/automatisations"), { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Importer depuis n8n" }).click();
  const n8n = {
    name: "Depuis n8n",
    nodes: [
      {
        id: "1",
        name: "Manual",
        type: "n8n-nodes-base.manualTrigger",
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: "2",
        name: "Set",
        type: "n8n-nodes-base.set",
        typeVersion: 3,
        position: [220, 0],
        parameters: { values: { string: [{ name: "a", value: "={{ $json.b }}" }] } },
      },
      { id: "3", name: "Notion", type: "n8n-nodes-base.notion", typeVersion: 2, position: [440, 0], parameters: {} },
    ],
    connections: {
      Manual: { main: [[{ node: "Set", type: "main", index: 0 }]] },
      Set: { main: [[{ node: "Notion", type: "main", index: 0 }]] },
    },
  };
  await page.getByLabel("JSON du workflow").fill(JSON.stringify(n8n));
  await page.getByRole("button", { name: "Convertir" }).click();
  await page.getByText("À vérifier après l'import").waitFor();
  await page.getByRole("button", { name: "Ouvrir dans l'éditeur" }).click();
  await page.locator(".react-flow__node").nth(2).waitFor();
  // Le nœud sans équivalent arrive en « Laisser passer », signalé sur le canevas.
  await page.locator(".flux-noeud[data-avertissement]").waitFor();
  await capture(page, "import-n8n");
  expect(await page.getByLabel("Nom du workflow").inputValue()).toBe("Depuis n8n");
  await ctx.close();
});

test.skipIf(!executable)("mobile : éditeur avec palette en tiroir et panneau en bas", async () => {
  const ctx = await b.connecte(session, 390);
  const page = await ctx.newPage();
  await page.goto(b.url("/app/automatisations/nouveau?modele=retards-lundi"), { waitUntil: "networkidle" });
  await page.locator(".react-flow__node").first().waitFor();
  await page.getByRole("button", { name: "Ajouter un nœud" }).click();
  await page.getByLabel("Rechercher un nœud").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Fermer", exact: true }).click();
  await page.locator(".react-flow__node").first().click();
  await page.locator(".flux-panneau").waitFor();
  const largeur = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(largeur).toBeLessThanOrEqual(390);
  await capture(page, "editeur-mobile");
  await ctx.close();
});
