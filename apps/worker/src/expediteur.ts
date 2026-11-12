// Expéditeur de l'outbox : premier type de job du worker. Livraison au moins une fois ; le récepteur
// dédoublonne par l'identifiant d'événement (corps signé et en-tête x-auto-evenement).
import { livrer, type Webhook } from "@auto/services";
import { infoSecret } from "@auto/services/webhooks";
import { JOB_LIVRAISON, JOB_WEBHOOK, lireEvenement, lireWebhook, noterLivraison, type Sql } from "@auto/store";
import { dechiffrer } from "@auto/tenancy";
import type { Traitements } from "./worker";

const id = (payload: Record<string, unknown>) => String(payload.evenementId);

/** Livraison opérateur (n8n de l'opérateur) : l'état de livraison est porté par l'événement. */
export function expediteur(sql: Sql, w: Webhook): Traitements {
  return {
    [JOB_LIVRAISON]: {
      async executer(job, signal) {
        const e = await lireEvenement(sql, id(job.payload));
        if (!e || e.statut === "livre") return;
        try {
          await livrer(w, e.id, e.corps, signal);
        } catch (err) {
          await noterLivraison(sql, e.id, err instanceof Error ? err.message : String(err));
          throw err;
        }
        await noterLivraison(sql, e.id, null);
      },
      async echec(job, erreur) {
        await noterLivraison(sql, id(job.payload), erreur, true);
      },
    },
  };
}

/**
 * Abonnements webhook des tenants : même corps signé, secret propre à l'abonnement (déchiffré à chaque
 * envoi) ; l'état de livraison est celui du job. Actif même sans livraison opérateur.
 */
export function abonnementsTenants(sql: Sql): Traitements {
  return {
    [JOB_WEBHOOK]: {
      async executer(job, signal) {
        const [e, w] = await Promise.all([
          lireEvenement(sql, id(job.payload)),
          lireWebhook(sql, String(job.payload.webhookId)),
        ]);
        if (!e || !w || !w.actif || w.tenantId !== e.tenantId) return;
        const secret = new TextDecoder().decode(await dechiffrer(infoSecret(w.tenantId), w.secretChiffre));
        await livrer({ url: w.url, secret }, e.id, e.corps, signal);
      },
    },
  };
}
