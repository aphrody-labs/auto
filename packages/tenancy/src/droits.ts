// Rôles et droits des membres d'une entreprise : source unique, partagée par l'API (contrôle d'accès du
// plugin organization de Better Auth, `exiger`) et par le front (affichage seulement : l'API reste juge).
// Aucune dépendance serveur : importable dans le navigateur (`@auto/tenancy/droits`).
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";

export const ROLES = ["owner", "admin", "comptable", "lecture", "rh"] as const;
export type Role = (typeof ROLES)[number];

/** Actions métier de l'API (`auth(action, …)`). */
export type Action = "lire" | "ecrire" | "membres" | "parametres" | "rh";

export const DROITS: Record<Role, Action[]> = {
  owner: ["lire", "ecrire", "membres", "parametres", "rh"],
  admin: ["lire", "ecrire", "membres", "parametres", "rh"],
  comptable: ["lire", "ecrire"],
  lecture: ["lire"],
  rh: ["lire", "rh"],
};

export const LIBELLES: Record<Role, string> = {
  owner: "Propriétaire",
  admin: "Administrateur",
  comptable: "Comptable",
  lecture: "Lecture seule",
  rh: "Ressources humaines",
};

export const estRole = (r: unknown): r is Role => typeof r === "string" && (ROLES as readonly string[]).includes(r);

export const peut = (role: Role, action: Action) => DROITS[role]?.includes(action) ?? false;

/**
 * Contrôle d'accès Better Auth : énoncés par défaut du plugin organization (organisation, membres,
 * invitations), clés d'API de l'entreprise et actions métier d'auto.
 */
export const statements = {
  ...defaultStatements,
  apiKey: ["create", "read", "update", "delete"],
  auto: ["lire", "ecrire", "membres", "parametres", "rh"],
} as const;

export const ac = createAccessControl(statements);

const gestion = {
  organization: ["update"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  apiKey: ["create", "read", "update", "delete"],
} as const;

export const roles = {
  owner: ac.newRole({ ...gestion, organization: ["update", "delete"], auto: [...DROITS.owner] }),
  admin: ac.newRole({ ...gestion, auto: [...DROITS.admin] }),
  comptable: ac.newRole({ auto: [...DROITS.comptable] }),
  lecture: ac.newRole({ auto: [...DROITS.lecture] }),
  rh: ac.newRole({ auto: [...DROITS.rh] }),
};
