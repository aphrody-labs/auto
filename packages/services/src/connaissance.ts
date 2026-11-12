// Base de connaissances des automatisations (RAG) : découpage natif (aphrody-rag-core par auto-ffi), embeddings
// par une API compatible OpenAI (`POST <url>/embeddings` : aphrody-llama-server, Ollama, OpenAI…) appelée par le
// `fetch` gardé du workflow, stockage sous RLS (table connaissance) et recherche exacte par similarité cosinus.
import type { ApiEmbeddings, MorceauTrouve, Services } from "@auto/automate";
import { decouperTexte, plusProches } from "@auto/native";
import { lireMorceaux, remplacerSource, vecteursBase, withTenant, type Sql } from "@auto/store";

/** Textes envoyés par requête d'embeddings. */
const LOT = 32;
/** Morceaux au plus par indexation (un document de quelques Mo). */
const MORCEAUX_PAR_SOURCE = 4000;

/** Embeddings des textes, dans l'ordre, par lots. */
export async function embeddings(
  fetch: Services["fetch"],
  api: ApiEmbeddings,
  textes: string[],
  signal: AbortSignal,
): Promise<Float32Array[]> {
  const url = `${api.url.replace(/\/+$/, "")}/embeddings`;
  const sortie: Float32Array[] = [];
  for (let i = 0; i < textes.length; i += LOT) {
    const lot = textes.slice(i, i + LOT);
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(api.cle ? { authorization: `Bearer ${api.cle}` } : {}) },
      body: JSON.stringify({ model: api.modele, input: lot }),
      signal,
    });
    const brut = await r.text();
    if (!r.ok) throw new Error(`embeddings : HTTP ${r.status} : ${brut.slice(0, 300)}`);
    let corps: { data?: { embedding?: unknown; index?: number }[] };
    try {
      corps = JSON.parse(brut);
    } catch {
      throw new Error("embeddings : réponse JSON invalide");
    }
    const data = [...(corps.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== lot.length)
      throw new Error(`embeddings : ${data.length} vecteurs reçus pour ${lot.length} textes`);
    for (const d of data) {
      if (!Array.isArray(d.embedding) || !d.embedding.length || d.embedding.some((x) => typeof x !== "number"))
        throw new Error("embeddings : vecteur invalide");
      sortie.push(Float32Array.from(d.embedding as number[]));
    }
  }
  const dimension = sortie[0]?.length ?? 0;
  if (sortie.some((v) => v.length !== dimension)) throw new Error("embeddings : dimensions différentes");
  return sortie;
}

/** Service `connaissance` d'une exécution, sur la base de l'entreprise. */
export function servicesConnaissance(
  sql: Sql,
  tenantId: string,
  auteur: string | null,
  fetch: Services["fetch"],
): NonNullable<Services["connaissance"]> {
  return {
    async indexer(o, signal) {
      const morceaux = decouperTexte(o.source, o.texte, o.taille);
      if (!morceaux.length) throw new Error("aucun texte à indexer");
      if (morceaux.length > MORCEAUX_PAR_SOURCE)
        throw new Error(`document trop long : ${morceaux.length} morceaux (${MORCEAUX_PAR_SOURCE} au plus par source)`);
      const vecteurs = await embeddings(
        fetch,
        o.embeddings,
        morceaux.map((m) => m.texte),
        signal,
      );
      return withTenant(sql, tenantId, (tx) =>
        remplacerSource(tx, auteur, {
          base: o.base,
          source: o.source,
          modele: o.embeddings.modele,
          morceaux: morceaux.map((m, i) => ({ position: m.position, texte: m.texte, vecteur: vecteurs[i]! })),
        }),
      );
    },
    async rechercher(o, signal): Promise<MorceauTrouve[]> {
      const base = await withTenant(sql, tenantId, (tx) => vecteursBase(tx, o.base));
      if (!base) throw new Error(`base de connaissances « ${o.base} » vide ou inconnue`);
      if (base.modele !== o.embeddings.modele)
        throw new Error(`base « ${o.base} » indexée avec ${base.modele} : même modèle d'embeddings requis`);
      const [question] = await embeddings(fetch, o.embeddings, [o.question], signal);
      const proches = plusProches(question!, base.matrice, base.dimension, o.k, o.diversite).filter(
        (p) => p.score >= o.scoreMin,
      );
      const score = new Map(proches.map((p) => [base.ids[p.indice]!, p.score]));
      const lus = await withTenant(sql, tenantId, (tx) => lireMorceaux(tx, [...score.keys()]));
      return lus.map((m) => ({ source: m.source, position: m.position, texte: m.texte, score: score.get(m.id)! }));
    },
  };
}
