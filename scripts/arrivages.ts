// Exploitation du connecteur ; ne journalise ni identifiants du service IA ni contenu des pièces.
import { realpath } from "node:fs/promises";
import { connect, withTenant, sourcesFichiers, identifiant } from "../packages/store/src/index";
import { configLlmDepuisEnv } from "../packages/ingest/src/index";
import { preparerArrivages, synchroniserSource } from "../packages/services/src/sources-fichiers";
const sql = connect();
try {
  const action = Bun.argv[2] ?? "verifier";
  if (action === "preparer") console.log(JSON.stringify(await preparerArrivages(sql)));
  else if (action === "synchroniser") {
    const tenant = identifiant(Bun.argv[3]);
    for (const s of await withTenant(sql, tenant, sourcesFichiers))
      if (s.actif) console.log(s.nom, JSON.stringify(await synchroniserSource(sql, tenant, s.id)));
  } else if (action === "verifier") {
    const llm = configLlmDepuisEnv();
    if (!llm) throw new Error("service IA non configuré");
    const r = await fetch(llm.url.replace(/\/$/, "") + "/models", {
      headers: llm.cle ? { authorization: "Bearer " + llm.cle } : {},
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error("service IA inaccessible");
    const modeles = (await r.json()) as { data?: { id: string }[] };
    if (llm.modele && !modeles.data?.some((m) => m.id === llm.modele)) throw new Error("modèle configuré absent");
    if (Bun.env.AUTO_DOSSIERS_PARENT) await realpath(Bun.env.AUTO_DOSSIERS_PARENT);
    const [b] = await sql`SELECT count(*)::int AS sources FROM source_fichiers WHERE actif`;
    console.log(
      JSON.stringify({
        ia: "accessible",
        modele: llm.modele,
        ocrPdf: !!Bun.which("pdftotext"),
        ocrFrancais: !!Bun.which("tesseract"),
        sourcesActives: b.sources,
      }),
    );
  } else throw new Error("actions : preparer, verifier, synchroniser UUID_ENTREPRISE");
} finally {
  await sql.close();
}
