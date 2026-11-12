import { expect, test } from "bun:test";
import {
  erreurApi,
  jetonValide,
  messageDepot,
  motifHote,
  nomFichier,
  normaliserInstance,
  texteBadge,
  typeFichier,
  urlDepot,
} from "./lib";

const octets = (s: string) => new TextEncoder().encode(s);

test("instance : origine seule, https exigé sauf localhost", () => {
  expect(normaliserInstance(" https://auto.aphrody.com/app/factures ")).toBe("https://auto.aphrody.com");
  expect(normaliserInstance("http://localhost:3001")).toBe("http://localhost:3001");
  expect(() => normaliserInstance("http://auto.exemple.fr")).toThrow("https");
  expect(() => normaliserInstance("pas une url")).toThrow("invalide");
  expect(motifHote("https://factures.fournisseur.fr/f/123.pdf")).toBe("https://factures.fournisseur.fr/*");
});

test("jeton API auto_", () => {
  expect(jetonValide("auto_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_")).toBe(true);
  expect(jetonValide("Bearer x")).toBe(false);
});

test("type du fichier lu dans les octets, pas dans l'en-tête", () => {
  expect(typeFichier(octets("%PDF-1.7\n..."))).toBe("application/pdf");
  expect(typeFichier(octets("﻿<?xml version='1.0'?><rsm:CrossIndustryInvoice/>"))).toBe("application/xml");
  expect(typeFichier(octets("<rsm:CrossIndustryInvoice xmlns:rsm='x'>"))).toBe("application/xml");
  expect(typeFichier(octets("<!doctype html><html>"))).toBeNull();
});

test("nom du fichier : Content-Disposition (RFC 5987), sinon URL, extension garantie", () => {
  const pdf = "application/pdf" as const;
  expect(nomFichier("https://x.fr/dl?id=1", "attachment; filename*=UTF-8''Facture%20n%C2%B07.pdf", pdf)).toBe(
    "Facture n°7.pdf",
  );
  expect(nomFichier("https://x.fr/dl", 'inline; filename="F-2026-0001.PDF"', pdf)).toBe("F-2026-0001.PDF");
  expect(nomFichier("https://x.fr/factures/F%2012", null, pdf)).toBe("F 12.pdf");
  expect(nomFichier("https://x.fr/", null, "application/xml")).toBe("facture.xml");
  expect(nomFichier("https://x.fr/a", 'attachment; filename="../../etc/passwd"', pdf)).toBe(".._.._etc_passwd.pdf");
  expect(urlDepot("https://auto.aphrody.com", "F 1.pdf")).toBe(
    "https://auto.aphrody.com/v1/factures-recues?nom=F%201.pdf",
  );
});

test("messages : dépôt, doublon, badge, erreurs de l'API", () => {
  const base = { id: "1", fournisseur: "Fournisseur SAS", numero: "F-12", ttcCents: 123456, anomalies: [] };
  const ok = messageDepot({ ...base, statut: "validee" }, "f.pdf");
  expect(ok.titre).toBe("Facture enregistrée");
  // Intl insère des espaces fines insécables : s les couvre.
  expect(ok.message).toMatch(/^Facture n° F-12 de Fournisseur SAS, 1\s234,56\s€ TTC lue et validée\.$/u);
  expect(messageDepot({ ...base, statut: "a_verifier", anomalies: ["a", "b"] }, "f.pdf").message).toContain(
    "2 point(s) à contrôler",
  );
  expect(messageDepot({ ...base, statut: "validee", doublon: true }, "f.pdf").titre).toBe("Déjà reçue");
  expect([0, 7, 150].map(texteBadge)).toEqual(["", "7", "99+"]);
  expect(erreurApi(401, null)).toContain("Jeton refusé");
  expect(erreurApi(415, { erreur: "Content-Type attendu", details: ["pdf"] })).toBe("Content-Type attendu (pdf)");
});
