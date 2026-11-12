import { expect, spyOn, test } from "bun:test";
import { baseDistributions, catalogue, comparerVersions, routesDistributions } from "./distributions";

test("mises à jour : comparaison numérique stricte, aucune régression ni préversion implicite", () => {
  expect(comparerVersions("0.10.0", "0.2.0")).toBe(1);
  expect(comparerVersions("0.2.0", "0.2.0")).toBe(0);
  expect(comparerVersions("0.2.0", "1.0.0")).toBe(-1);
  expect(comparerVersions("0.2.0-beta", "0.1.0")).toBeNull();
  expect(comparerVersions("01.2.0", "0.1.0")).toBeNull();
});

test("stockage objet : manifeste validé, téléchargement autorisé et taille contrôlée", async () => {
  const ancienne = Bun.env.AUTO_DISTRIBUTIONS_OBJETS_URL;
  Bun.env.AUTO_DISTRIBUTIONS_OBJETS_URL = "https://storage.example/auto/releases";
  const manifest = {
    schema: 1,
    version: "1.0.0",
    date: "2026-01-01T00:00:00Z",
    notes: "",
    fichiers: [
      {
        id: "linux",
        plateforme: "linux",
        architecture: "x64",
        type: "autonome",
        fichier: "auto.tar.gz",
        nom: "Linux",
        octets: 4,
        sha256: "a".repeat(64),
      },
    ],
  };
  let taille = "4";
  const remplacement = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/manifest.json")) return Response.json(manifest);
      if (url.endsWith("/auto.tar.gz") && init?.method === "HEAD")
        return new Response(null, { headers: { "content-length": taille } });
      throw new Error(`requête inattendue : ${url}`);
    },
    { preconnect: fetch.preconnect },
  );
  const mock = spyOn(globalThis, "fetch").mockImplementation(remplacement);
  try {
    expect(baseDistributions()?.href).toBe("https://storage.example/auto/releases/");
    expect((await catalogue())?.version).toBe("1.0.0");
    const route = routesDistributions()["/downloads/:fichier"];
    const req = Object.assign(new Request("https://auto.test/downloads/auto.tar.gz"), {
      params: { fichier: "auto.tar.gz" },
    });
    const r = await route(req);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://storage.example/auto/releases/auto.tar.gz");
    taille = "3";
    expect((await route(req)).status).toBe(503);
    manifest.fichiers[0]!.fichier = "../secret";
    expect(await catalogue()).toBeNull();
    expect(baseDistributions("http://storage.example/")).toBeNull();
    expect(baseDistributions("https://user:secret@storage.example/")).toBeNull();
  } finally {
    mock.mockRestore();
    if (ancienne === undefined) delete Bun.env.AUTO_DISTRIBUTIONS_OBJETS_URL;
    else Bun.env.AUTO_DISTRIBUTIONS_OBJETS_URL = ancienne;
  }
});

test("catalogue : refuse chemins sortants et installeurs sans signature", async () => {
  const dir = `${Bun.env.TEMP ?? "/tmp"}/auto-catalogue-${crypto.randomUUID()}`;
  const chemin = `${dir}/manifest.json`;
  const c = {
    schema: 1,
    version: "0.2.0",
    date: new Date().toISOString(),
    notes: "Contrôle",
    fichiers: [
      {
        id: "windows",
        plateforme: "windows",
        architecture: "x86_64",
        type: "installateur",
        fichier: "auto-0.2.0.exe",
        nom: "Windows",
        octets: 10,
        sha256: "a".repeat(64),
        cibleUpdater: "windows-x86_64",
        signature: "signature",
      },
    ],
  };
  try {
    await Bun.write(chemin, JSON.stringify(c));
    expect((await catalogue(dir))?.fichiers).toHaveLength(1);
    c.fichiers[0]!.fichier = "../secret";
    await Bun.write(chemin, JSON.stringify(c));
    expect(await catalogue(dir)).toBeNull();
    c.fichiers[0]!.fichier = "auto-0.2.0.exe";
    c.fichiers[0]!.signature = "";
    await Bun.write(chemin, JSON.stringify(c));
    expect(await catalogue(dir)).toBeNull();
  } finally {
    await Bun.file(chemin).delete();
    const { rmdir } = await import("node:fs/promises");
    await rmdir(dir);
  }
});
