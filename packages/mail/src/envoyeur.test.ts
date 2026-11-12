import { expect, test } from "bun:test";
import { configRelais, envoyeurDepuisEnv } from "./envoyeur";

test("SMTP : configuration invalide refusée avant la première connexion", () => {
  for (const port of ["0", "65536", "abc", "12.5", ""]) {
    expect(() => configRelais({ AUTO_SMTP_HOTE: "mail.example.com", AUTO_SMTP_PORT: port })).toThrow("AUTO_SMTP_PORT");
  }
  expect(() => configRelais({ AUTO_SMTP_EXPEDITEUR: "invalide" })).toThrow("adresse invalide");
  expect(() => configRelais({ AUTO_SMTP_HOTE: "mail.example.com", AUTO_SMTP_SECURITE: "invalide" })).toThrow(
    "AUTO_SMTP_SECURITE",
  );
});

test("SMTP : production exige un relais et TLS ; développement local permis", () => {
  expect(() => envoyeurDepuisEnv({ NODE_ENV: "production" })).toThrow("requis en production");
  expect(() =>
    configRelais({ NODE_ENV: "production", AUTO_SMTP_HOTE: "mail.example.com", AUTO_SMTP_SECURITE: "aucune" }),
  ).toThrow("TLS requis");
  expect(configRelais({ AUTO_SMTP_HOTE: "localhost", AUTO_SMTP_SECURITE: "aucune" }).smtp?.securite).toBe("aucune");
  expect(
    configRelais({ NODE_ENV: "production", AUTO_SMTP_HOTE: "mail.example.com", AUTO_SMTP_SECURITE: "starttls" }).smtp
      ?.port,
  ).toBe(587);
});
