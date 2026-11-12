// Console opérateur : page HTML importée (bundling natif de Bun) et même proxy same-origin `/v1` que le front.
// Elle n'a aucun droit propre : l'opérateur se connecte avec son compte du tenant opérateur (contact@aphrody.com).
import { proxifier } from "@auto/client/proxy";
import console_ from "../public/index.html";

export interface OptionsAdmin {
  /** URL de base de l'API (`AUTO_API_URL`). */
  api: string | URL;
}

export function routesAdmin(o: OptionsAdmin) {
  const proxy = proxifier(o.api);
  return {
    "/": console_,
    "/v1/*": proxy,
    "/health": proxy,
    // Plugin admin de Better Auth (comptes, bannissement, sessions).
    "/api/auth/*": proxy,
  };
}

export function demarrerAdmin(o: OptionsAdmin & { port?: number; development?: boolean }) {
  return Bun.serve({
    port: o.port ?? 0,
    development: o.development ?? false,
    routes: routesAdmin(o),
    fetch: () =>
      new Response("Page introuvable", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } }),
  });
}
