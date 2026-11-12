import { createContext, useContext } from "react";
import type { Moi } from "@auto/client";
import { LIBELLES, peut as peutRole } from "@auto/tenancy/droits";

export interface Session {
  moi: Moi;
  recharger: () => Promise<void>;
}

export const ContexteSession = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(ContexteSession);
  if (!s) throw new Error("session absente");
  return s;
}

/** Droits par rôle, partagés avec l'API (`@auto/tenancy/droits`) ; l'API reste seule juge. */
export const peut = peutRole;

export const LIBELLE_ROLE = LIBELLES;
