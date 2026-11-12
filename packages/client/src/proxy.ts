// Proxy same-origin vers l'API (`/v1`, Better Auth, MCP), partagé par le front et la console opérateur.

/** En-têtes propres à un saut HTTP : jamais retransmis par le proxy. */
const SAUT = ["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length"];

/**
 * Proxy vers l'API : même origine pour le navigateur, donc le cookie `auto.session_token` (HttpOnly, Secure,
 * SameSite=Lax) et l'anti-CSRF par `Content-Type` fonctionnent sans CORS.
 */
export function proxifier(api: string | URL) {
  const base = new URL(api);
  return async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    const cible = new URL(u.pathname + u.search, base);
    const entree = new Headers(req.headers);
    for (const h of SAUT) entree.delete(h);
    entree.delete("accept-encoding");
    // Origine publique vue par le navigateur : l'API s'en sert pour les liens qu'elle fabrique (devis, paiement).
    entree.set("x-forwarded-host", u.host);
    entree.set("x-forwarded-proto", u.protocol.replace(":", ""));
    const corps = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    let res: Response;
    try {
      res = await fetch(cible, { method: req.method, headers: entree, body: corps, redirect: "manual" });
    } catch {
      return Response.json({ erreur: "API injoignable" }, { status: 502 });
    }
    const sortie = new Headers(res.headers);
    for (const h of [...SAUT, "content-encoding"]) sortie.delete(h);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: sortie });
  };
}
