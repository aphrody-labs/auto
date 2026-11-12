// Outils métier de l'agent : chacun appelle l'API /v1 avec le jeton de l'utilisateur.
import type { ApiAuto } from "./api";

export interface Outil {
  nom: string;
  description: string;
  /** JSON Schema des arguments. */
  schema: { type: "object"; properties: Record<string, object>; required?: string[]; additionalProperties?: boolean };
  /** Lecture seule (annotation MCP readOnlyHint). */
  lecture: boolean;
  executer(api: ApiAuto, args: Record<string, unknown>): Promise<unknown>;
}

interface Doc {
  id: string;
  type: string;
  statut: string;
  numero: string | null;
  ttcCents: number;
  data: { date: string; echeance?: string; client: { nom: string }; lignes: { designation: string }[] };
}

const resume = (d: Doc) => ({
  id: d.id,
  type: d.type,
  statut: d.statut,
  numero: d.numero,
  date: d.data.date,
  echeance: d.data.echeance ?? null,
  client: d.data.client.nom,
  ttcCents: d.ttcCents,
});

const id = { type: "string", description: "Identifiant (UUID)" };
const date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Date AAAA-MM-JJ" };
const TYPES = ["devis", "facture", "acompte", "avoir"];
const STATUTS = ["brouillon", "emis", "envoye", "accepte", "refuse", "depose", "rejete", "paye", "annule"];
const lignes = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    required: ["designation", "quantite", "prixUnitaireHtCents", "tva"],
    properties: {
      designation: { type: "string" },
      quantite: { type: "number" },
      prixUnitaireHtCents: { type: "integer", description: "Prix unitaire HT en centimes (450 € = 45000)" },
      tva: { type: "integer", enum: [0, 21, 55, 100, 200], description: "Taux en dixièmes de % (20 % = 200)" },
      remiseBp: { type: "integer", description: "Remise en points de base (10 % = 1000)" },
      unite: { type: "string" },
    },
  },
};
const client = {
  type: "object",
  description: "Client saisi (si pas de clientId)",
  required: ["nom", "siret", "adresse"],
  properties: {
    nom: { type: "string" },
    siret: { type: "string" },
    adresse: { type: "string" },
    email: { type: "string" },
  },
};

const enc = encodeURIComponent;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

async function documents(api: ApiAuto, type?: string): Promise<Doc[]> {
  return api.get<Doc[]>(`/v1/documents${type && TYPES.includes(type) ? `?type=${type}` : ""}`);
}

function brouillon(type: "devis" | "facture", a: Record<string, unknown>) {
  const { clientId, client, lignes, ...reste } = a;
  if (!clientId && !client) throw new Error("clientId ou client requis (utiliser chercher_client)");
  return { ...reste, type, clientId, client, lignes };
}

const csv = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[";\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export const OUTILS: Outil[] = [
  {
    nom: "chercher_piece_gestion",
    description:
      "Retrouve les devis, factures clients et fournisseurs, chantiers, bons de livraison et confirmations de commande connus d’auto, archives comprises, par référence, tiers, chantier ou texte extrait. Ne parcourt pas un partage réseau non connecté.",
    lecture: true,
    schema: { type: "object", properties: { q: { type: "string", minLength: 2, maxLength: 200 } }, required: ["q"] },
    executer: (api, a) => api.get("/v1/recherche-gestion?q=" + enc(String(a.q))),
  },
  {
    nom: "consulter_chantier",
    description:
      "Consulte un chantier avec ses documents, achats, pièces et analytique HT (ventes émises, achats validés, commandes séparées).",
    lecture: true,
    schema: { type: "object", properties: { id }, required: ["id"] },
    executer: (api, a) => api.get("/v1/chantiers/" + enc(String(a.id))),
  },
  {
    nom: "lister_documents",
    description: "Liste les devis, factures, acomptes et avoirs (résumé : numéro, client, statut, TTC en centimes).",
    lecture: true,
    schema: {
      type: "object",
      properties: { type: { type: "string", enum: TYPES }, statut: { type: "string", enum: STATUTS } },
    },
    async executer(api, a) {
      const docs = await documents(api, str(a.type));
      return docs.filter((d) => !a.statut || d.statut === a.statut).map(resume);
    },
  },
  {
    nom: "lire_document",
    description: "Détail complet d'un document (lignes, mentions, totaux).",
    lecture: true,
    schema: { type: "object", properties: { id }, required: ["id"] },
    executer: (api, a) => api.get(`/v1/documents/${enc(String(a.id))}`),
  },
  {
    nom: "chercher_document",
    description: "Cherche un document par numéro, nom de client ou désignation de ligne.",
    lecture: true,
    schema: {
      type: "object",
      properties: { q: { type: "string" }, type: { type: "string", enum: TYPES } },
      required: ["q"],
    },
    async executer(api, a) {
      const q = String(a.q).toLowerCase();
      const docs = await documents(api, str(a.type));
      return docs
        .filter(
          (d) =>
            d.numero?.toLowerCase().includes(q) ||
            d.data.client.nom.toLowerCase().includes(q) ||
            d.data.lignes.some((l) => l.designation.toLowerCase().includes(q)),
        )
        .map(resume);
    },
  },
  {
    nom: "chercher_client",
    description: "Cherche un client enregistré par nom (renvoie son id pour créer un devis ou une facture).",
    lecture: true,
    schema: { type: "object", properties: { q: { type: "string" } } },
    executer: (api, a) => api.get(`/v1/clients${a.q ? `?q=${enc(String(a.q))}` : ""}`),
  },
  {
    nom: "creer_devis",
    description: "Crée un devis en brouillon (non numéroté) pour un client enregistré (clientId) ou saisi.",
    lecture: false,
    schema: {
      type: "object",
      properties: {
        clientId: id,
        chantierId: id,
        client,
        lignes,
        date,
        validiteJours: { type: "integer" },
        notes: { type: "string" },
      },
      required: ["lignes"],
    },
    executer: async (api, a) => resume(await api.post<Doc>("/v1/documents", brouillon("devis", a))),
  },
  {
    nom: "creer_facture",
    description:
      "Crée une facture en brouillon. L'émission (numéro définitif, Factur-X) se fait avec emettre_document.",
    lecture: false,
    schema: {
      type: "object",
      properties: {
        clientId: id,
        chantierId: id,
        client,
        lignes,
        date,
        echeance: date,
        datePrestation: date,
        origine: { type: "string", description: "Numéro du devis d'origine" },
        notes: { type: "string" },
      },
      required: ["lignes"],
    },
    executer: async (api, a) => resume(await api.post<Doc>("/v1/documents", brouillon("facture", a))),
  },
  {
    nom: "emettre_document",
    description: "Émet un brouillon : numéro définitif et exemplaire figé (Factur-X pour une facture). Irréversible.",
    lecture: false,
    schema: { type: "object", properties: { id }, required: ["id"] },
    executer: async (api, a) => resume(await api.post<Doc>(`/v1/documents/${enc(String(a.id))}/emettre`)),
  },
  {
    nom: "enregistrer_paiement",
    description: "Enregistre un paiement reçu sur une facture émise ; renvoie le reste dû.",
    lecture: false,
    schema: {
      type: "object",
      properties: {
        id,
        montantCents: { type: "integer", minimum: 1 },
        date,
        mode: { type: "string", enum: ["virement", "carte", "cheque", "especes", "prelevement", "autre"] },
        reference: { type: "string" },
      },
      required: ["id", "montantCents"],
    },
    executer: (api, a) =>
      api.post(`/v1/documents/${enc(String(a.id))}/paiements`, {
        montantCents: a.montantCents,
        date: a.date ?? new Date().toISOString().slice(0, 10),
        mode: a.mode ?? "virement",
        reference: a.reference,
      }),
  },
  {
    nom: "lister_relances",
    description: "Factures échues non soldées à relancer à une date (palier 1, 2 ou 3).",
    lecture: true,
    schema: { type: "object", properties: { date } },
    executer: (api, a) => api.get(`/v1/relances${a.date ? `?date=${enc(String(a.date))}` : ""}`),
  },
  {
    nom: "relancer",
    description: "Enregistre la relance d'une facture (niveau 1, 2 ou 3).",
    lecture: false,
    schema: {
      type: "object",
      properties: {
        id,
        niveau: { type: "integer", enum: [1, 2, 3] },
        canal: { type: "string", enum: ["mail", "courrier", "telephone"] },
      },
      required: ["id", "niveau"],
    },
    async executer(api, a) {
      await api.post(`/v1/documents/${enc(String(a.id))}/relances`, { niveau: a.niveau, canal: a.canal });
      return { ok: true };
    },
  },
  {
    nom: "lister_absences",
    description: "Absences des employés (congés, RTT, maladie…), filtrables par statut. Droit « rh » requis.",
    lecture: true,
    schema: {
      type: "object",
      properties: { statut: { type: "string", enum: ["demandee", "validee", "refusee", "annulee"] } },
    },
    executer: (api, a) => api.get(`/v1/absences${a.statut ? `?statut=${enc(String(a.statut))}` : ""}`),
  },
  {
    nom: "lister_factures_recues",
    description: "Factures fournisseurs reçues (à vérifier, validées, rejetées).",
    lecture: true,
    schema: { type: "object", properties: { statut: { type: "string", enum: ["a_verifier", "validee", "rejetee"] } } },
    executer: (api, a) => api.get(`/v1/factures-recues${a.statut ? `?statut=${enc(String(a.statut))}` : ""}`),
  },
  {
    nom: "exporter",
    description: "Exporte les documents en CSV (séparateur ;) ou JSON, filtrés par type et période d'émission.",
    lecture: true,
    schema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["csv", "json"] },
        type: { type: "string", enum: TYPES },
        du: date,
        au: date,
      },
    },
    async executer(api, a) {
      const docs = (await documents(api, str(a.type)))
        .map(resume)
        .filter((d) => (!a.du || d.date >= String(a.du)) && (!a.au || d.date <= String(a.au)));
      if (a.format === "json") return docs;
      const cols = ["numero", "type", "statut", "date", "echeance", "client", "ttcCents", "id"] as const;
      return [cols.join(";"), ...docs.map((d) => cols.map((c) => csv(d[c])).join(";"))].join("\n");
    },
  },
  {
    nom: "lister_automatisations",
    description: "Workflows d'automatisation de l'entreprise : déclencheur, actif ou non, dernière exécution.",
    lecture: true,
    schema: { type: "object", properties: {} },
    executer: (api) => api.get("/v1/automatisations"),
  },
  {
    nom: "catalogue_automatisation",
    description:
      "Types de nœuds disponibles pour construire un workflow (déclencheurs, logique, données, HTTP, Slack, mail, IA, actions auto), paramètres en JSON Schema, et modèles prêts à l'emploi.",
    lecture: true,
    schema: { type: "object", properties: {} },
    executer: async (api) => ({
      catalogue: await api.get("/v1/automatisations/catalogue"),
      modeles: await api.get("/v1/automatisations/modeles"),
    }),
  },
  {
    nom: "creer_automatisation",
    description:
      "Crée un workflow à partir d'une définition { noeuds: [{ id, type, nom, parametres, position: [x, y] }], connexions: [{ de, sortie, vers }] } avec un seul déclencheur. Expressions : {{ $json.champ }}, {{ $secret.nom }}. Créé inactif sauf actif: true.",
    lecture: false,
    schema: {
      type: "object",
      properties: {
        nom: { type: "string" },
        description: { type: "string" },
        definition: { type: "object" },
        actif: { type: "boolean" },
      },
      required: ["nom", "definition"],
    },
    executer: (api, a) => api.post("/v1/automatisations", a),
  },
  {
    nom: "importer_n8n",
    description:
      "Importe un workflow exporté de n8n (JSON nodes + connections) : conversion des nœuds courants et des expressions, un workflow par déclencheur, création inactive ; renvoie les avertissements à traiter.",
    lecture: false,
    schema: { type: "object", properties: { workflow: { type: "object" } }, required: ["workflow"] },
    async executer(api, a) {
      const r = await api.post<{
        nom: string;
        definition: unknown;
        avertissements: string[];
        autres: { nom: string; definition: unknown }[];
      }>("/v1/automatisations/importer-n8n", { workflow: a.workflow });
      // Un workflow par déclencheur n8n, tous créés inactifs.
      const automatisations = [];
      for (const w of [r, ...r.autres])
        automatisations.push(
          await api.post("/v1/automatisations", { nom: w.nom, definition: w.definition, actif: false }),
        );
      return { automatisations, avertissements: r.avertissements };
    },
  },
  {
    nom: "executer_automatisation",
    description: "Exécute un workflow maintenant avec des données d'entrée facultatives ; renvoie chaque étape.",
    lecture: false,
    schema: { type: "object", properties: { id, donnees: { type: "object" } }, required: ["id"] },
    executer: (api, a) => api.post(`/v1/automatisations/${enc(String(a.id))}/executer`, { donnees: a.donnees }),
  },
  {
    nom: "lire_execution",
    description: "Détail d'une exécution de workflow : statut, erreur, éléments produits par chaque nœud.",
    lecture: true,
    schema: { type: "object", properties: { id }, required: ["id"] },
    executer: (api, a) => api.get(`/v1/executions/${enc(String(a.id))}`),
  },
];

export const outil = (nom: string) => OUTILS.find((o) => o.nom === nom);
