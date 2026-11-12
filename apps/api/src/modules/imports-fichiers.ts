import { ErreurMetier } from "@auto/store";
import { segmentsDe, authentifier } from "@auto/tenancy";
import { importerFichier, cheminImport } from "@auto/services/imports-fichiers";
import type { Module, Chemins } from "../modules";
import { op, objet, str, uuid } from "../openapi-outils";
const MAX = 20 * 1024 * 1024 + 65536;
async function formulaire(req: Request) {
  if (!req.headers.get("content-type")?.startsWith("multipart/form-data;") || !req.body)
    throw new ErreurMetier("formulaire multipart requis", [], 415);
  if (Number(req.headers.get("content-length") ?? 0) > MAX)
    throw new ErreurMetier("20 Mo maximum par fichier", [], 413);
  const reader = req.body.getReader();
  let taille = 0;
  const flux = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const r = await reader.read();
        if (r.done) {
          c.close();
          return;
        }
        taille += r.value.length;
        if (taille > MAX) {
          await reader.cancel();
          c.error(new ErreurMetier("20 Mo maximum par fichier", [], 413));
          return;
        }
        c.enqueue(r.value);
      } catch (e) {
        c.error(e);
      }
    },
    cancel(r) {
      return reader.cancel(r);
    },
  });
  try {
    return await new Response(flux, { headers: { "content-type": req.headers.get("content-type")! } }).formData();
  } catch (e) {
    if (e instanceof ErreurMetier) throw e;
    throw new ErreurMetier(
      taille > MAX ? "20 Mo maximum par fichier" : "formulaire multipart invalide",
      [],
      taille > MAX ? 413 : 422,
    );
  }
}
export const routes: Module = ({ sql, auth, ba }) => ({
  "/v1/imports-fichiers": {
    POST: auth("ecrire", async (req, a) => {
      const attendue = typeof ba.options.baseURL === "string" ? new URL(ba.options.baseURL).origin : null;
      const origine = req.headers.get("origin"),
        bearer = /^Bearer\s+\S+$/i.test(req.headers.get("authorization") ?? "");
      if (req.headers.get("x-auto-import") !== "1" || !attendue || (origine ? origine !== attendue : !bearer))
        throw new ErreurMetier("origine de l’import refusée", [], 403);
      if (!origine) {
        const parJeton = await authentifier(sql, req.headers.get("authorization")!.replace(/^Bearer\s+/i, ""));
        if (!parJeton || parJeton.userId !== a.userId || parJeton.tenantId !== a.tenantId)
          throw new ErreurMetier("jeton d’import invalide", [], 403);
      }
      const f = await formulaire(req);
      for (const k of ["fichier", "cheminRelatif", "segment", "cible"])
        if (f.getAll(k).length > 1) throw new ErreurMetier("un seul fichier et une valeur par champ sont autorisés");
      for (const k of f.keys())
        if (!["fichier", "cheminRelatif", "segment", "cible"].includes(k))
          throw new ErreurMetier("champ d’import inconnu");
      const fichier = f.get("fichier"),
        s = f.get("segment"),
        cible = f.get("cible") ?? "index";
      if (!(fichier instanceof File) || !fichier.name || fichier.name.length > 255 || fichier.size > 20 * 1024 * 1024)
        throw new ErreurMetier("un fichier de 20 Mo maximum est requis", [], 413);
      if (typeof s !== "string" || !segmentsDe(a).includes(s as never))
        throw new ErreurMetier("accès refusé à ce segment", [], 403);
      if (typeof cible !== "string") throw new ErreurMetier("traitement invalide");
      const chemin = cheminImport(f.get("cheminRelatif"), fichier.name);
      return Response.json(
        await importerFichier(
          sql,
          a.tenantId,
          a.userId,
          { nom: fichier.name, chemin, segment: s, cible, contenu: await fichier.bytes() },
          req.signal,
        ),
        { status: 201 },
      );
    }),
  },
});
const entree = objet(
  {
    fichier: { type: "string", format: "binary" },
    cheminRelatif: str,
    segment: str,
    cible: { type: "string", enum: ["index", "devis", "facture"] },
  },
  ["fichier", "segment"],
);
export const openapi: Chemins = {
  "/v1/imports-fichiers": {
    post: {
      ...op({
        resume: "Importer un fichier ou un élément de dossier, avec chemin relatif et déduplication",
        tag: "Arrivages",
        droit: "ecrire",
        succes: {
          201: objet({
            id: uuid,
            fichierId: uuid,
            nom: str,
            cheminRelatif: str,
            segment: str,
            doublon: { type: "boolean" },
            devisId: { type: ["string", "null"], format: "uuid" },
            recueId: { type: ["string", "null"], format: "uuid" },
          }),
        },
        erreurs: [401, 403, 413, 415, 422],
      }),
      requestBody: { required: true, content: { "multipart/form-data": { schema: entree } } },
      parameters: [
        { name: "x-auto-import", in: "header", required: true, schema: { type: "string", const: "1" } },
        {
          name: "Origin",
          in: "header",
          required: false,
          description: "Origine exacte du front pour une session cookie ; facultative uniquement avec Bearer valide.",
          schema: str,
        },
      ],
    },
  },
};
