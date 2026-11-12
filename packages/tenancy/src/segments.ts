// Sans dépendance serveur : les mêmes règles alimentent la navigation et le contrôle HTTP.
export const SEGMENTS = ["clients", "fournisseurs", "chantiers", "livraisons", "commandes"] as const;
export type Segment = (typeof SEGMENTS)[number];
export const LIBELLES_SEGMENTS: Record<Segment, string> = {
  clients: "Comptabilité clients",
  fournisseurs: "Comptabilité fournisseurs",
  chantiers: "Analytique chantier",
  livraisons: "Bons de livraison",
  commandes: "Confirmations de commande",
};
export type AccesSegments = { role: string; segments?: Segment[] };
export const segmentsDe = (a: AccesSegments): readonly Segment[] =>
  ["owner", "admin"].includes(a.role) || a.segments === undefined ? SEGMENTS : a.segments;
export const accesSegment = (a: AccesSegments, s: Segment) => segmentsDe(a).includes(s);
/** Les listes de référence sont partagées ; les dossiers et opérations restent segmentés. */
export function segmentsRequis(chemin: string, methode: string): readonly Segment[] | "tous" | null {
  let p: string;
  try {
    p = decodeURIComponent(chemin)
      .replace(/\/{2,}/g, "/")
      .replace(/\/$/, "");
  } catch {
    return "tous";
  }
  const lecture = methode === "GET";
  if (/^\/v1\/(mail|pa|automatisations|executions|connaissances|conformite)(\/|$)/.test(p)) return "tous";
  if (/^\/v1\/imports\/(clients|produits)$/.test(p)) return ["clients"];
  if (p === "/v1/recherche-gestion" || p.startsWith("/v1/exports/gestion.")) return SEGMENTS;
  if (/^\/v1\/(devis-recus|factures-recues)(\/|$)/.test(p)) return ["fournisseurs"];
  if (p.startsWith("/v1/fournisseurs"))
    return lecture && p === "/v1/fournisseurs"
      ? ["fournisseurs", "chantiers", "livraisons", "commandes"]
      : ["fournisseurs"];
  if (p === "/v1/chantiers") return lecture ? SEGMENTS : ["chantiers"];
  if (p.startsWith("/v1/chantiers/")) return ["chantiers"];
  if (p.startsWith("/v1/pieces-chantier")) return ["livraisons", "commandes"];
  if (/^\/v1\/(sources-fichiers|fichiers-indexes|atelier|imports-fichiers)(\/|$)/.test(p)) return SEGMENTS;
  if (/^\/v1\/(documents|relances|exports)(\/|$)/.test(p)) return ["clients"];
  if (/^\/v1\/(clients|produits)(\/|$)/.test(p)) return lecture ? ["clients", "chantiers"] : ["clients"];
  return null;
}
export function requetePermise(a: AccesSegments, chemin: string, methode: string) {
  const requis = segmentsRequis(chemin, methode);
  const permis = segmentsDe(a);
  return (
    requis === null ||
    (requis === "tous" ? SEGMENTS.every((s) => permis.includes(s)) : requis.some((s) => permis.includes(s)))
  );
}
export function pagePermise(a: AccesSegments, p: string) {
  if (p.startsWith("/app/atelier")) return segmentsDe(a).length > 0;
  if (p.startsWith("/app/documents") || /^\/app\/(devis|factures|avoirs|clients|produits|imports)(\/|$)/.test(p))
    return accesSegment(a, "clients");
  if (/^\/app\/(achats|fournisseurs|devis-recus)(\/|$)/.test(p)) return accesSegment(a, "fournisseurs");
  if (p.startsWith("/app/chantiers")) return accesSegment(a, "chantiers");
  if (p.startsWith("/app/livraisons")) return accesSegment(a, "livraisons");
  if (p.startsWith("/app/commandes")) return accesSegment(a, "commandes");
  if (p.startsWith("/app/pieces")) return accesSegment(a, "livraisons") || accesSegment(a, "commandes");
  if (p.startsWith("/app/automatisations")) return SEGMENTS.every((s) => accesSegment(a, s));
  if (p.startsWith("/app/sources-fichiers")) return ["owner", "admin"].includes(a.role);
  return true;
}
