import { ajouterEvenement, type Tx } from "@auto/store";

/** Événements métier poussés vers l'automatisation (n8n) par l'outbox. */
export type TypeEvenement =
  | "document.emis"
  | "document.statut"
  | "paiement.enregistre"
  | "absence.demandee"
  | "absence.decidee"
  | "relance.a_envoyer"
  | "export.mensuel"
  | "invitation.creee"
  // Types ajoutés par les autres lots, de la forme `<domaine>.<fait>`.
  | `${string}.${string}`;

export type Evenement = { id: string; type: TypeEvenement; tenantId: string; date: string; data: unknown };

/**
 * Publication dans la transaction métier (withTenant) : l'événement entre dans l'outbox avec l'action
 * et sera livré par le worker, avec nouvel essai. Renvoie l'id de l'événement.
 */
export type Emetteur = (tx: Tx, type: TypeEvenement, data: unknown) => Promise<{ id: string }>;

export const outbox: Emetteur = (tx, type, data) => ajouterEvenement(tx, type, data);

export const SIGNATURE = "x-auto-signature";
/** Identifiant de l'événement (aussi présent dans le corps signé) : clé d'idempotence du récepteur. */
export const EN_TETE_ID = "x-auto-evenement";

/** Signature `sha256=<hex>` : HMAC-SHA256 du corps brut avec le secret partagé. */
export const signer = (secret: string, corps: string) =>
  `sha256=${new Bun.CryptoHasher("sha256", secret).update(corps).digest("hex")}`;

export interface Webhook {
  url: string;
  secret: string;
  timeoutMs?: number;
}

/** Un essai de livraison : POST JSON signé ; lève une erreur si le récepteur ne répond pas 2xx. */
export async function livrer(w: Webhook, id: string, corps: string, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(w.timeoutMs ?? 10_000);
  const r = await fetch(w.url, {
    method: "POST",
    headers: { "content-type": "application/json", [SIGNATURE]: signer(w.secret, corps), [EN_TETE_ID]: id },
    body: corps,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

/** Depuis l'environnement (`N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET`) ; sans URL, aucune livraison. */
export function webhookDepuisEnv(env: Record<string, string | undefined> = Bun.env): Webhook | null {
  const url = env.N8N_WEBHOOK_URL;
  if (!url) return null;
  if (!env.N8N_WEBHOOK_SECRET) throw new Error("N8N_WEBHOOK_SECRET requis avec N8N_WEBHOOK_URL");
  return { url, secret: env.N8N_WEBHOOK_SECRET };
}
