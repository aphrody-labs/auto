// Paiement en ligne : configuration d'encaissement du tenant (clé Stripe chiffrée, migration 016).
import type { Tx } from "./db";

export interface Encaissement {
  fournisseur: "stripe";
  cleChiffree: Uint8Array<ArrayBuffer>;
  apercu: string;
}

export async function lireEncaissement(tx: Tx): Promise<Encaissement | null> {
  const [r] = await tx<{ fournisseur: "stripe"; cle_chiffree: Uint8Array<ArrayBuffer>; apercu: string }[]>`
    SELECT fournisseur, cle_chiffree, apercu FROM encaissement`;
  return r ? { fournisseur: r.fournisseur, cleChiffree: r.cle_chiffree, apercu: r.apercu } : null;
}

export async function enregistrerEncaissement(tx: Tx, cleChiffree: Uint8Array, apercu: string) {
  await tx`
    INSERT INTO encaissement (cle_chiffree, apercu) VALUES (${cleChiffree}, ${apercu})
    ON CONFLICT (tenant_id) DO UPDATE SET cle_chiffree = EXCLUDED.cle_chiffree, apercu = EXCLUDED.apercu, updated_at = now()`;
}

export async function supprimerEncaissement(tx: Tx) {
  await tx`DELETE FROM encaissement`;
}

/** Vrai si un paiement de cette référence existe déjà (idempotence du retour de paiement en ligne). */
export async function paiementExiste(tx: Tx, reference: string): Promise<boolean> {
  return (await tx`SELECT 1 FROM paiement WHERE reference = ${reference}`).length > 0;
}
