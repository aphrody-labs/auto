// Contrat avec les workflows n8n de infra/n8n/workflows : structure, et code des nœuds de vérification
// exécuté ici sur un corps signé comme le fait le worker.
import { expect, test } from "bun:test";
import { signer } from "@auto/services";

interface Noeud {
  name: string;
  type: string;
  disabled?: boolean;
  parameters: { jsCode?: string; path?: string };
}
interface Workflow {
  id: string;
  nodes: Noeud[];
  connections: Record<string, { main: { node: string }[][] }>;
}

const DOSSIER = new URL("../../../infra/n8n/workflows/", import.meta.url);
const lire = (nom: string) => Bun.file(new URL(nom, DOSSIER)).json() as Promise<Workflow>;
const SECRET = "secret-de-test";

/** Exécute un nœud Code n8n (mode « tous les éléments ») avec $input, $env et l'état statique donnés. */
function executer(n: Noeud, items: { json: unknown }[], statique: Record<string, unknown> = {}) {
  const fn = new Function("require", "$input", "$env", "$getWorkflowStaticData", n.parameters.jsCode!);
  return fn(
    (m: string) => require(m),
    { all: () => items },
    { N8N_WEBHOOK_SECRET: SECRET },
    () => statique,
  ) as { json: Record<string, unknown> }[];
}

const relance = {
  id: "0199f1c2-0000-7000-8000-000000000001",
  type: "relance.a_envoyer",
  tenantId: "t1",
  date: "2026-10-22T08:00:00.000Z",
  data: {
    documentId: "d1",
    numero: "F-2026-0007",
    client: { nom: "Client", siret: "73282932000074", adresse: "2 rue B", email: "compta@client.fr" },
    echeance: "2026-10-12",
    joursRetard: 10,
    niveau: 1,
    resteCents: 123456,
    jour: "2026-10-22",
  },
};
const recu = (corps: string, signature: string) => ({
  json: { body: JSON.parse(corps), headers: { "x-auto-signature": signature } },
});

test("workflows : connexions vers des nœuds existants, chemins de webhook distincts", async () => {
  const chemins: string[] = [];
  for await (const f of new Bun.Glob("*.json").scan(Bun.fileURLToPath(DOSSIER))) {
    const w = await lire(f);
    const noms = new Set(w.nodes.map((n) => n.name));
    for (const [de, c] of Object.entries(w.connections)) {
      expect(noms.has(de)).toBe(true);
      for (const x of c.main.flat()) expect(noms.has(x.node)).toBe(true);
    }
    for (const n of w.nodes) if (n.type === "n8n-nodes-base.webhook") chemins.push(n.parameters.path!);
  }
  expect(chemins.sort()).toEqual(["auto-evenements", "auto-relances"]);
});

test("auto-relances : signature vérifiée, dédoublonnage, mail préparé, envoi désactivé", async () => {
  const w = await lire("auto-relances.json");
  const noeud = (nom: string) => w.nodes.find((n) => n.name === nom)!;
  const corps = JSON.stringify(relance);

  expect(() => executer(noeud("Vérifier la signature"), [recu(corps, signer("autre", corps))])).toThrow(
    "signature invalide",
  );
  const verifies = executer(noeud("Vérifier la signature"), [recu(corps, signer(SECRET, corps))]);
  expect(verifies.map((i) => i.json)).toEqual([relance]);

  const statique = {};
  expect(executer(noeud("Dédoublonner"), verifies, statique).length).toBe(1);
  expect(executer(noeud("Dédoublonner"), verifies, statique).length).toBe(0); // même id : ignoré

  const [mail] = executer(noeud("Préparer le mail"), verifies);
  expect(mail!.json).toMatchObject({ a: "compta@client.fr", objet: "Rappel : facture F-2026-0007 échue", niveau: 1 });
  expect(String(mail!.json.texte)).toContain("10 jours de retard");
  const sansEmail = { json: { ...relance, data: { ...relance.data, client: { nom: "X" } } } };
  expect(executer(noeud("Préparer le mail"), [sansEmail])).toEqual([]);
  const dejaEnvoyee = { json: { ...relance, data: { ...relance.data, envoyeParMail: true } } };
  expect(executer(noeud("Préparer le mail"), [dejaEnvoyee])).toEqual([]);

  expect(noeud("Envoyer le mail")).toMatchObject({ type: "n8n-nodes-base.emailSend", disabled: true });
});

test("auto-evenements : même vérification de signature sur le corps de l'outbox", async () => {
  const w = await lire("auto-evenements.json");
  const v = w.nodes.find((n) => n.name === "Vérifier la signature")!;
  const corps = JSON.stringify(relance);
  expect(executer(v, [recu(corps, signer(SECRET, corps))]).map((i) => i.json)).toEqual([relance]);
  expect(w.connections["Vérifier la signature"]!.main[0]!.map((x) => x.node)).toContain("Relance ?");
});
