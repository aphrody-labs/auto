// Comptes de contrôle réservés, sans facture émise. Identifiants écrits uniquement dans un fichier privé.
const [origine, destination] = Bun.argv.slice(2);
if (!origine || !["https://auto.aphrody.com", "https://recette-auto.aphrody.com"].includes(origine) || !destination)
  throw new Error("Usage : origine Auto autorisée et destination privée");
const existant = Bun.file(destination);
if (await existant.exists()) {
  const c = await existant.json();
  if (c.url !== origine) throw new Error("Le fichier appartient à une autre instance");
  if ((await fetch(`${origine}/v1/moi`, { headers: { authorization: `Bearer ${c.session}` } })).ok) {
    console.log("Compte de contrôle existant, session valide");
    process.exit(0);
  }
  throw new Error("Session du compte de contrôle expirée : renouvellement explicite requis");
}
const email = `qa-auto-${crypto.randomUUID()}@example.test`;
const motDePasse = crypto.getRandomValues(new Uint8Array(24)).toHex();
const r = await fetch(`${origine}/v1/auth/inscription`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email,
    motDePasse,
    entreprise: {
      nom: "QA Auto — contrôle de déploiement",
      siret: "73282932000074",
      adresse: "1 rue de la Recette, Lyon",
    },
  }),
});
if (r.status !== 201) throw new Error(`Inscription de contrôle refusée : ${r.status}`);
const b = (await r.json()) as { session: string; tenantId: string };
if (!b.session || !b.tenantId) throw new Error("Réponse d'inscription incomplète");
const cookies = r.headers.getSetCookie().map((c) => {
  const kv = c.split(";")[0]!,
    i = kv.indexOf("=");
  return { name: kv.slice(0, i), value: kv.slice(i + 1), url: origine, httpOnly: true, secure: true, sameSite: "Lax" };
});
await Bun.write(
  destination,
  `${JSON.stringify({ url: origine, email, motDePasse, ...b, cookies, creeLe: new Date().toISOString() }, null, 2)}\n`,
  { mode: 0o600 },
);
console.log("Compte de contrôle créé ; identifiants conservés dans le fichier privé, aucun document émis");
export {};
