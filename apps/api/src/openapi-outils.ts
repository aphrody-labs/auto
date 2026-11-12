// Briques de description OpenAPI partagées par openapi.ts et les modules de lot.
import type { Action } from "@auto/tenancy";

export type Schema = Record<string, unknown>;

export const ref = (nom: string): Schema => ({ $ref: `#/components/schemas/${nom}` });
export const liste = (s: Schema): Schema => ({ type: "array", items: s });
export const json = (schema: Schema) => ({ content: { "application/json": { schema } } });
export const str: Schema = { type: "string" };
export const uuid: Schema = { type: "string", format: "uuid" };
export const date: Schema = { type: "string", format: "date" };
export const cents: Schema = { type: "integer", description: "Montant en centimes" };
export const objet = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});
export const enumere = (...valeurs: (string | number)[]): Schema => ({ enum: valeurs });
export const tva: Schema = { ...enumere(0, 21, 55, 100, 200), description: "Taux en dixièmes de pourcent" };
/** Réponse non JSON (PDF, XML). */
export const brut = (mime: string) => ({ mime });

export interface Op {
  resume: string;
  tag: string;
  /** Droit exigé ; absent : route publique. */
  droit?: Action;
  corps?: Schema;
  requete?: { nom: string; schema: Schema; description: string }[];
  /** Réponse de succès : statut → schéma (null : sans corps) ou contenu brut. */
  succes: Record<number, Schema | null | { mime: string }>;
  erreurs?: number[];
}

export function op(o: Op) {
  const responses: Record<string, unknown> = {};
  for (const [code, s] of Object.entries(o.succes)) {
    if (s === null) responses[code] = { description: "Sans contenu" };
    else if (typeof s.mime === "string")
      responses[code] = { description: "OK", content: { [s.mime]: { schema: { type: "string", format: "binary" } } } };
    else responses[code] = { description: "OK", ...json(s as Schema) };
  }
  for (const c of [...(o.droit ? [401, 403] : []), ...(o.erreurs ?? [])])
    responses[c] = { $ref: `#/components/responses/E${c}` };
  return {
    summary: o.resume,
    tags: [o.tag],
    ...(o.droit ? { "x-droit": o.droit } : { security: [] }),
    ...(o.requete?.length
      ? {
          parameters: o.requete.map((q) => ({
            name: q.nom,
            in: "query",
            required: false,
            schema: q.schema,
            description: q.description,
          })),
        }
      : {}),
    ...(o.corps ? { requestBody: { required: true, ...json(o.corps) } } : {}),
    responses,
  };
}

export const param = (nom: string, schema: Schema = uuid) => ({ name: nom, in: "path", required: true, schema });
export const avecId = (ops: Record<string, unknown>, nom = "id", schema?: Schema) => ({
  parameters: [param(nom, schema)],
  ...ops,
});
