import { expect, test } from "bun:test";
import type { Sql } from "@auto/store";
import { creerApp } from "./app";
import { creerAuth } from "@auto/tenancy";
import { specification, specificationComplete } from "./openapi";

const METHODES = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const routes: Record<string, unknown> = creerApp({} as Sql, undefined, { auth: { validerSchema: false } });
const spec = specification();
const paths = spec.paths as Record<string, Record<string, unknown>>;

/** `/v1/documents/:id` → `/v1/documents/{id}`. */
const chemin = (r: string) => r.replace(/:(\w+)/g, "{$1}");

test("chaque route /v1 de creerApp est documentée, méthode par méthode", () => {
  const manquantes: string[] = [];
  for (const [route, h] of Object.entries(routes)) {
    if (!route.startsWith("/v1/")) continue;
    const methodes = typeof h === "function" ? ["GET"] : Object.keys(h as object).filter((m) => METHODES.includes(m));
    for (const m of methodes) if (!paths[chemin(route)]?.[m.toLowerCase()]) manquantes.push(`${m} ${route}`);
  }
  expect(manquantes).toEqual([]);
});

test("aucune route documentée sans implémentation", () => {
  const implementees = new Set(Object.keys(routes).map(chemin));
  expect(Object.keys(paths).filter((p) => !implementees.has(p))).toEqual([]);
});

test("références de schémas résolues", () => {
  const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/(\w+)\/([^"]+)"/g)];
  expect(refs.length).toBeGreaterThan(50);
  const comps = spec.components as Record<string, Record<string, unknown>>;
  expect(refs.filter(([, k, n]) => !comps[k!]?.[n!]).map(([r]) => r)).toEqual([]);
});

const complete = () =>
  specificationComplete(() =>
    creerAuth({} as Sql, { baseURL: "https://auto.aphrody.com", validerSchema: false }).api.generateOpenAPISchema(),
  );

test("docs/openapi.json à jour (bun scripts/openapi.ts)", async () => {
  const fichier = await Bun.file(new URL("../../../docs/openapi.json", import.meta.url)).json();
  expect(fichier).toEqual(JSON.parse(JSON.stringify(await complete())));
});

test("servie sur GET /v1/openapi.json, routes Better Auth fusionnées", async () => {
  const r = await (routes["/v1/openapi.json"] as { GET: () => Promise<Response> }).GET();
  expect(r.headers.get("content-type")).toContain("application/json");
  const s = (await r.json()) as { openapi: string; paths: Record<string, unknown> };
  expect(s.openapi).toBe("3.1.0");
  for (const p of ["/api/auth/sign-in/email", "/api/auth/organization/invite-member", "/api/auth/two-factor/enable"])
    expect(s.paths[p]).toBeDefined();
  const refs = [...JSON.stringify(await complete()).matchAll(/"\$ref":"#\/components\/(\w+)\/([^"]+)"/g)];
  const comps = (await complete()).components as Record<string, Record<string, unknown>>;
  expect(refs.filter(([, k, n]) => !comps[k!]?.[n!]).map(([x]) => x)).toEqual([]);
});
