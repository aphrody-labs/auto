// Canonical RBAC roles, actions, and workspace segments (Zero DOM/Bun dependencies; safe in browsers & workers).
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";

export const ROLES = ["owner", "admin", "accountant", "viewer", "hr"] as const;
export type Role = (typeof ROLES)[number];

export type Action = "read" | "write" | "members" | "settings" | "hr";

export const SEGMENTS = ["customers", "suppliers", "projects", "deliveries", "orders"] as const;
export type Segment = (typeof SEGMENTS)[number];

export const PERMISSIONS: Record<Role, Action[]> = {
  owner: ["read", "write", "members", "settings", "hr"],
  admin: ["read", "write", "members", "settings", "hr"],
  accountant: ["read", "write"],
  viewer: ["read"],
  hr: ["read", "hr"],
};

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Administrator",
  accountant: "Accountant",
  viewer: "Viewer",
  hr: "Human Resources",
};

export const isRole = (r: unknown): r is Role => typeof r === "string" && (ROLES as readonly string[]).includes(r);

export const can = (role: Role, action: Action): boolean => PERMISSIONS[role]?.includes(action) ?? false;

export const statements = {
  ...defaultStatements,
  apiKey: ["create", "read", "update", "delete"],
  auto: ["read", "write", "members", "settings", "hr"],
} as const;

export const ac = createAccessControl(statements);

const adminOrg = {
  organization: ["update"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  apiKey: ["create", "read", "update", "delete"],
} as const;

export const roles = {
  owner: ac.newRole({ ...adminOrg, organization: ["update", "delete"], auto: [...PERMISSIONS.owner] }),
  admin: ac.newRole({ ...adminOrg, auto: [...PERMISSIONS.admin] }),
  accountant: ac.newRole({ auto: [...PERMISSIONS.accountant] }),
  viewer: ac.newRole({ auto: [...PERMISSIONS.viewer] }),
  hr: ac.newRole({ auto: [...PERMISSIONS.hr] }),
};

const SEGMENT_PREFIXES: { prefix: string; segment: Segment }[] = [
  { prefix: "/v1/customers", segment: "customers" },
  { prefix: "/v1/products", segment: "customers" },
  { prefix: "/v1/documents", segment: "customers" },
  { prefix: "/v1/subscriptions", segment: "customers" },
  { prefix: "/v1/einvoicing", segment: "customers" },
  { prefix: "/v1/suppliers", segment: "suppliers" },
  { prefix: "/v1/inbox", segment: "suppliers" },
  { prefix: "/v1/received-quotes", segment: "suppliers" },
  { prefix: "/v1/projects", segment: "projects" },
  { prefix: "/v1/supplier-docs", segment: "deliveries" },
];

export function segmentAllowed(allowed: readonly Segment[] | undefined, pathname: string, method: string): boolean {
  if (!allowed || allowed.length === SEGMENTS.length) return true;
  const hit = SEGMENT_PREFIXES.find((p) => pathname.startsWith(p.prefix));
  if (!hit) return true;
  if (method === "GET" && pathname.startsWith("/v1/documents")) return true;
  return allowed.includes(hit.segment);
}
