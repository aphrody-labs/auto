// Consommation et vérification des quotas du tenant courant (transaction sous withTenant).
import {
  compterEmployesActifs,
  ErreurMetier,
  incrementerCompteur,
  lireAbonnement,
  lireCompteur,
  octetsStockes,
  type Tx,
} from "@auto/store";
import { LIBELLES, MENSUELLES, periode, planEffectif, type Plan, type Ressource } from "./plans";

type Jauge = (tx: Tx) => Promise<number>;

/**
 * Jauges instantanées. `boites_mail` vaut 0 tant que le lot mail ne branche pas la sienne
 * avec `definirJauge("boites_mail", …)`.
 */
const JAUGES: Partial<Record<Ressource, Jauge>> = {
  employes: compterEmployesActifs,
  stockage: octetsStockes,
  boites_mail: async () => 0,
};

export function definirJauge(r: Exclude<Ressource, "factures" | "appels_llm">, j: Jauge) {
  JAUGES[r] = j;
}

/** Quantité utilisée : compteur du mois pour les ressources mensuelles, jauge sinon. */
export async function utilise(tx: Tx, r: Ressource, d = new Date()): Promise<number> {
  if (MENSUELLES.includes(r)) return lireCompteur(tx, periode(d), r);
  return (await JAUGES[r]?.(tx)) ?? 0;
}

export class ErreurQuota extends ErreurMetier {
  constructor(
    readonly ressource: Ressource,
    readonly limite: number,
    readonly utilisee: number,
    plan: Plan,
  ) {
    super(
      `quota atteint : ${limite} ${LIBELLES[ressource]} sur le plan ${plan.nom}`,
      [
        `ressource ${ressource}`,
        `utilisé ${utilisee}`,
        `limite ${limite}`,
        "changer de plan : POST /v1/abonnement/checkout",
      ],
      402,
    );
  }
}

export async function planCourant(tx: Tx): Promise<Plan> {
  return planEffectif(await lireAbonnement(tx));
}

/** Lève une erreur 402 si `ajout` unités de plus dépassent le quota du plan effectif. */
export async function verifierQuota(tx: Tx, r: Ressource, ajout = 1, d = new Date()): Promise<void> {
  const plan = await planCourant(tx);
  const limite = plan.quotas[r];
  if (limite === null) return;
  const u = await utilise(tx, r, d);
  if (u + ajout > limite) throw new ErreurQuota(r, limite, u, plan);
}

/** Vérifie puis compte une consommation mensuelle (appels LLM). */
export async function consommer(tx: Tx, r: "appels_llm" | "factures", n = 1, d = new Date()): Promise<number> {
  await verifierQuota(tx, r, n, d);
  return incrementerCompteur(tx, periode(d), r, n);
}

export interface LigneConsommation {
  ressource: Ressource;
  libelle: string;
  utilise: number;
  limite: number | null;
}

/** État de toutes les ressources du tenant courant. */
export async function consommation(tx: Tx, d = new Date()): Promise<LigneConsommation[]> {
  const plan = await planCourant(tx);
  const res: LigneConsommation[] = [];
  for (const r of Object.keys(plan.quotas) as Ressource[])
    res.push({ ressource: r, libelle: LIBELLES[r], utilise: await utilise(tx, r, d), limite: plan.quotas[r] });
  return res;
}
