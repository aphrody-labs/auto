// Adaptateur `mock` : PA simulée en mémoire, déterministe (identifiants séquentiels par compte,
// horloge injectable). Sert au dev et aux tests ; `bacMock` pilote la PA comme le ferait l'acheteur
// ou l'administration (statuts, factures entrantes) et produit les webhooks signés correspondants.
import { egal, hmac, sha256 } from "./chiffrement";
import {
  estStatut,
  ErreurPa,
  type Depot,
  type EvenementPa,
  type EvenementStatut,
  type Plateforme,
  type StatutCycle,
} from "./types";

export interface IdentifiantsMock {
  compte: string;
  secretWebhook: string;
}

export const ENTETE_MOCK = "x-pa-signature";

interface Facture {
  sha256: string;
  numero: string;
  statuts: EvenementStatut[];
}

interface Compte {
  seq: number;
  factures: Map<string, Facture>;
  entrantes: Map<string, { date: string; contenu: Uint8Array }>;
}

const comptes = new Map<string, Compte>();

function compte(id: string): Compte {
  let c = comptes.get(id);
  if (!c) comptes.set(id, (c = { seq: 0, factures: new Map(), entrantes: new Map() }));
  return c;
}

const prochain = (c: Compte, prefixe: string) => `${prefixe}-${String(++c.seq).padStart(6, "0")}`;

/** Clé de Luhn du SIREN. */
export function sirenValide(siren: string): boolean {
  if (!/^\d{9}$/.test(siren)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(siren[8 - i]);
    if (i % 2) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    s += n;
  }
  return s % 10 === 0;
}

export function mock(ids: IdentifiantsMock, horloge: () => Date = () => new Date()): Plateforme {
  if (!ids.compte || !ids.secretWebhook) throw new ErreurPa("mock : compte et secretWebhook requis", 422);
  const c = compte(ids.compte);
  const maintenant = () => horloge().toISOString();
  const facture = (idPa: string) => {
    const f = c.factures.get(idPa);
    if (!f) throw new ErreurPa(`mock : facture ${idPa} inconnue`, 404);
    return f;
  };

  return {
    nom: "mock",
    async deposer(d: Depot) {
      const idPa = prochain(c, "MOCK");
      const h = sha256(d.facturx);
      let statut: StatutCycle = "deposee";
      let motif: string | undefined;
      if (new TextDecoder().decode(d.facturx.subarray(0, 5)) !== "%PDF-") {
        statut = "rejetee";
        motif = "NON_CONFORME : fichier non PDF";
      } else if ([...c.factures.values()].some((f) => f.sha256 === h && f.statuts.at(-1)?.statut !== "rejetee")) {
        statut = "rejetee";
        motif = "DOUBLON";
      }
      c.factures.set(idPa, { sha256: h, numero: d.numero, statuts: [{ idPa, statut, date: maintenant(), motif }] });
      return { idPa, statut, motif };
    },
    async statuts(idPa) {
      return [...facture(idPa).statuts];
    },
    async signaler(idPa, statut, motif) {
      facture(idPa).statuts.push({ idPa, statut, date: maintenant(), motif });
    },
    async entrantes(depuis) {
      return [...c.entrantes]
        .filter(([, e]) => !depuis || e.date >= depuis)
        .map(([idPa, e]) => ({ idPa, date: e.date }));
    },
    async telecharger(idPa) {
      const e = c.entrantes.get(idPa);
      if (!e) throw new ErreurPa(`mock : facture entrante ${idPa} inconnue`, 404);
      return e.contenu;
    },
    async annuaire(siren) {
      return sirenValide(siren) ? { siren, plateforme: "mock" } : null;
    },
    async ereporting() {
      return { idPa: prochain(c, "MOCK-ER"), statut: "deposee" };
    },
    async mandater(m) {
      return { reference: `MOCK-MANDAT-${m.siren}-${m.date}` };
    },
    async webhook(corps, entetes) {
      const sig = entetes.get(ENTETE_MOCK) ?? "";
      if (!egal(sig, `sha256=${hmac(ids.secretWebhook, corps)}`)) return null;
      const { evenements } = JSON.parse(corps) as { evenements?: unknown };
      if (!Array.isArray(evenements)) return [];
      return evenements.filter(
        (e): e is EvenementPa =>
          typeof e?.idPa === "string" && (e.type === "recue" || (e.type === "statut" && estStatut(e.statut))),
      );
    },
  };
}

/** Pilotage de la PA simulée, côté « reste du monde ». */
export const bacMock = {
  /** Fait avancer une facture déposée (statut posé par l'acheteur, la PA ou l'administration). */
  avancer(idCompte: string, idPa: string, statut: StatutCycle, date: string, motif?: string): EvenementPa {
    const f = compte(idCompte).factures.get(idPa);
    if (!f) throw new ErreurPa(`mock : facture ${idPa} inconnue`, 404);
    const e = { idPa, statut, date, motif };
    f.statuts.push(e);
    return { type: "statut", ...e };
  },
  /** Met une facture entrante (Factur-X) à disposition du compte. */
  livrer(idCompte: string, contenu: Uint8Array, date: string): EvenementPa {
    const c = compte(idCompte);
    const idPa = prochain(c, "MOCK-IN");
    c.entrantes.set(idPa, { date, contenu });
    return { type: "recue", idPa, date };
  },
  /** Corps et en-têtes d'un webhook signé comme le ferait la PA simulée. */
  webhook(secret: string, evenements: EvenementPa[]) {
    const corps = JSON.stringify({ evenements });
    return { corps, entetes: { "content-type": "application/json", [ENTETE_MOCK]: `sha256=${hmac(secret, corps)}` } };
  },
  vider(idCompte?: string) {
    if (idCompte) comptes.delete(idCompte);
    else comptes.clear();
  },
};
