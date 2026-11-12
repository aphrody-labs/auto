import { beforeAll, afterAll, expect, test } from "bun:test";
import { testDb, type Sql } from "./db";
import { avecCourrier, compteCourrier, stockerCourrier } from "./courrier";
let sql: Sql, drop: () => Promise<void>, a: string, b: string, compte: string;
beforeAll(async () => {
  ({ sql, drop } = await testDb());
  a = crypto.randomUUID();
  b = crypto.randomUUID();
  for (const id of [a, b])
    await sql`INSERT INTO app_user(id,email,name) VALUES(${id},${`${id}@example.test`},'Test privé')`;
  compte = await avecCourrier(
    sql,
    a,
    a,
    async (tx) =>
      (
        await tx`INSERT INTO courrier_compte(user_id,fournisseur,adresse,secret) VALUES(${a},'google','prive@example.test',${new Uint8Array([1, 2, 3])}) RETURNING id`
      )[0]!.id,
  );
}, 30000);
afterAll(async () => {
  await drop?.();
});
test("Isolation privée y compris sous le même namespace, idempotence et pièces jointes", async () => {
  const c = await avecCourrier(sql, a, a, (tx) => compteCourrier(tx, compte));
  expect(c).toBeDefined();
  expect(await avecCourrier(sql, a, b, (tx) => compteCourrier(tx, compte))).toBeUndefined();
  expect(await avecCourrier(sql, b, b, (tx) => compteCourrier(tx, compte))).toBeUndefined();
  const m = {
    distantId: "gmail-1",
    expediteur: "emetteur@example.test",
    destinataires: ["prive@example.test"],
    sujet: "Privé",
    texte: "Contenu",
    date: new Date().toISOString(),
    lu: false,
    pieces: [{ nom: "preuve.txt", type: "text/plain", octets: new TextEncoder().encode("preuve") }],
  };
  const id = await avecCourrier(sql, a, a, (tx) => stockerCourrier(tx, c!, m));
  expect(await avecCourrier(sql, a, a, (tx) => stockerCourrier(tx, c!, m))).toBe(id);
  expect((await avecCourrier(sql, a, a, (tx) => tx`SELECT id FROM courrier_message`)).length).toBe(1);
  expect((await avecCourrier(sql, a, b, (tx) => tx`SELECT id FROM courrier_message`)).length).toBe(0);
  expect((await avecCourrier(sql, a, b, (tx) => tx`SELECT id FROM courrier_piece`)).length).toBe(0);
  expect((await avecCourrier(sql, a, a, (tx) => tx`SELECT id FROM courrier_piece`)).length).toBe(1);
});
