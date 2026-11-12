import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { testDb } from "../packages/store/src/db";

const binaire = Bun.env.AUTO_STANDALONE;
(binaire ? test : test.skip)(
  "paquet autonome : aide, migrations, API et front depuis un autre répertoire",
  async () => {
    const executable = resolve(binaire!);
    const aide = Bun.spawnSync([executable, "--help"], { cwd: Bun.env.TEMP ?? "/tmp" });
    expect(aide.exitCode).toBe(0);
    expect(aide.stdout.toString()).toContain("auto <api|worker|web|migrate>");
    const outils = Bun.spawnSync([executable, "outils"], { cwd: Bun.env.TEMP ?? "/tmp" });
    expect(outils.exitCode).toBe(0);
    expect(outils.stdout.toString().length).toBeGreaterThan(100);
    const db = await testDb();
    try {
      // La base du banc est jetable ; son nom est propre à cette exécution.
      const [{ nom }] = await db.sql`SELECT current_database() AS nom`;
      const connexion = new URL(Bun.env.DATABASE_URL ?? "postgres://auto:auto@localhost:5433/auto");
      connexion.pathname = `/${nom}`;
      const env = {
        ...Bun.env,
        DATABASE_URL: connexion.toString(),
        AUTO_SMTP_HOTE: "localhost",
        AUTO_SMTP_SECURITE: "tls",
        AUTO_CLE_MAITRE: "ab".repeat(32),
        AUTO_URL_APP: "http://localhost:3001",
      };
      const migration = Bun.spawn([executable, "migrate"], {
        cwd: Bun.env.TEMP ?? "/tmp",
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [sortie, erreurs, code] = await Promise.all([
        migration.stdout.text(),
        migration.stderr.text(),
        migration.exited,
      ]);
      expect({ code, erreurs }).toEqual({ code: 0, erreurs: "" });
      expect(sortie).toContain("schéma à jour");
      for (const commande of ["api", "web"]) {
        const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
        const port = reservation.port!;
        await reservation.stop(true);
        const serveur = Bun.spawn([executable, commande], {
          cwd: Bun.env.TEMP ?? "/tmp",
          env: { ...env, NODE_ENV: "production", PORT: String(port) },
          stdout: "pipe",
          stderr: "pipe",
        });
        try {
          let reponse: Response | undefined;
          for (let essai = 0; essai < 100; essai++) {
            reponse = await fetch(`http://127.0.0.1:${port}/${commande === "api" ? "health" : "app"}`).catch(
              () => undefined,
            );
            if (reponse?.ok) break;
            if (serveur.exitCode !== null) throw new Error(await serveur.stderr.text());
            await Bun.sleep(100);
          }
          expect(reponse?.status).toBe(200);
          if (commande === "api") {
            const inscription = await fetch(`http://127.0.0.1:${port}/v1/auth/inscription`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                email: `standalone-${crypto.randomUUID()}@exemple.fr`,
                motDePasse: "Un mot de passe pour le banc uniquement",
                entreprise: { nom: "Paquet autonome", siret: "73282932000074", adresse: "1 rue A, Lyon" },
              }),
            });
            expect(inscription.status).toBe(201);
            const { session } = (await inscription.json()) as { session: string };
            const headers = { "content-type": "application/json", authorization: `Bearer ${session}` };
            const creation = await fetch(`http://127.0.0.1:${port}/v1/documents`, {
              method: "POST",
              headers,
              body: JSON.stringify({
                type: "devis",
                client: { nom: "Client", siret: "", adresse: "2 rue B, Lyon" },
                lignes: [{ designation: "Qualification FFI", quantite: 1, prixUnitaireHtCents: 10000, tva: 200 }],
                datePrestation: "2026-10-25",
                echeance: "2026-11-25",
              }),
            });
            expect(creation.status).toBe(201);
            const { id } = (await creation.json()) as { id: string };
            const pdf = await fetch(`http://127.0.0.1:${port}/v1/documents/${id}/pdf`, { headers });
            expect(pdf.status).toBe(200);
            expect((await pdf.text()).slice(0, 5)).toBe("%PDF-");
          }
          if (commande === "web") {
            const html = await reponse!.text();
            expect(html).toContain("racine");
            const icone = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
            expect(icone.status).toBe(200);
            expect(icone.headers.get("content-type")).toBe("image/png");
            const dossierPublic = Bun.fileURLToPath(new URL("./public/img/", Bun.pathToFileURL(executable)));
            const capture = new Bun.Glob("*.webp").scanSync({ cwd: dossierPublic }).next().value;
            expect(capture).toBeDefined();
            expect((await fetch(`http://127.0.0.1:${port}/img/${capture}`)).status).toBe(200);
            const css = [...html.matchAll(/href="([^"]+\.css)"/g)].map((m) => m[1]!);
            expect(css.length).toBeGreaterThan(0);
            for (const chemin of css) {
              const feuille = await fetch(new URL(chemin, `http://127.0.0.1:${port}`));
              expect(feuille.status).toBe(200);
              expect(await feuille.text()).not.toContain("@theme");
            }
          }
        } finally {
          serveur.kill();
          await serveur.exited;
        }
      }
    } finally {
      await db.drop();
    }
  },
  30_000,
);
