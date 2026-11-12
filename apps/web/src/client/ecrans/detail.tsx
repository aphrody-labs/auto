// Fiche d'un document : lecture, émission, PDF et Factur-X, statut, paiements, relances, conversion et avoir.
import { htLigne, type Statut } from "@auto/domain";
import {
  Banknote,
  BellRing,
  Copy,
  CreditCard,
  FileCheck,
  FileCode2,
  FileDown,
  FileOutput,
  Pencil,
  Send,
  Trash2,
  Undo2,
} from "@auto/ui/symboles";
import { useState, type FormEvent } from "react";
import { api, ErreurApi, type DocumentApi } from "@auto/client";
import {
  aujourdhui,
  dateFr,
  estFactureVente,
  eur,
  LIBELLE_MODE,
  LIBELLE_TYPE,
  libelleStatut,
  nombre,
  pourcentDepuisBp,
  statutVisuel,
  tauxTva,
  versCentimes,
} from "@auto/ui/format";
import { peut, useSession } from "../session";
import { AffectationDocument } from "./affectations";
import {
  BadgeStatut,
  Bandeau,
  Bouton,
  ChampListe,
  ChampTexte,
  EtatChargement,
  EtatErreur,
  EtatVide,
  Lien,
  Modale,
  ResumeErreurs,
  naviguer,
  useDonnees,
  useTitrePage,
  useToast,
} from "@auto/ui/react";

const SUIVANTS: Partial<Record<Statut, Statut[]>> = {
  emis: ["envoye", "accepte", "refuse", "annule"],
  envoye: ["accepte", "refuse", "annule"],
  depose: ["rejete"],
  rejete: ["depose"],
};

const ACTION_STATUT: Partial<Record<Statut, string>> = {
  envoye: "Marquer envoyé",
  accepte: "Marquer accepté",
  refuse: "Marquer refusé",
  annule: "Annuler",
  depose: "Marquer déposé",
  rejete: "Marquer rejeté",
};

export function DetailDocument({ id }: { id: string }) {
  const d = useDonnees(() => api.document(id), [id]);
  useTitrePage(d.etat === "ok" ? `${LIBELLE_TYPE[d.donnees.type]} ${d.donnees.numero ?? "brouillon"}` : "Document");
  if (d.etat === "chargement")
    return (
      <div className="page">
        <EtatChargement />
      </div>
    );
  if (d.etat === "erreur")
    return (
      <div className="page">
        <h1>Document</h1>
        {/introuvable/i.test(d.erreur) ? (
          <EtatVide titre="Document introuvable">
            <p>Il a peut-être été supprimé, ou il appartient à un autre compte.</p>
            <Lien className="bouton" href="/app/factures">
              Retour aux factures
            </Lien>
          </EtatVide>
        ) : (
          <EtatErreur message={d.erreur} onReessayer={d.recharger} />
        )}
      </div>
    );
  return <Fiche doc={d.donnees} recharger={d.recharger} />;
}

function Fiche({ doc, recharger }: { doc: DocumentApi; recharger: () => void }) {
  const { moi } = useSession();
  const toast = useToast();
  const ecrire = peut(moi.role, "ecrire");
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [action, setAction] = useState("");
  const [confirmer, setConfirmer] = useState(false);
  const [lien, setLien] = useState<{ url: string; expire: string } | null>(null);
  const s = statutVisuel(doc, aujourdhui());
  const brouillon = doc.statut === "brouillon";
  const vente = estFactureVente(doc.type);
  const d = doc.data;

  async function faire(nom: string, f: () => Promise<unknown>, message: string) {
    setAction(nom);
    setErreur(null);
    try {
      await f();
      toast(message);
      recharger();
    } catch (x) {
      setErreur(x as ErreurApi);
    } finally {
      setAction("");
    }
  }

  async function partager() {
    setAction("partager");
    setErreur(null);
    try {
      const l = doc.type === "devis" ? await api.lienPublic(doc.id) : await api.lienPaiement(doc.id);
      setLien(l);
      await navigator.clipboard?.writeText(l.url).then(
        () => toast(doc.type === "devis" ? "Lien du devis copié" : "Lien de paiement copié"),
        () => toast(doc.type === "devis" ? "Lien du devis créé" : "Lien de paiement créé"),
      );
    } catch (x) {
      setErreur(x as ErreurApi);
    } finally {
      setAction("");
    }
  }

  return (
    <div className="page">
      <p className="fil">
        <Lien href={doc.type === "devis" ? "/app/devis" : doc.type === "avoir" ? "/app/avoirs" : "/app/factures"}>
          {doc.type === "devis" ? "Devis" : doc.type === "avoir" ? "Avoirs" : "Factures"}
        </Lien>
      </p>
      <div className="page-entete">
        <h1>
          {LIBELLE_TYPE[doc.type]} <span className="chiffres">{doc.numero ?? "(brouillon)"}</span>
        </h1>
        <BadgeStatut statut={s} libelle={libelleStatut(s, doc.type)} />
      </div>

      <ResumeErreurs erreur={erreur} />
      <AffectationDocument id={doc.id} clientId={doc.clientId} />
      {lien && (
        <Bandeau ton="info" titre={doc.type === "devis" ? "Lien du devis" : "Lien de paiement"}>
          <p>
            {doc.type === "devis"
              ? "Votre client peut consulter le devis, télécharger le PDF et l'accepter ou le refuser en ligne"
              : "Votre client peut consulter la facture, télécharger le Factur-X et la payer par carte"}{" "}
            jusqu'au {dateFr(lien.expire.slice(0, 10))} :
          </p>
          <p className="lien-partage">
            <a href={lien.url} target="_blank" rel="noopener">
              {lien.url}
            </a>
          </p>
        </Bandeau>
      )}

      <div className="rangee" role="toolbar" aria-label="Actions du document">
        {brouillon && ecrire && (
          <>
            <Bouton
              variante="primaire"
              icone={FileCheck}
              chargement={action === "emettre"}
              onClick={() =>
                faire(
                  "emettre",
                  () => api.emettre(doc.id),
                  `${LIBELLE_TYPE[doc.type]} émis${doc.type === "facture" ? "e" : ""}`,
                )
              }
            >
              Émettre
            </Bouton>
            <Lien className="bouton" href={`/app/documents/${doc.id}/modifier`}>
              <Pencil className="icone" aria-hidden="true" />
              Modifier
            </Lien>
          </>
        )}
        <a className="bouton" href={api.url(`/v1/documents/${doc.id}/pdf`)} target="_blank" rel="noopener">
          <FileDown className="icone" aria-hidden="true" />
          {brouillon ? "Aperçu PDF" : "PDF"}
          <span className="visuellement-cache"> (nouvel onglet)</span>
        </a>
        {!brouillon && doc.type !== "devis" && (
          <a className="bouton" href={api.url(`/v1/documents/${doc.id}/xml`)} target="_blank" rel="noopener">
            <FileCode2 className="icone" aria-hidden="true" />
            XML Factur-X
            <span className="visuellement-cache"> (nouvel onglet)</span>
          </a>
        )}
        {ecrire &&
          doc.type === "devis" &&
          (doc.statut === "accepte" || doc.statut === "emis" || doc.statut === "envoye") && (
            <Lien className="bouton" href={`/app/documents/nouveau?depuis=${doc.id}&vers=facture`}>
              <FileOutput className="icone" aria-hidden="true" />
              Convertir en facture
            </Lien>
          )}
        {ecrire && doc.type === "devis" && (doc.statut === "emis" || doc.statut === "envoye") && (
          <Bouton icone={Copy} chargement={action === "partager"} onClick={partager}>
            Partager le lien
          </Bouton>
        )}
        {ecrire && vente && ["emis", "envoye", "depose"].includes(doc.statut) && (
          <Bouton icone={CreditCard} chargement={action === "partager"} onClick={partager}>
            Lien de paiement
          </Bouton>
        )}
        {ecrire && vente && !brouillon && doc.statut !== "annule" && (
          <Lien className="bouton" href={`/app/documents/nouveau?depuis=${doc.id}&vers=avoir`}>
            <Undo2 className="icone" aria-hidden="true" />
            Créer un avoir
          </Lien>
        )}
        {ecrire &&
          (SUIVANTS[doc.statut] ?? [])
            .filter((x) => doc.type === "devis" || (x !== "accepte" && x !== "refuse"))
            .map((x) => (
              <Bouton
                key={x}
                variante={x === "annule" || x === "refuse" ? "fantome" : "secondaire"}
                icone={x === "envoye" ? Send : undefined}
                chargement={action === x}
                onClick={() => faire(x, () => api.changerStatut(doc.id, x), `Statut : ${libelleStatut(x, doc.type)}`)}
              >
                {ACTION_STATUT[x]}
              </Bouton>
            ))}
        {brouillon && ecrire && (
          <Bouton variante="danger" icone={Trash2} onClick={() => setConfirmer(true)}>
            Supprimer
          </Bouton>
        )}
      </div>

      <Modale
        ouverte={confirmer}
        titre="Supprimer le brouillon ?"
        onFermer={() => setConfirmer(false)}
        pied={
          <>
            <Bouton onClick={() => setConfirmer(false)}>Conserver</Bouton>
            <Bouton
              variante="danger"
              icone={Trash2}
              chargement={action === "supprimer"}
              onClick={async () => {
                setAction("supprimer");
                try {
                  await api.supprimerDocument(doc.id);
                  toast("Brouillon supprimé");
                  naviguer(doc.type === "devis" ? "/app/devis" : "/app/factures", true);
                } catch (x) {
                  setErreur(x as ErreurApi);
                  setConfirmer(false);
                } finally {
                  setAction("");
                }
              }}
            >
              Supprimer
            </Bouton>
          </>
        }
      >
        <p>Le brouillon est supprimé définitivement. Un document émis, lui, ne se supprime jamais.</p>
      </Modale>

      <div className="grille grille-2">
        <section className="carte resume" aria-labelledby="sec-client">
          <h2 id="sec-client">Client</h2>
          <dl>
            <dt>Nom</dt>
            <dd>{d.client.nom}</dd>
            <dt>Adresse</dt>
            <dd>{d.client.adresse}</dd>
            {d.client.siret && (
              <>
                <dt>SIRET</dt>
                <dd className="chiffres">{d.client.siret}</dd>
              </>
            )}
            {d.client.email && (
              <>
                <dt>E-mail</dt>
                <dd>{d.client.email}</dd>
              </>
            )}
          </dl>
        </section>
        <section className="carte resume" aria-labelledby="sec-dates">
          <h2 id="sec-dates">Dates et conditions</h2>
          <dl>
            <dt>Date</dt>
            <dd className="chiffres">{dateFr(d.date)}</dd>
            {d.echeance && (
              <>
                <dt>Échéance</dt>
                <dd className={`chiffres ${s === "en_retard" ? "texte-danger" : ""}`}>{dateFr(d.echeance)}</dd>
              </>
            )}
            {d.datePrestation && (
              <>
                <dt>Prestation</dt>
                <dd className="chiffres">{dateFr(d.datePrestation)}</dd>
              </>
            )}
            {d.validiteJours !== undefined && (
              <>
                <dt>Validité</dt>
                <dd>{nombre(d.validiteJours)} jours</dd>
              </>
            )}
            {d.origine && (
              <>
                <dt>{doc.type === "avoir" ? "Facture rectifiée" : "Devis d'origine"}</dt>
                <dd className="chiffres">{d.origine}</dd>
              </>
            )}
            {d.conditionsPaiement && (
              <>
                <dt>Paiement</dt>
                <dd>{d.conditionsPaiement}</dd>
              </>
            )}
          </dl>
        </section>
      </div>

      <section className="carte pile-serree" aria-labelledby="sec-lignes">
        <h2 id="sec-lignes">Lignes</h2>
        <div className="tableau-conteneur">
          <table className="tableau">
            <thead>
              <tr>
                <th scope="col">Désignation</th>
                <th scope="col" className="num">
                  Quantité
                </th>
                <th scope="col" className="num">
                  PU HT
                </th>
                <th scope="col" className="num">
                  Remise
                </th>
                <th scope="col" className="num">
                  TVA
                </th>
                <th scope="col" className="num">
                  Total HT
                </th>
              </tr>
            </thead>
            <tbody>
              {d.lignes.map((l, i) => (
                <tr key={i}>
                  <td data-libelle="Désignation">{l.designation}</td>
                  <td data-libelle="Quantité" className="num">
                    {nombre(l.quantite)} {l.unite}
                  </td>
                  <td data-libelle="PU HT" className="num">
                    {eur(l.prixUnitaireHtCents)}
                  </td>
                  <td data-libelle="Remise" className="num">
                    {l.remiseBp ? `${pourcentDepuisBp(l.remiseBp)} %` : "—"}
                  </td>
                  <td data-libelle="TVA" className="num">
                    {tauxTva(l.tva)}
                  </td>
                  <td data-libelle="Total HT" className="num">
                    {eur(htLigne(l))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="totaux-fiche">
          <dt>Total HT</dt>
          <dd>{eur(doc.totaux.htCents)}</dd>
          {Object.entries(doc.totaux.tvaParTaux).map(([t, m]) => (
            <div key={t} className="contents">
              <dt>TVA {tauxTva(Number(t))}</dt>
              <dd>{eur(m)}</dd>
            </div>
          ))}
          <dt className="ttc">Total TTC</dt>
          <dd className="ttc">{eur(doc.totaux.ttcCents)}</dd>
        </dl>
        {d.franchiseTva && <p className="attenue">TVA non applicable, art. 293 B du CGI.</p>}
      </section>

      {vente && !brouillon && <Paiements doc={doc} ecrire={ecrire} onChange={recharger} />}
    </div>
  );
}

function Paiements({ doc, ecrire, onChange }: { doc: DocumentApi; ecrire: boolean; onChange: () => void }) {
  const toast = useToast();
  const p = useDonnees(() => api.paiements(doc.id), [doc.id, doc.statut]);
  const [montant, setMontant] = useState("");
  const [date, setDate] = useState(aujourdhui());
  const [mode, setMode] = useState("virement");
  const [reference, setReference] = useState("");
  const [erreurMontant, setErreurMontant] = useState<string | null>(null);
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const [niveau, setNiveau] = useState("1");
  const [canal, setCanal] = useState("mail");
  const [relance, setRelance] = useState(false);

  async function payer(e: FormEvent) {
    e.preventDefault();
    const c = versCentimes(montant);
    if (!c) {
      setErreurMontant("Montant en euros, par exemple 120,50.");
      return;
    }
    if (p.etat === "ok" && c > p.donnees.resteCents) {
      setErreurMontant(`Au plus le reste dû, ${eur(p.donnees.resteCents)}.`);
      return;
    }
    setErreurMontant(null);
    setEnvoi(true);
    setErreur(null);
    try {
      const r = await api.payer(doc.id, {
        date,
        montantCents: c,
        mode: mode as "virement",
        reference: reference || undefined,
      });
      toast(r.resteCents === 0 ? "Facture soldée" : `Paiement enregistré, reste ${eur(r.resteCents)}`);
      setMontant("");
      setReference("");
      p.recharger();
      onChange();
    } catch (x) {
      setErreur(x as ErreurApi);
    } finally {
      setEnvoi(false);
    }
  }

  const ouverte = !["paye", "annule", "rejete"].includes(doc.statut);

  return (
    <section className="carte pile-serree" aria-labelledby="sec-paiements">
      <h2 id="sec-paiements">Paiements et relances</h2>
      {p.etat === "chargement" && <EtatChargement lignes={2} />}
      {p.etat === "erreur" && <EtatErreur message={p.erreur} onReessayer={p.recharger} />}
      {p.etat === "ok" && (
        <>
          <p className="kpi-valeur">
            Reste dû : {eur(p.donnees.resteCents)}{" "}
            <span className="attenue petit">sur {eur(p.donnees.ttcCents)} TTC</span>
          </p>
          {p.donnees.paiements.length === 0 ? (
            <p className="attenue">Aucun paiement enregistré.</p>
          ) : (
            <div className="tableau-conteneur">
              <table className="tableau">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Mode</th>
                    <th scope="col">Référence</th>
                    <th scope="col" className="num">
                      Montant
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {p.donnees.paiements.map((x) => (
                    <tr key={x.id}>
                      <td data-libelle="Date" className="num">
                        {dateFr(x.date)}
                      </td>
                      <td data-libelle="Mode">{LIBELLE_MODE[x.mode]}</td>
                      <td data-libelle="Référence">{x.reference ?? "—"}</td>
                      <td data-libelle="Montant" className="num">
                        {eur(x.montantCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {ecrire && ouverte && (
        <>
          <form className="grille grille-4 rangee-bas" noValidate onSubmit={payer} aria-label="Enregistrer un paiement">
            <ResumeErreurs erreur={erreur} />
            <ChampTexte
              libelle="Montant (€)"
              inputMode="decimal"
              requis
              value={montant}
              erreur={erreurMontant}
              onChange={(e) => setMontant(e.target.value)}
            />
            <ChampTexte libelle="Date" type="date" requis value={date} onChange={(e) => setDate(e.target.value)} />
            <ChampListe libelle="Mode" value={mode} onChange={(e) => setMode(e.target.value)}>
              {Object.entries(LIBELLE_MODE).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </ChampListe>
            <ChampTexte libelle="Référence" value={reference} onChange={(e) => setReference(e.target.value)} />
            <div>
              <Bouton type="submit" icone={Banknote} chargement={envoi}>
                Enregistrer le paiement
              </Bouton>
            </div>
          </form>
          <div className="rangee rangee-bas">
            <ChampListe libelle="Palier de relance" value={niveau} onChange={(e) => setNiveau(e.target.value)}>
              <option value="1">1 : rappel amiable</option>
              <option value="2">2 : relance ferme</option>
              <option value="3">3 : mise en demeure</option>
            </ChampListe>
            <ChampListe libelle="Canal" value={canal} onChange={(e) => setCanal(e.target.value)}>
              <option value="mail">E-mail</option>
              <option value="courrier">Courrier</option>
              <option value="telephone">Téléphone</option>
            </ChampListe>
            <Bouton
              icone={BellRing}
              chargement={relance}
              onClick={async () => {
                setRelance(true);
                setErreur(null);
                try {
                  await api.relancer(doc.id, Number(niveau) as 1 | 2 | 3, canal as "mail");
                  toast(`Relance de palier ${niveau} enregistrée`);
                } catch (x) {
                  setErreur(x as ErreurApi);
                } finally {
                  setRelance(false);
                }
              }}
            >
              Enregistrer la relance
            </Bouton>
          </div>
          <Bandeau>
            <p>
              La relance est consignée dans l'historique ; l'envoi automatique par e-mail arrivera avec la boîte mail.
            </p>
          </Bandeau>
        </>
      )}
    </section>
  );
}
