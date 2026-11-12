// Consentement OAuth d'un client MCP (Claude Code, Claude Desktop…) : nom du client, accès demandés, choix de
// l'entreprise à laquelle le jeton sera lié, puis accord ou refus. La requête signée de /oauth2/authorize est
// relayée par le client Better Auth (oauthProviderClient).
import { Check, ShieldCheck, X } from "@auto/ui/symboles";
import { useEffect, useState } from "react";
import { api, ErreurApi, type Moi } from "@auto/client";
import { Bandeau, Bouton, ChampListe, EtatChargement, ResumeErreurs, parametre, useTitrePage } from "@auto/ui/react";
import { authClient, messageAuth, suivreRedirection } from "../auth";
import { Marque } from "./marque";

const PORTEES: Record<string, string> = {
  openid: "Vous identifier",
  profile: "Lire votre nom",
  email: "Lire votre adresse e-mail",
  offline_access: "Rester connecté (jeton de rafraîchissement)",
};

export function Autorisation() {
  useTitrePage("Autoriser une application");
  const clientId = parametre("client_id") ?? "";
  const portees = (parametre("scope") ?? "").split(" ").filter(Boolean);
  const [client, setClient] = useState<{ client_name?: string; client_uri?: string } | null>(null);
  const [moi, setMoi] = useState<Moi | null>(null);
  const [tenant, setTenant] = useState("");
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState<"oui" | "non" | null>(null);

  useEffect(() => {
    fetch(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : {}))
      .then(setClient)
      .catch(() => setClient({}));
    api
      .moi()
      .then((m) => {
        setMoi(m);
        setTenant(m.tenantId);
      })
      .catch((e) => setErreur(e as ErreurApi));
  }, [clientId]);

  async function repondre(accept: boolean) {
    setEnvoi(accept ? "oui" : "non");
    setErreur(null);
    try {
      if (accept && moi && tenant !== moi.tenantId) await authClient.organization.setActive({ organizationId: tenant });
      const consent = await authClient.$fetch("/oauth2/consent", { method: "POST", body: { accept } });
      if (!consent.error && suivreRedirection(consent.data)) return;
      // Étape « après connexion » (entreprise choisie) : reprise de l'autorisation.
      const suite = await authClient.$fetch("/oauth2/continue", { method: "POST", body: { postLogin: true } });
      if (!suite.error && suivreRedirection(suite.data)) return;
      const e = (consent.error ?? suite.error) as { code?: string; message?: string; status?: number } | null;
      setErreur(new ErreurApi(messageAuth(e) || "Autorisation impossible.", e?.status ?? 400));
    } finally {
      setEnvoi(null);
    }
  }

  const nom = client?.client_name || clientId;
  return (
    <main className="auth" id="contenu">
      <div className="fond-motif pattern-dots-md" aria-hidden="true" />
      <div className="auth-carte carte">
        <Marque />
        <h1>Autoriser {nom}</h1>
        {!client || !moi ? (
          erreur ? (
            <ResumeErreurs erreur={erreur} />
          ) : (
            <EtatChargement libelle="Lecture de la demande" />
          )
        ) : (
          <div className="grille">
            <ResumeErreurs erreur={erreur} />
            <Bandeau ton="info" titre="Accès aux outils d'auto (MCP)">
              <p>
                {nom} pourra utiliser les outils d'auto (devis, factures, paiements, relances, absences…) avec vos
                droits dans l'entreprise choisie, comme vous le feriez depuis l'application.
              </p>
            </Bandeau>
            {portees.length > 0 && (
              <ul>
                {portees.map((p) => (
                  <li key={p}>{PORTEES[p] ?? p}</li>
                ))}
              </ul>
            )}
            <ChampListe libelle="Entreprise" value={tenant} onChange={(e) => setTenant(e.target.value)}>
              {moi.entreprises.map((e) => (
                <option key={e.id} value={e.id} disabled={e.suspendue}>
                  {e.nom} ({e.role})
                </option>
              ))}
            </ChampListe>
            <div className="grille grille-2">
              <Bouton icone={X} chargement={envoi === "non"} onClick={() => repondre(false)}>
                Refuser
              </Bouton>
              <Bouton variante="primaire" icone={Check} chargement={envoi === "oui"} onClick={() => repondre(true)}>
                Autoriser
              </Bouton>
            </div>
            <p className="attenue petit">
              <ShieldCheck className="icone" aria-hidden="true" /> Révocable à tout moment dans Paramètres, Sécurité.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
