// Paramètres, équipe : membres et rôles, invitations par mail, clés d'API de l'entreprise.
import { Copy, KeyRound, Send, Trash2, UserPlus } from "@auto/ui/symboles";
import { useState, type FormEvent } from "react";
import { PermissionsMembres } from "./arrivages";
import { api, ErreurApi, type Role } from "@auto/client";
import { ROLES } from "@auto/tenancy/droits";
import { emailValide } from "@auto/ui/format";
import {
  Bandeau,
  BadgeStatut,
  Bouton,
  ChampListe,
  ChampTexte,
  EtatChargement,
  EtatErreur,
  ResumeErreurs,
  useDonnees,
  useToast,
} from "@auto/ui/react";
import { authClient, messageAuth } from "../auth";
import { LIBELLE_ROLE, useSession } from "../session";

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("fr-FR") : "—");

function ChoixRole({
  value,
  onChange,
  libelle = "Rôle",
}: {
  value: Role;
  onChange: (r: Role) => void;
  libelle?: string;
}) {
  const { moi } = useSession();
  return (
    <ChampListe libelle={libelle} value={value} onChange={(e) => onChange(e.target.value as Role)}>
      {ROLES.filter((r) => r !== "owner" || moi.role === "owner").map((r) => (
        <option key={r} value={r}>
          {LIBELLE_ROLE[r]}
        </option>
      ))}
    </ChampListe>
  );
}

const STATUTS = { en_attente: "En attente", acceptee: "Acceptée", revoquee: "Révoquée", expiree: "Expirée" };
const VISUEL = { en_attente: "envoye", acceptee: "accepte", revoquee: "annule", expiree: "en_retard" } as const;

export function Membres() {
  const toast = useToast();
  const { moi } = useSession();
  const membres = useDonnees(() => api.membres());
  const invitations = useDonnees(() => api.invitations());
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("comptable");
  const [errEmail, setErrEmail] = useState<string | null>(null);
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);

  async function inviter(e: FormEvent) {
    e.preventDefault();
    if (!emailValide(email)) return setErrEmail("Adresse e-mail invalide.");
    setErrEmail(null);
    setEnvoi(true);
    setErreur(null);
    try {
      await api.inviter(email.trim(), role);
      toast(`Invitation envoyée à ${email.trim()} (${LIBELLE_ROLE[role]})`);
      setEmail("");
      invitations.recharger();
    } catch (x) {
      setErreur(x as ErreurApi);
    } finally {
      setEnvoi(false);
    }
  }

  async function changerRole(memberId: string, r: Role) {
    setErreur(null);
    const { error } = await authClient.organization.updateMemberRole({
      memberId,
      role: r,
      organizationId: moi.tenantId,
    });
    if (error) return setErreur(new ErreurApi(messageAuth(error), error.status ?? 400));
    toast(`Rôle changé : ${LIBELLE_ROLE[r]}`);
    membres.recharger();
  }

  async function agir(f: () => Promise<unknown>, message: string, apres: () => void) {
    setErreur(null);
    try {
      await f();
      toast(message);
      apres();
    } catch (x) {
      setErreur(x as ErreurApi);
    }
  }

  return (
    <div className="grille">
      <p>
        Invitez vos employés dans <strong>{moi.entreprise.nom}</strong>. Chacun garde son compte, son rôle et ses
        sessions ; les documents autorisés restent partagés dans cette entreprise.
      </p>
      <ResumeErreurs erreur={erreur} />
      {membres.etat === "chargement" && <EtatChargement lignes={2} />}
      {membres.etat === "erreur" && <EtatErreur message={membres.erreur} onReessayer={membres.recharger} />}
      {membres.etat === "ok" && (
        <table className="tableau">
          <caption className="visuellement-cache">Membres de l'entreprise</caption>
          <thead>
            <tr>
              <th scope="col">Membre</th>
              <th scope="col">Rôle</th>
              <th scope="col">Depuis</th>
              <th scope="col">
                <span className="visuellement-cache">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {membres.donnees.map((m) => (
              <tr key={m.id}>
                <td>
                  <strong>{m.nom}</strong>
                  <br />
                  <span className="attenue">{m.email}</span>
                </td>
                <td>
                  {m.userId === moi.userId || (m.role === "owner" && moi.role !== "owner") ? (
                    LIBELLE_ROLE[m.role]
                  ) : (
                    <ChoixRole libelle={`Rôle de ${m.email}`} value={m.role} onChange={(r) => changerRole(m.id, r)} />
                  )}
                </td>
                <td>{date(m.depuis)}</td>
                <td>
                  {m.userId !== moi.userId && (
                    <Bouton
                      variante="fantome"
                      icone={Trash2}
                      aria-label={`Retirer ${m.email}`}
                      onClick={() => agir(() => api.retirerMembre(m.id), `${m.email} retiré`, membres.recharger)}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {membres.etat === "ok" && <PermissionsMembres membres={membres.donnees} />}
      <form className="grille" noValidate onSubmit={inviter}>
        <h3>Inviter un membre</h3>
        <div className="grille grille-3 rangee-bas">
          <ChampTexte
            libelle="E-mail"
            type="email"
            value={email}
            erreur={errEmail}
            onChange={(e) => setEmail(e.target.value)}
          />
          <ChoixRole value={role} onChange={setRole} />
          <div>
            <Bouton type="submit" icone={UserPlus} chargement={envoi}>
              Inviter
            </Bouton>
          </div>
        </div>
        <p className="attenue petit">Lien à usage unique valable 7 jours, envoyé par e-mail.</p>
      </form>

      {invitations.etat === "ok" && invitations.donnees.length > 0 && (
        <table className="tableau">
          <caption>Invitations</caption>
          <thead>
            <tr>
              <th scope="col">E-mail</th>
              <th scope="col">Rôle</th>
              <th scope="col">Statut</th>
              <th scope="col">Expire le</th>
              <th scope="col">
                <span className="visuellement-cache">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {invitations.donnees.map((i) => (
              <tr key={i.id}>
                <td>{i.email}</td>
                <td>{LIBELLE_ROLE[i.role]}</td>
                <td>
                  <BadgeStatut statut={VISUEL[i.statut]} libelle={STATUTS[i.statut]} />
                </td>
                <td>{date(i.expiresAt)}</td>
                <td>
                  {i.statut === "en_attente" && (
                    <div className="rangee">
                      <Bouton
                        variante="fantome"
                        icone={Send}
                        aria-label={`Renvoyer l'invitation à ${i.email}`}
                        onClick={() =>
                          agir(() => api.inviter(i.email, i.role), "Invitation renvoyée", invitations.recharger)
                        }
                      />
                      <Bouton
                        variante="fantome"
                        icone={Trash2}
                        aria-label={`Révoquer l'invitation de ${i.email}`}
                        onClick={() =>
                          agir(() => api.revoquerInvitation(i.id), "Invitation révoquée", invitations.recharger)
                        }
                      />
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function Jetons() {
  const [nom, setNom] = useState("");
  const [jours, setJours] = useState("");
  const [jeton, setJeton] = useState<string | null>(null);
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const cles = useDonnees(() => api.jetons());
  const toast = useToast();
  return (
    <div className="grille">
      <form
        className="grille"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setEnvoi(true);
          setErreur(null);
          try {
            setJeton((await api.creerJeton(nom.trim() || "api", Number(jours) || undefined)).jeton);
            setNom("");
            cles.recharger();
          } catch (x) {
            setErreur(x as ErreurApi);
          } finally {
            setEnvoi(false);
          }
        }}
      >
        <ResumeErreurs erreur={erreur} />
        <div className="rangee rangee-bas">
          <ChampTexte
            className="espace"
            libelle="Nom de la clé"
            placeholder="n8n, comptable, script…"
            value={nom}
            onChange={(e) => setNom(e.target.value)}
          />
          <ChampTexte
            libelle="Expire dans (jours)"
            inputMode="numeric"
            placeholder="jamais"
            value={jours}
            onChange={(e) => setJours(e.target.value.replace(/\D/g, ""))}
          />
          <Bouton type="submit" icone={KeyRound} chargement={envoi}>
            Créer une clé
          </Bouton>
        </div>
        {jeton && (
          <Bandeau ton="avertissement" titre="Copiez cette clé maintenant : elle ne sera plus affichée">
            <p className="jeton">{jeton}</p>
            <Bouton
              icone={Copy}
              onClick={async () => {
                await navigator.clipboard?.writeText(jeton);
                toast("Clé copiée");
              }}
            >
              Copier
            </Bouton>
          </Bandeau>
        )}
        <p className="attenue petit">
          En-tête <code>Authorization: Bearer auto_…</code> (ou <code>x-api-key</code>) sur l'API <code>/v1</code>, avec
          les droits actuels de votre rôle.
        </p>
      </form>
      {cles.etat === "ok" && cles.donnees.length > 0 && (
        <table className="tableau">
          <caption>Clés de l'entreprise</caption>
          <thead>
            <tr>
              <th scope="col">Nom</th>
              <th scope="col">Créée par</th>
              <th scope="col">Créée le</th>
              <th scope="col">Dernier usage</th>
              <th scope="col">Expire le</th>
              <th scope="col">
                <span className="visuellement-cache">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {cles.donnees.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.nom ?? "—"} {c.debut && <code className="attenue">{c.debut}…</code>}
                </td>
                <td>{c.email ?? "—"}</td>
                <td>{date(c.creeLe)}</td>
                <td>{date(c.dernierUsage)}</td>
                <td>{date(c.expireLe)}</td>
                <td>
                  <Bouton
                    variante="fantome"
                    icone={Trash2}
                    aria-label={`Révoquer la clé ${c.nom ?? c.id}`}
                    onClick={async () => {
                      try {
                        await api.revoquerJeton(c.id);
                        toast("Clé révoquée");
                        cles.recharger();
                      } catch (x) {
                        setErreur(x as ErreurApi);
                      }
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
