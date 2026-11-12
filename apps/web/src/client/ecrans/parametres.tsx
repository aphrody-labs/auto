// Paramètres : entreprise, sécurité du compte, gabarit des documents, membres, clés d'API, abonnement.
import { contraste, graines } from "@auto/ui";

/** Fond des documents PDF : le texte en couleur d'accent y doit rester lisible (4,5:1). */
const PAPIER = "#FFFFFF";
import { CreditCard, ImageUp, Palette, ShieldCheck, Trash2 } from "@auto/ui/symboles";
import { useState, type FormEvent } from "react";
import { api, ErreurApi } from "@auto/client";
import { enBase64, eur, grouperSiret, nombre, octets } from "@auto/ui/format";
import { LIBELLE_ROLE, peut, useSession } from "../session";
import { Jetons, Membres } from "./equipe";
import { Securite } from "./securite";
import { PlateformeAgreee } from "./plateforme-agreee";
import {
  Bandeau,
  Bouton,
  ChampTexte,
  ChampZone,
  ChoixTheme,
  EtatChargement,
  EtatErreur,
  ResumeErreurs,
  useDonnees,
  useTitrePage,
  useToast,
} from "@auto/ui/react";

const HEX = /^#[0-9A-Fa-f]{6}$/;

const QUOTAS: Record<string, string> = {
  factures: "Factures émises ce mois",
  employes: "Employés actifs",
  stockage: "Stockage",
  appels_llm: "Appels d'agent ce mois",
  boites_mail: "Boîtes mail",
};

function Gabarit({ modifiable }: { modifiable: boolean }) {
  const toast = useToast();
  const g = useDonnees(() => api.gabarit());
  const [couleur, setCouleur] = useState<string | null>(null);
  const [pied, setPied] = useState<string | null>(null);
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState("");
  const [version, setVersion] = useState(0);

  if (g.etat === "chargement") return <EtatChargement lignes={3} />;
  if (g.etat === "erreur") return <EtatErreur message={g.erreur} onReessayer={g.recharger} />;
  const c = couleur ?? g.donnees.couleur ?? graines.marque;
  const p = pied ?? g.donnees.piedDePage ?? "";
  const errCouleur = HEX.test(c) ? null : "Couleur au format #RRGGBB, par exemple #0F6B5C.";
  const errPied = p.length > 200 ? `200 caractères au plus (${nombre(p.length)} saisis).` : null;
  const faible = !errCouleur && contraste(c, PAPIER) < 4.5;

  async function enregistrer(e: FormEvent) {
    e.preventDefault();
    if (errCouleur || errPied) return;
    setEnvoi("gabarit");
    setErreur(null);
    try {
      await api.enregistrerGabarit({ couleur: c, piedDePage: p.trim() || null });
      toast("Gabarit enregistré");
      g.recharger();
    } catch (x) {
      setErreur(x as ErreurApi);
    } finally {
      setEnvoi("");
    }
  }

  async function logo(f: File | undefined) {
    if (!f) return;
    setEnvoi("logo");
    setErreur(null);
    try {
      await api.envoyerLogo(enBase64(new Uint8Array(await f.arrayBuffer())));
      toast("Logo enregistré");
      setVersion((v) => v + 1);
      g.recharger();
    } catch (x) {
      setErreur(x as ErreurApi);
    } finally {
      setEnvoi("");
    }
  }

  return (
    <form className="grille" noValidate onSubmit={enregistrer}>
      <ResumeErreurs erreur={erreur} />
      <div className="grille grille-2">
        <div className="rangee rangee-bas">
          <div className="champ">
            <label htmlFor="couleur-pipette">Couleur d'accent</label>
            <input
              id="couleur-pipette"
              className="pipette"
              type="color"
              disabled={!modifiable}
              value={HEX.test(c) ? c : graines.marque}
              onChange={(e) => setCouleur(e.target.value)}
            />
          </div>
          <ChampTexte
            className="espace"
            libelle="Code couleur"
            value={c}
            disabled={!modifiable}
            erreur={errCouleur}
            aide={
              faible
                ? "Contraste faible sur fond blanc (moins de 4,5:1) : le texte en couleur sera peu lisible."
                : undefined
            }
            onChange={(e) => setCouleur(e.target.value)}
          />
        </div>
        <div className="champ">
          <span className="libelle-statique">Logo</span>
          <div className="rangee">
            {g.donnees.logo ? (
              <img className="apercu-logo" src={`${api.urlLogo()}?v=${version}`} alt="Logo actuel" />
            ) : (
              <span className="attenue">Aucun logo</span>
            )}
            {modifiable && (
              <>
                <label className="bouton" aria-busy={envoi === "logo" || undefined}>
                  <ImageUp className="icone" aria-hidden="true" />
                  {g.donnees.logo ? "Remplacer" : "Ajouter un logo"}
                  <input
                    className="visuellement-cache"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(e) => void logo(e.target.files?.[0])}
                  />
                </label>
                {g.donnees.logo && (
                  <Bouton
                    variante="fantome"
                    icone={Trash2}
                    aria-label="Supprimer le logo"
                    onClick={async () => {
                      await api.supprimerLogo().catch((x) => setErreur(x));
                      g.recharger();
                    }}
                  />
                )}
              </>
            )}
          </div>
          <span className="aide">PNG, JPEG ou WebP, 5 Mo au plus ; converti en JPEG pour le PDF/A.</span>
        </div>
      </div>
      <ChampZone
        libelle="Pied de page des documents"
        rows={2}
        disabled={!modifiable}
        value={p}
        erreur={errPied}
        aide="Par exemple : SAS au capital de 1 000 €, RCS Paris, IBAN FR76…"
        onChange={(e) => setPied(e.target.value)}
      />
      <div className="apercu-gabarit" style={{ borderTopColor: HEX.test(c) ? c : undefined }} aria-hidden="true">
        <strong style={{ color: HEX.test(c) ? c : undefined }}>FACTURE F-2026-0001</strong>
        <span className="petit">{p || "Pied de page"}</span>
      </div>
      {modifiable && (
        <div>
          <Bouton type="submit" variante="primaire" icone={Palette} chargement={envoi === "gabarit"}>
            Enregistrer le gabarit
          </Bouton>
        </div>
      )}
    </form>
  );
}

/** Paiement en ligne : clé Stripe de l'entreprise (les clients paient leurs factures par carte). */
function PaiementEnLigne({ modifiable }: { modifiable: boolean }) {
  const d = useDonnees(() => api.encaissement(), []);
  const [cle, setCle] = useState("");
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const toast = useToast();
  if (d.etat === "chargement") return <EtatChargement lignes={2} />;
  if (d.etat === "erreur") return <EtatErreur message={d.erreur} onReessayer={d.recharger} />;
  async function agir(f: () => Promise<unknown>, message: string) {
    setEnvoi(true);
    setErreur(null);
    try {
      await f();
      setCle("");
      toast(message);
      d.recharger();
    } catch (x) {
      setErreur(x as ErreurApi);
    } finally {
      setEnvoi(false);
    }
  }
  return (
    <div className="grille">
      <p>
        {d.donnees.actif
          ? `Actif : vos clients peuvent payer leurs factures par carte sur votre compte Stripe (clé ${d.donnees.apercu}).`
          : "Vos clients paient leurs factures par carte, directement sur votre compte Stripe. Collez une clé secrète Stripe (Développeurs, Clés API) ; elle est vérifiée puis chiffrée."}
      </p>
      <ResumeErreurs erreur={erreur} />
      {modifiable && (
        <form
          className="rangee rangee-bas"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void agir(() => api.enregistrerEncaissement(cle.trim()), "Paiement en ligne activé");
          }}
        >
          <ChampTexte
            className="espace"
            libelle={d.donnees.actif ? "Remplacer la clé Stripe" : "Clé secrète Stripe"}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk_live_…"
            value={cle}
            onChange={(e) => setCle(e.target.value)}
          />
          <Bouton type="submit" icone={CreditCard} chargement={envoi} disabled={!cle.trim()}>
            {d.donnees.actif ? "Remplacer" : "Activer"}
          </Bouton>
          {d.donnees.actif && (
            <Bouton
              variante="fantome"
              icone={Trash2}
              onClick={() => agir(() => api.supprimerEncaissement(), "Paiement en ligne désactivé")}
            >
              Désactiver
            </Bouton>
          )}
        </form>
      )}
    </div>
  );
}

function Abonnement({ modifiable }: { modifiable: boolean }) {
  const a = useDonnees(async () => {
    const [ab, plans] = await Promise.all([api.abonnement(), api.plans()]);
    return { ab, plans };
  });
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState("");
  if (a.etat === "chargement") return <EtatChargement lignes={2} />;
  if (a.etat === "erreur") return <EtatErreur message={a.erreur} onReessayer={a.recharger} />;
  const { ab, plans } = a.donnees;
  const plan = plans.find((p) => p.id === ab.planEffectif);
  const aller = async (nom: string, f: () => Promise<{ url: string }>) => {
    setEnvoi(nom);
    setErreur(null);
    try {
      location.assign((await f()).url);
    } catch (x) {
      setErreur(x as ErreurApi);
      setEnvoi("");
    }
  };
  return (
    <div className="grille">
      <ResumeErreurs erreur={erreur} />
      <p>
        Plan <strong>{plan?.nom ?? ab.planEffectif}</strong>
        {plan && plan.prixHtCents.mensuel > 0 && <> à {eur(plan.prixHtCents.mensuel)} HT par mois</>}, période{" "}
        {ab.periode}.
      </p>
      <dl className="resume-quotas">
        {ab.consommation
          .filter((c) => c.ressource in QUOTAS)
          .map((c) => (
            <div key={c.ressource} className="contents">
              <dt>{QUOTAS[c.ressource]}</dt>
              <dd className="chiffres">
                {c.ressource === "stockage" ? octets(c.utilise) : nombre(c.utilise)} sur{" "}
                {c.limite === null ? "illimité" : c.ressource === "stockage" ? octets(c.limite) : nombre(c.limite)}
              </dd>
            </div>
          ))}
      </dl>
      {modifiable && (
        <div className="rangee">
          {ab.planEffectif !== "pro" && ab.planEffectif !== "business" && (
            <Bouton
              variante="primaire"
              icone={CreditCard}
              chargement={envoi === "pro"}
              onClick={() => aller("pro", () => api.checkout("pro"))}
            >
              Essayer Pro 30 jours
            </Bouton>
          )}
          {ab.planEffectif !== "business" && (
            <Bouton
              icone={CreditCard}
              chargement={envoi === "business"}
              onClick={() => aller("business", () => api.checkout("business"))}
            >
              Passer à Business
            </Bouton>
          )}
          {ab.planEffectif !== "gratuit" && (
            <Bouton chargement={envoi === "portail"} onClick={() => aller("portail", () => api.portail())}>
              Gérer l'abonnement
            </Bouton>
          )}
        </div>
      )}
    </div>
  );
}

export function Parametres() {
  useTitrePage("Paramètres");
  const { moi } = useSession();
  const reglages = peut(moi.role, "parametres");
  const membres = peut(moi.role, "membres");
  const e = moi.entreprise;
  const audit = useDonnees(() => api.verifierAudit());

  return (
    <div className="page">
      <div className="page-entete">
        <h1>Paramètres</h1>
      </div>

      <section className="carte resume" aria-labelledby="sec-entreprise">
        <h2 id="sec-entreprise">Entreprise</h2>
        <dl>
          <dt>Raison sociale</dt>
          <dd>{e.nom}</dd>
          <dt>SIRET</dt>
          <dd className="chiffres">{grouperSiret(e.siret)}</dd>
          <dt>TVA intracommunautaire</dt>
          <dd className="chiffres">{e.tvaIntracom ?? "—"}</dd>
          <dt>Adresse</dt>
          <dd>{e.adresse}</dd>
          <dt>Régime de TVA</dt>
          <dd>{e.franchiseTva ? "Franchise en base (art. 293 B du CGI)" : "Assujetti"}</dd>
          <dt>Votre rôle</dt>
          <dd>{LIBELLE_ROLE[moi.role]}</dd>
        </dl>
      </section>

      <section className="carte pile-serree" aria-labelledby="sec-affichage">
        <h2 id="sec-affichage">Affichage</h2>
        <ChoixTheme />
      </section>

      <section className="carte pile-serree" aria-labelledby="sec-gabarit">
        <h2 id="sec-gabarit">Gabarit des documents</h2>
        <Gabarit modifiable={reglages} />
      </section>

      <section className="carte pile-serree" aria-labelledby="sec-securite">
        <h2 id="sec-securite">Sécurité</h2>
        <Securite />
      </section>

      {membres && (
        <section className="carte pile-serree" aria-labelledby="sec-membres">
          <h2 id="sec-membres">Membres</h2>
          <Membres />
        </section>
      )}

      {reglages && (
        <section className="carte pile-serree" aria-labelledby="sec-jetons">
          <h2 id="sec-jetons">Clés d'API</h2>
          <Jetons />
        </section>
      )}

      <section className="carte pile-serree" aria-labelledby="sec-plateforme">
        <h2 id="sec-plateforme">Plateforme de facturation électronique</h2>
        <PlateformeAgreee modifiable={reglages} />
      </section>

      <section className="carte pile-serree" aria-labelledby="sec-paiement-en-ligne">
        <h2 id="sec-paiement-en-ligne">Paiement en ligne</h2>
        <PaiementEnLigne modifiable={reglages} />
      </section>

      <section className="carte pile-serree" aria-labelledby="sec-abonnement">
        <h2 id="sec-abonnement">Abonnement</h2>
        <Abonnement modifiable={reglages} />
      </section>

      <section className="carte pile-serree" aria-labelledby="sec-audit">
        <h2 id="sec-audit">Journal d'audit</h2>
        {audit.etat === "chargement" && <EtatChargement lignes={1} />}
        {audit.etat === "erreur" && <EtatErreur message={audit.erreur} onReessayer={audit.recharger} />}
        {audit.etat === "ok" && (
          <Bandeau
            ton={audit.donnees.ok ? "succes" : "erreur"}
            titre={audit.donnees.ok ? "Chaîne d'audit intègre" : "Chaîne d'audit rompue"}
          >
            <p>
              <ShieldCheck className="icone icone-sm" aria-hidden="true" /> {nombre(audit.donnees.entrees)} entrées
              vérifiées.
            </p>
          </Bandeau>
        )}
      </section>
    </div>
  );
}
