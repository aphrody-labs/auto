// Exécution des workflows par le worker : déclenchés par un événement de l'outbox (job enfilé dans la
// transaction de l'événement) ou par leur cron (tâche minute, un job par workflow dû, clé par minute).
// Une erreur du workflow est consignée dans son exécution et ne relance pas le job : les effets déjà produits
// (mail, message) ne doivent pas être répétés. Seule une panne d'infrastructure provoque un nouvel essai.
import { lancer } from "@auto/services/automatisations";
import {
  automatisationsPlanifiees,
  avecWorker,
  enfiler,
  JOB_AUTOMATISATION,
  type ChargeExecution,
  type Job,
  type Sql,
} from "@auto/store";
import type { Traitements } from "./worker";

/** Le cron tombe-t-il sur cette minute (début de minute, fuseau du workflow) ? */
export function estDue(cron: string, minute: Date, fuseau: string): boolean {
  try {
    return Bun.cron.parse(cron, new Date(minute.getTime() - 1000), { tz: fuseau })?.getTime() === minute.getTime();
  } catch {
    return false;
  }
}

export const debutMinute = (d: Date) => new Date(Math.floor(d.getTime() / 60_000) * 60_000);

/** Enfile les workflows planifiés dus à cette minute ; renvoie le nombre enfilé. */
export async function planifierAutomatisations(sql: Sql, minute: Date): Promise<number> {
  const dus = (await automatisationsPlanifiees(sql)).filter((a) => estDue(a.cron, minute, a.fuseau));
  const iso = minute.toISOString().slice(0, 16);
  await avecWorker(sql, async (tx) => {
    for (const a of dus) {
      const charge: ChargeExecution = {
        automatisationId: a.id,
        origine: `planifie:${iso}`,
        entree: [{ json: { minute: minute.toISOString(), cron: a.cron, fuseau: a.fuseau } }],
      };
      await enfiler(tx, JOB_AUTOMATISATION, charge, {
        cle: `automatisation:${a.id}:${iso}`,
        tenantId: a.tenantId,
        maxEssais: 3,
      });
    }
  });
  return dus.length;
}

export function automatisations(sql: Sql): Traitements {
  return {
    "automatisations.planifier": {
      async executer(job: Job) {
        await planifierAutomatisations(sql, new Date(String(job.payload.minute)));
      },
    },
    [JOB_AUTOMATISATION]: {
      async executer(job: Job, signal: AbortSignal) {
        if (!job.tenantId) throw new Error("exécution sans tenant");
        const c = job.payload as unknown as ChargeExecution;
        try {
          await lancer(sql, {
            tenantId: job.tenantId,
            automatisationId: c.automatisationId,
            origine: c.origine,
            entree: c.entree,
            signal,
          });
        } catch (e) {
          // Workflow supprimé entre l'enfilage et l'exécution : rien à faire.
          if (e instanceof Error && e.message === "automatisation introuvable") return;
          throw e;
        }
      },
    },
  };
}
