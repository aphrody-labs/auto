// Sauvegarde chiffrée puis restauration sur une base jetable (scripts/sauvegarde.ts, scripts/restauration.ts).
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { restaurer } from "../../../scripts/restauration";
import { sauvegarder } from "../../../scripts/sauvegarde";
import { DEFAULT_URL, testDb, verifierAudit, withTenant } from "./index";

const conteneur = Bun.env.AUTO_PG_CONTENEUR ?? "auto-pg";
const docker = Bun.which("docker")
  ? Bun.spawnSync(["docker", "inspect", "-f", "{{.State.Running}}", conteneur], { stderr: "ignore" })
  : null;
const disponible = docker?.exitCode === 0 && docker.stdout.toString().trim() === "true";
if (!disponible) console.warn(`sauvegarde : conteneur ${conteneur} absent, test sauté`);

const nettoyage: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const f of nettoyage.reverse()) await f();
});

test.skipIf(!disponible)(
  "sauvegarde chiffrée, rotation, restauration identique",
  async () => {
    const { sql, drop } = await testDb();
    nettoyage.push(drop);
    const base = new URL(Bun.env.DATABASE_URL ?? DEFAULT_URL).pathname.slice(1);
    const nom = (await sql`SELECT current_database() AS n`)[0].n as string;
    expect(nom).not.toBe(base);
    const [t] =
      await sql`INSERT INTO tenant (nom, siren, siret) VALUES ('Alpha', '732829320', '73282932000074') RETURNING id`;
    await withTenant(sql, t.id, async (tx) => {
      await tx`INSERT INTO client (nom, adresse) VALUES ('Client SAS', '2 rue B')`;
      await tx`INSERT INTO audit (actor, action) VALUES (NULL, 'essai')`;
    });

    const dossier = await mkdtemp(join(tmpdir(), "auto-sauvegarde-"));
    nettoyage.push(() => rm(dossier, { recursive: true, force: true }));
    const chemins: string[] = [];
    for (let i = 0; i < 3; i++) {
      chemins.push(await sauvegarder({ base: nom, conteneur, dossier, garder: 2 }));
      await Bun.sleep(5);
    }
    const restantes = (await Array.fromAsync(new Bun.Glob("*.dump.chiffre").scan(dossier))).sort();
    expect(restantes).toHaveLength(2);
    expect(restantes.map((r) => join(dossier, r))).toEqual(chemins.slice(1).map((c) => join(c)));
    // Chiffré : aucune donnée en clair dans le fichier.
    const octets = await Bun.file(chemins[2]!).bytes();
    expect(Buffer.from(octets).includes(Buffer.from("Client SAS"))).toBe(false);

    // Restauration dans une base neuve.
    const admin = new SQL(Bun.env.DATABASE_URL ?? DEFAULT_URL);
    const cible = `auto_restau_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE DATABASE ${cible}`);
    nettoyage.push(async () => {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${cible} WITH (FORCE)`);
      await admin.close();
    });
    await restaurer({ fichier: chemins[2]!, base: cible, conteneur });
    const u = new URL(Bun.env.DATABASE_URL ?? DEFAULT_URL);
    u.pathname = `/${cible}`;
    const r = new SQL(u.toString());
    nettoyage.push(() => r.close());
    expect(await r`SELECT name FROM schema_migration ORDER BY name`).toEqual(
      await sql`SELECT name FROM schema_migration ORDER BY name`,
    );
    const clients = await withTenant(r, t.id, (tx) => tx`SELECT nom FROM client`);
    expect(clients.map((c: { nom: string }) => c.nom)).toEqual(["Client SAS"]);
    expect(await withTenant(r, t.id, (tx) => verifierAudit(tx))).toEqual({ ok: true, entrees: 1 });

    // Mauvaise clé : refus.
    await expect(
      restaurer({ fichier: chemins[2]!, base: cible, conteneur, cle: new Uint8Array(32).fill(1) }),
    ).rejects.toThrow();
  },
  60_000,
);
