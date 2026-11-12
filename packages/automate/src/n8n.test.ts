import { expect, test } from "bun:test";
import { estN8n, importerN8n, valider } from "./index";

// Forme d'un export n8n 1.x (Fichier > Download).
const workflow = {
  name: "Leads vers Slack",
  nodes: [
    {
      name: "Webhook",
      type: "n8n-nodes-base.webhook",
      position: [0, 0],
      parameters: { path: "lead", responseMode: "lastNode" },
    },
    {
      name: "Est qualifié ?",
      type: "n8n-nodes-base.if",
      position: [220, 0],
      parameters: {
        conditions: {
          combinator: "and",
          conditions: [
            { leftValue: "={{ $json.body.budget }}", rightValue: 1000, operator: { type: "number", operation: "gt" } },
          ],
        },
      },
    },
    {
      name: "Préparer",
      type: "n8n-nodes-base.set",
      position: [440, -100],
      parameters: {
        assignments: {
          assignments: [
            { name: "texte", value: "=Lead {{ $json.body.nom }} ({{ $('Webhook').item.json.body.budget }} €)" },
          ],
        },
      },
    },
    {
      name: "Enrichir",
      type: "n8n-nodes-base.httpRequest",
      position: [660, -100],
      parameters: {
        method: "POST",
        url: "https://api.exemple.fr/leads",
        sendBody: true,
        jsonBody: '={"nom": "{{ $json.texte }}"}',
      },
    },
    { name: "Résumé IA", type: "@n8n/n8n-nodes-langchain.agent", position: [660, 100], parameters: {} },
    { name: "Code", type: "n8n-nodes-base.code", position: [880, 0], parameters: { jsCode: "return items" } },
  ],
  connections: {
    Webhook: { main: [[{ node: "Est qualifié ?", type: "main", index: 0 }]] },
    "Est qualifié ?": {
      main: [[{ node: "Préparer", type: "main", index: 0 }], [{ node: "Résumé IA", type: "main", index: 0 }]],
    },
    Préparer: { main: [[{ node: "Enrichir", type: "main", index: 0 }]] },
  },
};

test("import n8n : nœuds, expressions, connexions et avertissements", () => {
  expect(estN8n(workflow)).toBe(true);
  expect(estN8n({ noeuds: [] })).toBe(false);
  const r = importerN8n(workflow as never);
  const d = valider(r.definition);
  expect(d.noeuds.map((n) => [n.id, n.type])).toEqual([
    ["webhook", "declencheur.webhook"],
    ["est-qualifie", "logique.si"],
    ["preparer", "donnees.definir"],
    ["enrichir", "reseau.http"],
    ["resume-ia", "logique.passer"],
  ]);
  expect(d.noeuds[0]!.parametres).toEqual({ reponse: "fin" });
  expect(d.noeuds[1]!.parametres).toMatchObject({
    conditions: [{ gauche: "{{ $json.body.budget }}", operateur: "superieur", droite: 1000 }],
  });
  expect((d.noeuds[2]!.parametres.champs as { valeur: string }[])[0]!.valeur).toBe(
    "Lead {{ $json.body.nom }} ({{ $noeud.webhook.json.body.budget }} €)",
  );
  expect(d.noeuds[3]!.parametres).toMatchObject({ methode: "POST", corps: { nom: "{{ $json.texte }}" } });
  expect(d.connexions).toEqual([
    { de: "webhook", sortie: 0, vers: "est-qualifie" },
    { de: "est-qualifie", sortie: 0, vers: "preparer" },
    { de: "est-qualifie", sortie: 1, vers: "resume-ia" },
    { de: "preparer", sortie: 0, vers: "enrichir" },
  ]);
  expect(r.avertissements).toEqual([
    "« Résumé IA » : nœud @n8n/n8n-nodes-langchain.agent non pris en charge, laissé en « Laisser passer » à remplacer",
    "1 nœuds sans déclencheur reconnu : lancement manuel ajouté",
    "2 déclencheurs : importé en 2 workflows",
  ]);
  expect(r.autres).toHaveLength(1);
  expect(r.autres[0]!.definition.noeuds.map((n) => n.id)).toEqual(["code", "declencheur"]);
  expect(r.autres[0]!.definition.noeuds[0]).toMatchObject({
    type: "donnees.code",
    parametres: { mode: "lot", code: "return items" },
  });
});

test("import n8n : planification et déclencheur ajouté", () => {
  const cron = importerN8n({
    nodes: [
      {
        name: "Chaque jour",
        type: "n8n-nodes-base.scheduleTrigger",
        parameters: { rule: { interval: [{ field: "cronExpression", expression: "0 30 8 * * 1-5" }] } },
      },
    ],
    connections: {},
  });
  expect(cron.definition.noeuds[0]!.parametres).toMatchObject({ cron: "30 8 * * 1-5" });
  const sans = importerN8n({
    nodes: [{ name: "Limiter", type: "n8n-nodes-base.limit", parameters: { maxItems: 3 } }],
    connections: {},
  });
  expect(() => valider(sans.definition)).not.toThrow();
  expect(sans.avertissements).toContain("aucun déclencheur reconnu : lancement manuel ajouté");
});

test("import n8n : plusieurs déclencheurs, notes ignorées, graphe conservé à travers un nœud non pris en charge", async () => {
  const j = await Bun.file(
    new URL(
      "../../../docs/modeles/automatisation-factures/workflow/Workflow_n8n_Factures_Fournisseurs.json",
      import.meta.url,
    ),
  ).json();
  const r = importerN8n(j);
  for (const w of [r, ...r.autres]) expect(() => valider(w.definition)).not.toThrow();
  expect(r.avertissements.some((a) => a.includes("stickyNote"))).toBe(false);
  // Planification → Excel (à remplacer) → récapitulatif (à remplacer) → mail : chaîne intacte.
  expect(r.definition.noeuds[0]!.type).toBe("declencheur.planifie");
  expect(r.definition.connexions).toHaveLength(r.definition.noeuds.length - 1);
  expect(r.autres).toHaveLength(1);
});
