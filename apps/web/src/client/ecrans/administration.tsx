import { useEffect, useState } from "react";
import { Bouton, Lien, useTitrePage } from "@auto/ui/react";
interface Agent {
  id: string;
  nom: string;
  actif: boolean;
  expire_at: string;
  dernier_acces: string | null;
}
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch("/v1/admin" + path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (r.status === 204) return null as T;
  const data = await r.json();
  if (!r.ok) throw Error(data.erreur ?? "Accès refusé");
  return data;
}
export function Administration() {
  useTitrePage("Administration Auto");
  const [agents, setAgents] = useState<Agent[]>([]),
    [erreur, setErreur] = useState(""),
    [token, setToken] = useState(""),
    [nom, setNom] = useState(""),
    [occupe, setOccupe] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let actif = true;
    Promise.all([api("/moi"), api<Agent[]>("/agents")])
      .then(([, a]) => {
        if (actif) setAgents(a);
      })
      .catch((e) => {
        if (actif) setErreur(e.message);
      });
    return () => {
      actif = false;
    };
  }, [revision]);
  async function agir(fn: () => Promise<void>) {
    setOccupe(true);
    setErreur("");
    try {
      await fn();
      setRevision((x) => x + 1);
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setOccupe(false);
    }
  }
  return (
    <main className="courrier-app">
      <header className="courrier-entete">
        <div>
          <Lien href="/app/courrier">← Ma boîte unifiée</Lien>
          <h1>Administration Auto</h1>
          <p>Compte super-administrateur et accès nominatifs des agents.</p>
        </div>
      </header>
      {erreur && <p role="alert">{erreur}</p>}
      <section className="courrier-lecture">
        <h2>Agents administrateurs</h2>
        <p>
          Chaque clé admin est révocable séparément, expire au bout d’un an et ne donne pas accès aux boîtes mail
          privées.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void agir(async () => {
              const a = await api<{ token: string }>("/agents", "POST", { nom });
              setToken(a.token);
              setNom("");
            });
          }}
        >
          <label>
            Nom de l’agent
            <input value={nom} onChange={(e) => setNom(e.target.value)} required maxLength={100} />
          </label>
          <Bouton type="submit" disabled={occupe || !nom.trim()}>
            Créer une clé agent
          </Bouton>
        </form>
        {token && (
          <div role="status">
            <label>
              Clé affichée une seule fois
              <input
                readOnly
                value={token}
                onFocus={(e) => e.currentTarget.select()}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <Bouton onClick={() => setToken("")}>Masquer la clé</Bouton>
          </div>
        )}
        <ul>
          {agents.map((a) => (
            <li key={a.id}>
              <strong>{a.nom}</strong> · {a.actif ? "Actif" : "Révoqué"} · Expire le{" "}
              {new Date(a.expire_at).toLocaleDateString("fr-FR")}{" "}
              {a.actif && (
                <Bouton disabled={occupe} onClick={() => agir(() => api(`/agents/${a.id}`, "DELETE"))}>
                  Révoquer
                </Bouton>
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
