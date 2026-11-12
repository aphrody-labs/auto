// Point d'extension de l'API : chaque lot ajoute ses routes dans apps/api/src/modules/<lot>.ts.
import type { Sql } from "@auto/store";
import type { Action, Auth, AuthAuto } from "@auto/tenancy";
import type { Emetteur } from "@auto/services";

export interface Contexte {
  sql: Sql;
  publier: Emetteur;
  /** Route publique : erreurs métier converties en réponses JSON. */
  pub: <R extends Request>(fn: (req: R) => Promise<Response>) => (req: R) => Promise<Response>;
  /** Route authentifiée : droit exigé, appelant résolu (la transaction reste à ouvrir par withTenant). */
  auth: <R extends Request>(
    action: Action,
    fn: (req: R, a: Auth) => Promise<Response>,
  ) => (req: R) => Promise<Response>;
  /** Instance Better Auth de l'API. */
  ba: AuthAuto;
}

/**
 * Origine publique de l'application pour les liens envoyés aux clients : `AUTO_URL_APP` en production, sinon
 * l'hôte transmis par le proxy du front (`x-forwarded-host`), sinon l'origine de la requête.
 */
export function origineApp(req: Request): string {
  if (Bun.env.AUTO_URL_APP) return Bun.env.AUTO_URL_APP.replace(/\/+$/, "");
  const hote = req.headers.get("x-forwarded-host");
  const proto = req.headers.get("x-forwarded-proto") === "https" ? "https" : "http";
  return hote && /^[\w.-]+(:\d+)?$/.test(hote) ? `${proto}://${hote}` : new URL(req.url).origin;
}

/** Routes au format `Bun.serve({ routes })`. */
export type Module = (c: Contexte) => Record<string, unknown>;

/**
 * Description OpenAPI 3.1 des routes d'un module (`export const openapi: Chemins`), chemins au format
 * `/v1/x/{id}` : fusionnée dans GET /v1/openapi.json ; openapi.test.ts exige chaque route documentée.
 */
export type Chemins = Record<string, Record<string, unknown>>;
