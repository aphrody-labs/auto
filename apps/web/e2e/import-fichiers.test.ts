import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { chrome, demarrerBanc } from "./support";
import type { Route } from "playwright-core";
const executable = chrome();
(executable ? test : test.skip)(
  "import massif : arborescence, originaux, déduplication, pause/reprise, échec transitoire et mobile",
  async () => {
    const b = await demarrerBanc(executable!);
    const dossier = await mkdtemp(join(tmpdir(), "auto-import-lot-"));
    try {
      await Bun.write(join(dossier, "Clients", "bon.txt"), "Livraison : preuve originale Alpha");
      await Bun.write(join(dossier, "Fournisseurs", "preuve.txt"), "Document fournisseur Beta");
      const session = await b.inscrire(`bulk-${crypto.randomUUID()}@example.test`, "Import par lots");
      const contexte = await b.connecte(session, 1440);
      const p = await contexte.newPage();
      const erreurs: string[] = [];
      p.on("pageerror", (e) => erreurs.push(e.message));
      await p.goto(b.url("/app/fichiers"));
      await p.getByRole("heading", { name: "Fichiers et dossiers", exact: true }).waitFor();
      await p.getByLabel("Dossier à importer", { exact: true }).setInputFiles(dossier);
      await p.getByText("0 sur 2 fichiers conservés", { exact: false }).waitFor();
      await p.getByRole("button", { name: "Importer le lot", exact: true }).click();
      await p.getByText("2 sur 2 fichiers conservés", { exact: false }).waitFor({ timeout: 30000 });
      const indexes = await b.appel("/v1/fichiers-indexes", session);
      expect(indexes).toHaveLength(2);
      expect(indexes.every((f: { chemin: string }) => /\/(Clients|Fournisseurs)\//.test(`/${f.chemin}`))).toBe(true);
      const original = await contexte.request.get(
        b.url(`/v1/fichiers-indexes/${indexes.find((f: { nom: string }) => f.nom === "bon.txt").id}/fichier`),
      );
      expect(await original.text()).toBe("Livraison : preuve originale Alpha");
      await p.getByRole("button", { name: "Vider la sélection", exact: true }).click();
      await p.getByLabel("Dossier à importer", { exact: true }).setInputFiles(dossier);
      await p.getByRole("button", { name: "Importer le lot", exact: true }).click();
      await p.getByText("2 sur 2 fichiers conservés", { exact: false }).waitFor({ timeout: 30000 });
      expect(await p.locator(".import-resultats li").filter({ hasText: "Déjà présent" }).count()).toBe(2);
      expect(await b.appel("/v1/fichiers-indexes", session)).toHaveLength(2);
      await p.getByRole("button", { name: "Vider la sélection", exact: true }).click();
      await p.getByLabel("Fichiers à importer", { exact: true }).setInputFiles(
        [0, 1, 2].map((i) => ({
          name: `pause-${i}.txt`,
          mimeType: "text/plain",
          buffer: Buffer.from(`Pièce de reprise ${i}`),
        })),
      );
      let demandes = 0;
      const ralentir = async (route: Route) => {
        demandes++;
        await Bun.sleep(1000);
        await route.continue().catch(() => {});
      };
      await p.route("**/v1/imports-fichiers", ralentir);
      await p.getByRole("button", { name: "Importer le lot", exact: true }).click();
      for (let essai = 0; demandes < 2 && essai < 100; essai++) await Bun.sleep(10);
      expect(demandes).toBe(2);
      await p.getByRole("button", { name: "Mettre en pause", exact: true }).click();
      await p.getByText("3 à importer", { exact: false }).waitFor();
      await p.unroute("**/v1/imports-fichiers", ralentir);
      await p.getByRole("button", { name: "Importer le lot", exact: true }).click();
      await p.getByText("3 sur 3 fichiers conservés", { exact: false }).waitFor();
      expect(await b.appel("/v1/fichiers-indexes", session)).toHaveLength(5);
      await p.getByRole("button", { name: "Vider la sélection", exact: true }).click();
      await p.getByLabel("Fichiers à importer", { exact: true }).setInputFiles({
        name: "reessayer.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Pièce après une panne transitoire"),
      });
      let panne = true;
      const interrompre = async (route: Route) => {
        if (panne) {
          panne = false;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ erreur: "Interruption de recette" }),
          });
        } else await route.continue();
      };
      await p.route("**/v1/imports-fichiers", interrompre);
      await p.getByRole("button", { name: "Importer le lot", exact: true }).click();
      await p.getByText("1 en échec", { exact: false }).waitFor();
      await p.getByRole("button", { name: "Réessayer les échecs", exact: true }).click();
      await p.getByText("1 sur 1 fichiers conservés", { exact: false }).waitFor();
      expect(await b.appel("/v1/fichiers-indexes", session)).toHaveLength(6);
      await p.unroute("**/v1/imports-fichiers", interrompre);
      await p.setViewportSize({ width: 375, height: 812 });
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (Bun.env.AUTO_QA_CAPTURE_DIR)
        await p.screenshot({ path: `${Bun.env.AUTO_QA_CAPTURE_DIR}/import-mobile.png`, fullPage: true });
      expect(erreurs).toEqual([]);
      await contexte.close();
    } finally {
      await b.arreter();
      const relatif = relative(resolve(tmpdir()), resolve(dossier));
      if (relatif.startsWith("auto-import-lot-") && !relatif.includes(".."))
        await rm(dossier, { recursive: true, force: true });
    }
  },
  60000,
);
