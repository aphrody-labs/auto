// Connecteurs de plateformes agréées (PA) : contrat `Plateforme`, adaptateurs mock et B2Brouter.
import { b2brouter, type IdentifiantsB2brouter, type OptionsB2brouter } from "./b2brouter";
import { mock, type IdentifiantsMock } from "./mock";
import { ErreurPa, type NomPlateforme, type Plateforme } from "./types";

export * from "./types";
export * from "./chiffrement";
export { bacMock, ENTETE_MOCK, mock, sirenValide, type IdentifiantsMock } from "./mock";
export {
  b2brouter,
  B2BROUTER_URL,
  ENTETE_B2BROUTER,
  ETATS,
  xmlEreporting,
  type IdentifiantsB2brouter,
  type OptionsB2brouter,
} from "./b2brouter";

export type Identifiants = IdentifiantsMock | IdentifiantsB2brouter;

export interface Options {
  b2brouter?: OptionsB2brouter;
  horloge?: () => Date;
}

/** Adaptateur d'une PA à partir des identifiants déchiffrés du tenant. */
export function plateforme(nom: NomPlateforme, ids: Identifiants, o: Options = {}): Plateforme {
  switch (nom) {
    case "mock":
      return mock(ids as IdentifiantsMock, o.horloge);
    case "b2brouter":
      return b2brouter(ids as IdentifiantsB2brouter, { horloge: o.horloge, ...o.b2brouter });
    default:
      throw new ErreurPa(`plateforme inconnue : ${String(nom)}`, 422);
  }
}
