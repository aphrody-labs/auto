import { expect, test } from "bun:test";
import { sociaux } from "./fournisseurs";

test("OAuth : fournisseurs désactivés sans secrets, configuration partielle refusée", () => {
  expect(sociaux({})).toEqual({});
  for (const nom of ["GOOGLE", "MICROSOFT"]) {
    expect(() => sociaux({ [`AUTO_${nom}_CLIENT_ID`]: "id" })).toThrow("requis ensemble");
    expect(() => sociaux({ [`AUTO_${nom}_CLIENT_SECRET`]: "secret" })).toThrow("requis ensemble");
    expect(() => sociaux({ [`AUTO_${nom}_CLIENT_ID`]: " ", [`AUTO_${nom}_CLIENT_SECRET`]: "secret" })).toThrow();
  }
});

test("OAuth : Google et Microsoft configurés, tenant Entra explicite", () => {
  const env = {
    AUTO_GOOGLE_CLIENT_ID: " google ",
    AUTO_GOOGLE_CLIENT_SECRET: "secret",
    AUTO_MICROSOFT_CLIENT_ID: "ms",
    AUTO_MICROSOFT_CLIENT_SECRET: "secret",
  };
  expect(sociaux(env)).toMatchObject({
    google: { clientId: "google", prompt: "select_account" },
    microsoft: { tenantId: "common" },
  });
  expect(sociaux({ ...env, AUTO_MICROSOFT_TENANT_ID: "tenant" })).toMatchObject({ microsoft: { tenantId: "tenant" } });
});
