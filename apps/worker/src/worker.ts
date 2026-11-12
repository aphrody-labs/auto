// Boucle du worker : prend les jobs Postgres (SKIP LOCKED, bail), exécute, termine ou reporte.
import { delaiNouvelEssai, prendreJobs, reporterJob, terminerJob, type Job, type Sql } from "@auto/store";

export interface Traitement {
  /** Exécute le job ; une exception (ou le dépassement du bail) déclenche un nouvel essai. */
  executer(job: Job, signal: AbortSignal): Promise<void>;
  /** Appelé une fois les essais épuisés. */
  echec?(job: Job, erreur: string): Promise<void>;
}

export type Traitements = Record<string, Traitement>;

export interface OptionsWorker {
  /** Jobs pris par tour. */
  lot?: number;
  /** Durée du bail : au-delà, le job est abandonné ici et repris par un autre tour. */
  bailMs?: number;
  /** Attente entre deux tours sans job. */
  intervalleMs?: number;
  /** Délai avant l'essai suivant, selon le nombre d'essais déjà faits. */
  delai?: (essais: number) => number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function creerWorker(sql: Sql, traitements: Traitements, o: OptionsWorker = {}) {
  const { lot = 10, bailMs = 60_000, intervalleMs = 1_000, delai = (n: number) => delaiNouvelEssai(n) } = o;
  const types = Object.keys(traitements);

  async function executer(job: Job) {
    const t = traitements[job.type]!;
    // Marge sur le bail : le job est abandonné avant qu'un autre worker puisse le reprendre.
    const signal = AbortSignal.timeout(Math.max(1, bailMs - Math.min(1_000, bailMs / 10)));
    try {
      await Promise.race([
        t.executer(job, signal),
        new Promise<never>((_, rejeter) =>
          signal.addEventListener("abort", () => rejeter(new Error(`délai dépassé (${bailMs} ms)`)), { once: true }),
        ),
      ]);
      await terminerJob(sql, job.id);
    } catch (e) {
      const erreur = message(e);
      if ((await reporterJob(sql, job, erreur, delai(job.essais))) === "echec") {
        console.error(`job ${job.type} ${job.id} en échec après ${job.essais} essais : ${erreur}`);
        await t.echec?.(job, erreur);
      }
    }
  }

  /** Un tour : prend au plus `lot` jobs et les traite en parallèle ; renvoie le nombre traité. */
  async function traiterLot(): Promise<number> {
    const jobs = await prendreJobs(sql, types, lot, bailMs);
    await Promise.all(jobs.map(executer));
    return jobs.length;
  }

  let actif = false;
  let boucle: Promise<void> | null = null;
  let reveil: (() => void) | null = null;

  return {
    traiterLot,
    /** Traite jusqu'à ce que plus aucun job ne soit exécutable maintenant. */
    async vider(): Promise<number> {
      let total = 0;
      for (let n = await traiterLot(); n > 0; n = await traiterLot()) total += n;
      return total;
    },
    demarrer() {
      if (actif) return;
      actif = true;
      boucle = (async () => {
        while (actif) {
          let n = 0;
          try {
            n = await traiterLot();
          } catch (e) {
            console.error(`worker : ${message(e)}`);
          }
          if (n === 0 && actif)
            await new Promise<void>((r) => {
              reveil = r;
              setTimeout(r, intervalleMs);
            });
        }
      })();
    },
    /** Arrêt propre : le tour en cours se termine. */
    async arreter() {
      actif = false;
      reveil?.();
      await boucle;
    },
  };
}

export type Worker = ReturnType<typeof creerWorker>;
