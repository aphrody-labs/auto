// Éditeur de devis, factures, acomptes et avoirs : lignes avec TVA et remises, totaux en direct (@auto/domain),
// mentions vérifiées avant émission. L'émetteur et la franchise sont imposés par l'API.
import {
  avecMentionsParDefaut,
  avoirTotal,
  devisVersFacture,
  totaux,
  verifier,
  type Document,
  type Ligne,
  type Partie,
  type Tva,
  type Type,
} from "@auto/domain";
import { ArrowDown, ArrowUp, FileCheck, Plus, Save, Trash2 } from "@auto/ui/symboles";
import { useEffect, useState, type FormEvent } from "react";
import {
  api,
  ErreurApi,
  type BrouillonApi,
  type Client,
  type DocumentApi,
  type Produit,
  type Chantier,
} from "@auto/client";
import {
  ajouterJours,
  aujourdhui,
  depuisCentimes,
  erreursLigne,
  eur,
  htLigneSaisie,
  LIBELLE_TYPE,
  pourcentDepuisBp,
  TAUX_TVA,
  tauxTva,
  versLigne,
  type SaisieLigne,
} from "@auto/ui/format";
import { useSession } from "../session";
import {
  Bandeau,
  Bouton,
  ChampListe,
  ChampTexte,
  ChampZone,
  EtatChargement,
  EtatErreur,
  Lien,
  ResumeErreurs,
  naviguer,
  parametre,
  useDonnees,
  useTitrePage,
  useToast,
} from "@auto/ui/react";

const TYPES: Type[] = ["devis", "facture", "acompte", "avoir"];

const ligneVide = (tva: Tva): SaisieLigne => ({ designation: "", quantite: "1", unite: "", prix: "", remise: "", tva });

const versSaisie = (l: Ligne): SaisieLigne => ({
  designation: l.designation,
  quantite: String(l.quantite).replace(".", ","),
  unite: l.unite ?? "",
  prix: depuisCentimes(l.prixUnitaireHtCents),
  remise: pourcentDepuisBp(l.remiseBp),
  tva: l.tva,
});

interface Etat {
  chantierId?: string;
  type: Type;
  clientId: string;
  client: Partie;
  date: string;
  echeance: string;
  datePrestation: string;
  validiteJours: string;
  origine: string;
  conditionsPaiement: string;
  notes: string;
  lignes: SaisieLigne[];
}

function etatInitial(type: Type, franchise: boolean, d?: Document, clientId?: string | null): Etat {
  const jour = aujourdhui();
  const tva: Tva = franchise ? 0 : 200;
  return {
    type: d?.type ?? type,
    clientId: clientId ?? "",
    client: d?.client ?? { nom: "", siret: "", adresse: "" },
    date: d?.date ?? jour,
    echeance: d?.echeance ?? ajouterJours(jour, 30),
    datePrestation: d?.datePrestation ?? jour,
    validiteJours: String(d?.validiteJours ?? 30),
    origine: d?.origine ?? "",
    conditionsPaiement: d?.conditionsPaiement ?? "",
    notes: d?.notes ?? "",
    lignes: d?.lignes.length ? d.lignes.map(versSaisie) : [ligneVide(tva)],
  };
}

/** État de l'éditeur → corps de l'API ; les lignes invalides sont laissées de côté (signalées sous les champs). */
function versBrouillon(e: Etat): BrouillonApi {
  const facture = e.type !== "devis";
  return {
    type: e.type,
    ...(e.chantierId !== undefined ? { chantierId: e.chantierId || null } : {}),
    date: e.date,
    lignes: e.lignes.map(versLigne).filter((l): l is NonNullable<typeof l> => l !== null),
    ...(e.clientId ? { clientId: e.clientId } : { client: e.client }),
    ...(facture ? { echeance: e.echeance, datePrestation: e.datePrestation } : {}),
    ...(e.type === "devis" ? { validiteJours: Number(e.validiteJours) || 30 } : {}),
    ...(e.origine.trim() ? { origine: e.origine.trim() } : {}),
    ...(e.conditionsPaiement.trim() ? { conditionsPaiement: e.conditionsPaiement.trim() } : {}),
    ...(e.notes.trim() ? { notes: e.notes.trim() } : {}),
  } as BrouillonApi;
}

export function Editeur({ id }: { id?: string }) {
  const depuis = parametre("depuis");
  const vers = parametre("vers") as Type | null;
  const typeQ = parametre("type") as Type | null;
  const { moi } = useSession();
  const franchise = moi.entreprise.franchiseTva;

  const charge = useDonnees(async () => {
    const [clients, produits, doc, source, chantiers, affectation] = await Promise.all([
      api.clients().catch(() => [] as Client[]),
      api.produits().catch(() => [] as Produit[]),
      id ? api.document(id) : Promise.resolve(null),
      depuis ? api.document(depuis) : Promise.resolve(null),
      api.chantiers(),
      id || depuis ? api.affectationDocument((id || depuis)!) : Promise.resolve(null),
    ]);
    return { clients, produits, doc, source, chantiers, affectation };
  }, [id, depuis]);

  if (charge.etat === "chargement")
    return (
      <div className="page">
        <EtatChargement libelle="Ouverture de l'éditeur" />
      </div>
    );
  if (charge.etat === "erreur")
    return (
      <div className="page">
        <EtatErreur message={charge.erreur} onReessayer={charge.recharger} />
      </div>
    );

  const { doc, source, clients, produits, chantiers, affectation } = charge.donnees;
  let initial: Etat;
  if (doc) initial = etatInitial(doc.type, franchise, doc.data, doc.clientId);
  else if (source && source.numero && vers === "avoir")
    initial = {
      ...etatInitial("avoir", franchise, avoirTotal(source.data, source.numero, aujourdhui()), source.clientId),
    };
  else if (source && source.numero && vers === "facture") {
    const j = aujourdhui();
    initial = etatInitial(
      "facture",
      franchise,
      devisVersFacture(source.data, source.numero, j, ajouterJours(j, 30)),
      source.clientId,
    );
    initial.datePrestation = j;
  } else initial = etatInitial(typeQ && TYPES.includes(typeQ) ? typeQ : "facture", franchise);
  const chantierInitial = chantiers.find((c) => c.id === (affectation?.chantierId || parametre("chantier")));
  initial.chantierId = chantierInitial?.id || "";
  if (chantierInitial && !doc && !source) initial.clientId = chantierInitial.clientId;

  if (doc && doc.statut !== "brouillon")
    return (
      <div className="page">
        <Bandeau ton="avertissement" titre="Document émis">
          <p>Un document émis n'est plus modifiable : créez un avoir pour le corriger.</p>
        </Bandeau>
        <Lien className="bouton" href={`/app/documents/${doc.id}`}>
          Retour au document
        </Lien>
      </div>
    );

  return <Formulaire id={id} initial={initial} clients={clients} produits={produits} doc={doc} chantiers={chantiers} />;
}

function Formulaire({
  id,
  initial,
  clients,
  produits,
  doc,
  chantiers,
}: {
  id?: string;
  initial: Etat;
  clients: Client[];
  produits: Produit[];
  doc: DocumentApi | null;
  chantiers: Chantier[];
}) {
  const { moi } = useSession();
  const toast = useToast();
  const franchise = moi.entreprise.franchiseTva;
  const [e, setE] = useState<Etat>(initial);
  const [modifie, setModifie] = useState(false);
  const [envoi, setEnvoi] = useState<"" | "brouillon" | "emission">("");
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [tente, setTente] = useState(false);
  useTitrePage(
    id ? `Modifier ${LIBELLE_TYPE[e.type].toLowerCase()}` : `Nouveau document, ${LIBELLE_TYPE[e.type].toLowerCase()}`,
  );

  useEffect(() => {
    if (!modifie) return;
    const garde = (ev: BeforeUnloadEvent) => ev.preventDefault();
    addEventListener("beforeunload", garde);
    return () => removeEventListener("beforeunload", garde);
  }, [modifie]);

  const maj = (p: Partial<Etat>) => {
    setE((x) => ({ ...x, ...p }));
    setModifie(true);
  };
  const majLigne = (i: number, p: Partial<SaisieLigne>) =>
    maj({ lignes: e.lignes.map((l, j) => (j === i ? { ...l, ...p } : l)) });
  const deplacer = (i: number, d: -1 | 1) => {
    const l = [...e.lignes];
    [l[i], l[i + d]] = [l[i + d]!, l[i]!];
    maj({ lignes: l });
  };

  const brouillon = versBrouillon(e);
  const t = totaux(brouillon.lignes);
  const clientChoisi = clients.find((c) => c.id === e.clientId);
  const manquantes = verifier(
    avecMentionsParDefaut({
      ...(brouillon as Document),
      client: clientChoisi ?? e.client,
      emetteur: {
        nom: moi.entreprise.nom,
        siret: moi.entreprise.siret,
        adresse: moi.entreprise.adresse,
        tvaIntracom: moi.entreprise.tvaIntracom ?? undefined,
      },
      franchiseTva: franchise,
    }),
  );
  const lignesInvalides = e.lignes.some((l) => Object.keys(erreursLigne(l)).length > 0);

  async function enregistrer(emettre: boolean) {
    setTente(true);
    setErreur(null);
    if (lignesInvalides) {
      setErreur(new ErreurApi("Des lignes sont incomplètes : corrigez les champs signalés.", 422));
      return;
    }
    setEnvoi(emettre ? "emission" : "brouillon");
    try {
      let d = id ? await api.modifierDocument(id, brouillon) : await api.creerDocument(brouillon);
      setModifie(false);
      if (emettre) {
        d = await api.emettre(d.id);
        toast(`${LIBELLE_TYPE[d.type]} ${d.numero} émis${d.type === "facture" ? "e" : ""}`);
      } else toast("Brouillon enregistré");
      naviguer(`/app/documents/${d.id}`, true);
    } catch (x) {
      setErreur(x as ErreurApi);
    } finally {
      setEnvoi("");
    }
  }

  const soumettre = (ev: FormEvent) => {
    ev.preventDefault();
    void enregistrer(false);
  };

  const facture = e.type !== "devis";

  return (
    <div className="page">
      <div className="page-entete">
        <h1>
          {id ? "Modifier" : "Nouveau document"} : {LIBELLE_TYPE[e.type].toLowerCase()}
        </h1>
      </div>
      <form className="editeur" noValidate onSubmit={soumettre} aria-label="Éditeur de document">
        <div className="pile">
          <ResumeErreurs erreur={erreur} />
          {franchise && (
            <Bandeau titre="Franchise en base de TVA">
              <p>TVA non applicable, art. 293 B du CGI : les lignes sont à 0 % et la mention figure sur le document.</p>
            </Bandeau>
          )}

          <section className="carte grille grille-3" aria-labelledby="sec-doc">
            <h2 id="sec-doc" className="pleine-largeur">
              Document
            </h2>
            <ChampListe
              libelle="Type"
              value={e.type}
              disabled={!!doc}
              onChange={(x) => maj({ type: x.target.value as Type })}
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {LIBELLE_TYPE[t]}
                </option>
              ))}
            </ChampListe>
            <ChampTexte
              libelle="Date"
              type="date"
              requis
              value={e.date}
              onChange={(x) => maj({ date: x.target.value })}
            />
            {facture ? (
              <>
                <ChampTexte
                  libelle="Échéance"
                  type="date"
                  requis
                  value={e.echeance}
                  erreur={tente && !e.echeance ? "Échéance obligatoire sur une facture." : null}
                  onChange={(x) => maj({ echeance: x.target.value })}
                />
                <ChampTexte
                  libelle="Date de prestation ou de livraison"
                  type="date"
                  requis
                  value={e.datePrestation}
                  onChange={(x) => maj({ datePrestation: x.target.value })}
                />
              </>
            ) : (
              <ChampTexte
                libelle="Validité (jours)"
                inputMode="numeric"
                value={e.validiteJours}
                onChange={(x) => maj({ validiteJours: x.target.value })}
              />
            )}
            {(e.type === "avoir" || e.origine) && (
              <ChampTexte
                libelle={e.type === "avoir" ? "Facture rectifiée (numéro)" : "Devis d'origine"}
                requis={e.type === "avoir"}
                value={e.origine}
                erreur={
                  tente && e.type === "avoir" && !e.origine.trim()
                    ? "Numéro de la facture d'origine obligatoire."
                    : null
                }
                onChange={(x) => maj({ origine: x.target.value })}
              />
            )}
          </section>

          <section className="carte grille grille-2" aria-labelledby="sec-client">
            <h2 id="sec-client" className="pleine-largeur">
              Client
            </h2>
            <ChampListe
              libelle="Client enregistré"
              className="pleine-largeur"
              value={e.clientId}
              aide={clients.length === 0 ? "Aucun client enregistré : saisissez le client ci-dessous." : undefined}
              onChange={(x) => maj({ clientId: x.target.value, chantierId: "" })}
            >
              <option value="">Saisie libre</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nom}
                </option>
              ))}
            </ChampListe>
            <ChampListe
              libelle="Chantier / code analytique"
              className="pleine-largeur"
              value={e.chantierId || ""}
              aide="Le choix du chantier reprend le client enregistré."
              onChange={(x) => {
                const c = chantiers.find((c) => c.id === x.target.value);
                maj({ chantierId: x.target.value, ...(c ? { clientId: c.clientId } : {}) });
              }}
            >
              <option value="">Sans chantier</option>
              {chantiers
                .filter((c) => !c.archive || c.id === e.chantierId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} · {c.nom}
                  </option>
                ))}
            </ChampListe>
            {!e.clientId && (
              <>
                <ChampTexte
                  libelle="Nom ou raison sociale"
                  requis
                  autoComplete="organization"
                  value={e.client.nom}
                  erreur={tente && !e.client.nom.trim() ? "Nom du client obligatoire." : null}
                  onChange={(x) => maj({ client: { ...e.client, nom: x.target.value } })}
                />
                <ChampTexte
                  libelle="SIRET"
                  inputMode="numeric"
                  aide="Facultatif pour un particulier."
                  value={e.client.siret}
                  onChange={(x) => maj({ client: { ...e.client, siret: x.target.value.replace(/\s/g, "") } })}
                />
                <ChampZone
                  libelle="Adresse"
                  rows={2}
                  requis
                  className="pleine-largeur"
                  value={e.client.adresse}
                  erreur={tente && !e.client.adresse.trim() ? "Adresse du client obligatoire." : null}
                  onChange={(x) => maj({ client: { ...e.client, adresse: x.target.value } })}
                />
                <ChampTexte
                  libelle="E-mail"
                  type="email"
                  value={e.client.email ?? ""}
                  onChange={(x) => maj({ client: { ...e.client, email: x.target.value || undefined } })}
                />
              </>
            )}
          </section>

          <section className="carte pile-serree" aria-labelledby="sec-lignes">
            <div className="rangee">
              <h2 id="sec-lignes" className="espace">
                Lignes
              </h2>
              {produits.length > 0 && (
                <ChampListe
                  libelle="Ajouter depuis le catalogue"
                  value=""
                  onChange={(x) => {
                    const p = produits.find((p) => p.id === x.target.value);
                    if (!p) return;
                    const l = versSaisie({ ...p, quantite: 1, tva: franchise ? 0 : p.tva });
                    const vide = e.lignes.length === 1 && !e.lignes[0]!.designation && !e.lignes[0]!.prix;
                    maj({ lignes: vide ? [l] : [...e.lignes, l] });
                  }}
                >
                  <option value="">Choisir un produit</option>
                  {produits.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.designation} ({eur(p.prixUnitaireHtCents)} HT)
                    </option>
                  ))}
                </ChampListe>
              )}
            </div>
            <ol className="lignes" aria-label="Lignes du document">
              {e.lignes.map((l, i) => {
                const err = tente ? erreursLigne(l) : {};
                const n = i + 1;
                return (
                  <li key={i} className="ligne-doc" aria-label={`Ligne ${n}`}>
                    <ChampTexte
                      className="designation"
                      libelle={`Désignation, ligne ${n}`}
                      requis
                      value={l.designation}
                      erreur={err.designation}
                      onChange={(x) => majLigne(i, { designation: x.target.value })}
                    />
                    <ChampTexte
                      libelle="Quantité"
                      inputMode="decimal"
                      value={l.quantite}
                      erreur={err.quantite}
                      onChange={(x) => majLigne(i, { quantite: x.target.value })}
                    />
                    <ChampTexte
                      libelle="Unité"
                      value={l.unite}
                      placeholder="h, jour…"
                      onChange={(x) => majLigne(i, { unite: x.target.value })}
                    />
                    <ChampTexte
                      libelle="Prix unitaire HT (€)"
                      inputMode="decimal"
                      value={l.prix}
                      erreur={err.prix}
                      onChange={(x) => majLigne(i, { prix: x.target.value })}
                    />
                    <ChampTexte
                      libelle="Remise (%)"
                      inputMode="decimal"
                      value={l.remise}
                      erreur={err.remise}
                      onChange={(x) => majLigne(i, { remise: x.target.value })}
                    />
                    {franchise ? (
                      <div className="champ">
                        <span className="libelle-statique">TVA</span>
                        <span className="total-ligne">0 %</span>
                      </div>
                    ) : (
                      <ChampListe
                        libelle="TVA"
                        value={l.tva}
                        onChange={(x) => majLigne(i, { tva: Number(x.target.value) as Tva })}
                      >
                        {TAUX_TVA.map((t) => (
                          <option key={t} value={t}>
                            {tauxTva(t)}
                          </option>
                        ))}
                      </ChampListe>
                    )}
                    <div className="champ">
                      <span className="libelle-statique">Total HT</span>
                      <output className="total-ligne" aria-label={`Total HT, ligne ${n}`}>
                        {eur(htLigneSaisie(l))}
                      </output>
                    </div>
                    <div className="actions-ligne">
                      <Bouton
                        variante="fantome"
                        icone={ArrowUp}
                        aria-label={`Monter la ligne ${n}`}
                        disabled={i === 0}
                        onClick={() => deplacer(i, -1)}
                      />
                      <Bouton
                        variante="fantome"
                        icone={ArrowDown}
                        aria-label={`Descendre la ligne ${n}`}
                        disabled={i === e.lignes.length - 1}
                        onClick={() => deplacer(i, 1)}
                      />
                      <Bouton
                        variante="fantome"
                        icone={Trash2}
                        aria-label={`Supprimer la ligne ${n}`}
                        disabled={e.lignes.length === 1}
                        onClick={() => {
                          maj({ lignes: e.lignes.filter((_, j) => j !== i) });
                          toast(`Ligne ${n} supprimée`);
                        }}
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
            <div>
              <Bouton icone={Plus} onClick={() => maj({ lignes: [...e.lignes, ligneVide(franchise ? 0 : 200)] })}>
                Ajouter une ligne
              </Bouton>
            </div>
          </section>

          <section className="carte grille" aria-labelledby="sec-conditions">
            <h2 id="sec-conditions">Conditions et notes</h2>
            {facture && (
              <ChampTexte
                libelle="Conditions de paiement"
                placeholder="Paiement à 30 jours"
                aide="Pénalités de retard, indemnité de 40 € et escompte sont ajoutés automatiquement."
                value={e.conditionsPaiement}
                onChange={(x) => maj({ conditionsPaiement: x.target.value })}
              />
            )}
            <ChampZone libelle="Notes" rows={3} value={e.notes} onChange={(x) => maj({ notes: x.target.value })} />
          </section>
        </div>

        <aside className="carte totaux" aria-labelledby="sec-totaux">
          <h2 id="sec-totaux">Totaux</h2>
          <dl aria-live="polite">
            <dt>Total HT</dt>
            <dd>{eur(t.htCents)}</dd>
            {Object.entries(t.tvaParTaux)
              .sort(([a], [b]) => Number(b) - Number(a))
              .map(([taux, m]) => (
                <div key={taux} className="contents">
                  <dt>TVA {tauxTva(Number(taux))}</dt>
                  <dd>{eur(m)}</dd>
                </div>
              ))}
            <dt className="ttc">Total TTC</dt>
            <dd className="ttc">{eur(t.ttcCents)}</dd>
          </dl>
          {manquantes.length > 0 && (
            <Bandeau ton="avertissement" titre="Avant émission">
              <ul>
                {manquantes.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </Bandeau>
          )}
          <div className="grille">
            <Bouton type="submit" icone={Save} chargement={envoi === "brouillon"} disabled={!!envoi} plein>
              Enregistrer le brouillon
            </Bouton>
            <Bouton
              variante="primaire"
              icone={FileCheck}
              chargement={envoi === "emission"}
              disabled={!!envoi}
              plein
              onClick={() => void enregistrer(true)}
            >
              Enregistrer et émettre
            </Bouton>
            <p className="attenue petit">L'émission attribue le numéro définitif et fige le document.</p>
          </div>
        </aside>
      </form>
    </div>
  );
}
