import { test, expect } from "bun:test";
import { ipAdministration } from "./reseau-admin";
test("restriction IP admin : opt-in, proxy explicitement déclaré, IPv4/IPv6 exactes et refus des listes/en-têtes forgés", () => {
  const r = (headers: Record<string, string>, env: Record<string, string | undefined>) =>
    ipAdministration(new Request("https://auto.test", { headers }), env);
  expect(r({}, {}).autorise).toBe(true);
  expect(r({ "cf-connecting-ip": "192.0.2.1" }, { AUTO_ADMIN_IPS: "192.0.2.1" }).autorise).toBe(false);
  const env = { AUTO_ADMIN_IPS: "192.0.2.1,2001:db8::1", AUTO_ADMIN_IP_SOURCE: "cloudflare-tunnel" };
  expect(r({ "cf-connecting-ip": "192.0.2.1" }, env).autorise).toBe(true);
  expect(r({ "cf-connecting-ip": "2001:0db8:0:0:0:0:0:1" }, env).autorise).toBe(true);
  expect(r({ "x-forwarded-for": "192.0.2.1" }, env).autorise).toBe(false);
  expect(r({ "cf-connecting-ip": "192.0.2.1, 198.51.100.2" }, env).autorise).toBe(false);
  expect(r({ "cf-connecting-ip": "192.0.2.2" }, env).autorise).toBe(false);
  expect(r({ "cf-connecting-ip": "fe80::1%eth0" }, env).autorise).toBe(false);
  expect(r({ "cf-connecting-ip": "192.0.2.1" }, { ...env, AUTO_ADMIN_IPS: "192.0.2.1,invalid" }).autorise).toBe(false);
});
