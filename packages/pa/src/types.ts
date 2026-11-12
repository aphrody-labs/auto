// Contrat d'une plateforme agréée (PA) vu par une solution compatible.

/**
 * Statuts du cycle de vie (norme XP Z12-012, annexe du dossier de spécifications externes) :
 * 200 Déposée, 210 Refusée, 212 Encaissée et 213 Rejetée sont obligatoires ; les autres sont facultatifs.
 */
export const STATUTS = {
  deposee: 200,
  emise: 201,
  recue: 202,
  mise_a_disposition: 203,
  prise_en_charge: 204,
  approuvee: 205,
  approuvee_partiellement: 206,
  en_litige: 207,
  suspendue: 208,
  completee: 209,
  refusee: 210,
  paiement_transmis: 211,
  encaissee: 212,
  rejetee: 213,
  visee: 214,
} as const;

export type StatutCycle = keyof typeof STATUTS;

export const OBLIGATOIRES: readonly StatutCycle[] = ["deposee", "refusee", "encaissee", "rejetee"];

export const estStatut = (s: unknown): s is StatutCycle => typeof s === "string" && Object.hasOwn(STATUTS, s);

export const PLATEFORMES = ["mock", "b2brouter"] as const;
export type NomPlateforme = (typeof PLATEFORMES)[number];

export interface EvenementStatut {
  idPa: string;
  statut: StatutCycle;
  date: string;
  motif?: string;
}

/** Événement normalisé tiré d'un webhook de PA. */
export type EvenementPa = ({ type: "statut" } & EvenementStatut) | { type: "recue"; idPa: string; date: string };

export interface Depot {
  /** Exemplaire Factur-X figé (PDF/A-3b). */
  facturx: Uint8Array;
  numero: string;
  /** SIREN du destinataire, pour l'adressage par l'annuaire. */
  destinataireSiren?: string | null;
}

export interface Entrante {
  idPa: string;
  date: string;
}

export interface EntreeAnnuaire {
  siren: string;
  nom?: string;
  /** PA de réception déclarée à l'annuaire, si la PA interrogée la communique. */
  plateforme: string | null;
}

/** E-reporting des opérations hors e-invoicing : ventes B2C et opérations internationales. */
export interface Ereporting {
  nature: "b2c" | "international";
  /** Période déclarée, AAAA-MM. */
  periode: string;
  lignes: { tva: number; htCents: number; tvaCents: number; pays?: string }[];
}

/** Mandat donné par l'entreprise cliente à la solution compatible pour agir auprès de sa PA. */
export interface Mandat {
  siren: string;
  signataire: string;
  qualite: string;
  /** Date de signature, AAAA-MM-JJ. */
  date: string;
  perimetre: ("emission" | "reception" | "ereporting")[];
}

export interface Plateforme {
  readonly nom: NomPlateforme;
  /** Dépose une facture émise ; renvoie l'identifiant attribué par la PA et le premier statut. */
  deposer(d: Depot): Promise<{ idPa: string; statut: StatutCycle; motif?: string }>;
  /** Historique connu des statuts d'une facture déposée. */
  statuts(idPa: string): Promise<EvenementStatut[]>;
  /** Statut posé par l'entreprise (ex. encaissée, renseignée par le vendeur). */
  signaler(idPa: string, statut: StatutCycle, motif?: string): Promise<void>;
  /** Factures entrantes mises à disposition depuis une date (ISO). */
  entrantes(depuis?: string): Promise<Entrante[]>;
  /** Fichier de la facture entrante, tel que reçu. */
  telecharger(idPa: string): Promise<Uint8Array>;
  /** Annuaire : SIREN → plateforme de réception ; null si non inscrit. */
  annuaire(siren: string): Promise<EntreeAnnuaire | null>;
  ereporting(e: Ereporting): Promise<{ idPa: string; statut: StatutCycle }>;
  mandater(m: Mandat): Promise<{ reference: string }>;
  /** Webhook entrant : événements normalisés, ou null si la signature est invalide. */
  webhook(corps: string, entetes: Headers): Promise<EvenementPa[] | null>;
}

export class ErreurPa extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}
