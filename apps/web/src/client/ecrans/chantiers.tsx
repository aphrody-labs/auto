import { useState, type FormEvent } from "react";
import {
  api,
  ErreurApi,
  type Chantier,
  type Client,
  type DossierChantier,
  type Fournisseur,
  type PieceChantier,
} from "@auto/client";
import { dateFr, eur, LIBELLE_TYPE, versCentimes } from "@auto/ui/format";
import { Building2, FileDown, Pencil, Plus } from "@auto/ui/symboles";
import {
  Bandeau,
  Bouton,
  ChampListe,
  ChampTexte,
  ChampZone,
  EtatChargement,
  EtatErreur,
  EtatVide,
  Lien,
  Modale,
  ResumeErreurs,
  useDonnees,
  useTitrePage,
  useToast,
} from "@auto/ui/react";
import { peut, useSession } from "../session";
import { accesSegment } from "@auto/tenancy/segments";
import { PiecesTableau, FormulairePiece } from "./pieces-chantier";

export const STATUT_CHANTIER: Record<Chantier["statut"], string> = {
  planifie: "Planifié",
  en_cours: "En cours",
  termine: "Terminé",
  en_pause: "En pause",
};
export function Attente({ etat, onReessayer }: { etat: { etat: string; erreur?: string }; onReessayer: () => void }) {
  return etat.etat === "erreur" ? <EtatErreur message={etat.erreur!} onReessayer={onReessayer} /> : <EtatChargement />;
}
export function Fournisseurs() {
  useTitrePage("Fournisseurs");
  const { moi } = useSession();
  const ecrire = peut(moi.role, "ecrire");
  const [q, setQ] = useState("");
  const [archives, setArchives] = useState(false);
  const [edition, setEdition] = useState<Fournisseur | null | undefined>();
  const d = useDonnees(() => api.fournisseurs());
  return (
    <div className="page pile">
      <div className="page-entete">
        <div>
          <h1>Fournisseurs</h1>
          <p className="attenue">Votre répertoire de partenaires pour classer les achats et les pièces de chantier.</p>
        </div>
        {ecrire && (
          <Bouton variante="primaire" icone={Plus} onClick={() => setEdition(null)}>
            Nouveau fournisseur
          </Bouton>
        )}
      </div>
      <div className="rangee">
        <ChampTexte libelle="Rechercher un fournisseur" value={q} onChange={(e) => setQ(e.target.value)} />
        <ChampListe
          libelle="Afficher"
          value={archives ? "archives" : "actifs"}
          onChange={(e) => setArchives(e.target.value === "archives")}
        >
          <option value="actifs">Actifs</option>
          <option value="archives">Archivés</option>
        </ChampListe>
      </div>
      {d.etat !== "ok" ? (
        <Attente etat={d} onReessayer={d.recharger} />
      ) : (
        <div className="tableau-conteneur" tabIndex={0} role="region" aria-label="Répertoire fournisseurs">
          <table className="tableau">
            <thead>
              <tr>
                {["Fournisseur", "Contact", "Coordonnées", "SIRET", "Actions"].map((x) => (
                  <th scope="col" key={x}>
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.donnees
                .filter(
                  (f) =>
                    f.archive === archives &&
                    [f.nom, f.contact, f.siret].join(" ").toLowerCase().includes(q.toLowerCase()),
                )
                .map((f) => (
                  <tr key={f.id}>
                    <td data-libelle="Fournisseur">
                      <Lien href={"/app/fournisseurs/" + f.id}>
                        <strong>{f.nom}</strong>
                      </Lien>
                      <div className="aide">{f.adresse}</div>
                    </td>
                    <td data-libelle="Contact">{f.contact || "—"}</td>
                    <td data-libelle="Coordonnées">
                      {f.email || "—"}
                      <div className="aide">{f.telephone}</div>
                    </td>
                    <td data-libelle="SIRET">{f.siret || "—"}</td>
                    <td data-libelle="Actions">
                      <Lien className="bouton bouton-fantome" href={"/app/pieces?fournisseur=" + f.id}>
                        Voir les pièces
                      </Lien>
                      {ecrire && (
                        <Bouton icone={Pencil} aria-label={"Modifier " + f.nom} onClick={() => setEdition(f)} />
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          {!d.donnees.some(
            (f) =>
              f.archive === archives && [f.nom, f.contact, f.siret].join(" ").toLowerCase().includes(q.toLowerCase()),
          ) && (
            <EtatVide titre="Aucun fournisseur trouvé">
              <p>Ajoutez un fournisseur ou modifiez votre recherche.</p>
            </EtatVide>
          )}
        </div>
      )}
      <Modale
        ouverte={edition !== undefined}
        titre={edition ? "Modifier le fournisseur" : "Nouveau fournisseur"}
        onFermer={() => setEdition(undefined)}
      >
        {edition !== undefined && (
          <FormulaireFournisseur
            initial={edition}
            onFin={() => {
              setEdition(undefined);
              d.recharger();
            }}
          />
        )}
      </Modale>
    </div>
  );
}
function FormulaireFournisseur({ initial, onFin }: { initial: Fournisseur | null; onFin: () => void }) {
  const [f, setF] = useState<Omit<Fournisseur, "id">>(
    initial ?? { nom: "", adresse: "", siret: "", email: "", telephone: "", contact: "", notes: "", archive: false },
  );
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const toast = useToast();
  async function sauver(e: FormEvent) {
    e.preventDefault();
    setEnvoi(true);
    setErreur(null);
    try {
      if (initial) await api.modifierFournisseur(initial.id, f);
      else await api.creerFournisseur(f);
      toast("Fournisseur enregistré");
      onFin();
    } catch (e) {
      setErreur(e as ErreurApi);
    } finally {
      setEnvoi(false);
    }
  }
  return (
    <form className="grille" onSubmit={sauver}>
      <ResumeErreurs erreur={erreur} />
      {(["nom", "contact", "email", "telephone", "siret", "adresse"] as const).map((k) => (
        <ChampTexte
          key={k}
          libelle={
            {
              nom: "Nom ou raison sociale",
              contact: "Contact",
              email: "E-mail",
              telephone: "Téléphone",
              siret: "SIRET",
              adresse: "Adresse",
            }[k]
          }
          requis={k === "nom"}
          type={k === "email" ? "email" : k === "telephone" ? "tel" : "text"}
          value={f[k]}
          maxLength={500}
          onChange={(e) => setF({ ...f, [k]: e.target.value })}
        />
      ))}
      <ChampZone libelle="Notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      {initial && (
        <label className="rangee">
          <input type="checkbox" checked={f.archive} onChange={(e) => setF({ ...f, archive: e.target.checked })} />
          Fournisseur archivé (historique conservé)
        </label>
      )}
      <div className="rangee">
        <Bouton onClick={onFin}>Annuler</Bouton>
        <Bouton type="submit" variante="primaire" chargement={envoi}>
          Enregistrer
        </Bouton>
      </div>
    </form>
  );
}

export function Chantiers() {
  useTitrePage("Chantiers");
  const { moi } = useSession();
  const ecrire = peut(moi.role, "ecrire");
  const [q, setQ] = useState("");
  const [statut, setStatut] = useState("actifs");
  const [edition, setEdition] = useState<Chantier | null | undefined>();
  const d = useDonnees(async () => ({ chantiers: await api.chantiers(), clients: await api.clients() }));
  const rows =
    d.etat === "ok"
      ? d.donnees.chantiers.filter(
          (c) =>
            (statut === "archives" ? c.archive : !c.archive && (statut === "actifs" || c.statut === statut)) &&
            [c.nom, c.code, c.adresse].join(" ").toLowerCase().includes(q.toLowerCase()),
        )
      : [];
  return (
    <div className="page pile">
      <div className="page-entete">
        <div>
          <h1>Chantiers</h1>
          <p className="attenue">Suivez vos projets, leurs documents et leurs résultats.</p>
        </div>
        {ecrire && (
          <Bouton variante="primaire" icone={Plus} onClick={() => setEdition(null)}>
            Nouveau chantier
          </Bouton>
        )}
      </div>
      <div className="rangee">
        <ChampTexte libelle="Rechercher un chantier" value={q} onChange={(e) => setQ(e.target.value)} />
        <ChampListe libelle="Statut" value={statut} onChange={(e) => setStatut(e.target.value)}>
          <option value="actifs">Tous les actifs</option>
          {Object.entries(STATUT_CHANTIER).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
          <option value="archives">Archivés</option>
        </ChampListe>
      </div>
      {d.etat !== "ok" ? (
        <Attente etat={d} onReessayer={d.recharger} />
      ) : rows.length ? (
        <div className="tableau-conteneur" tabIndex={0} role="region" aria-label="Liste des chantiers">
          <table className="tableau">
            <thead>
              <tr>
                {["Chantier", "Client", "Budget HT", "Avancement", "Statut", "Actions"].map((x) => (
                  <th scope="col" key={x}>
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td data-libelle="Chantier">
                    <Lien href={"/app/chantiers/" + c.id}>
                      <strong>{c.nom}</strong>
                    </Lien>
                    <div className="aide">
                      {c.code} · {c.adresse}
                    </div>
                  </td>
                  <td data-libelle="Client">{d.donnees.clients.find((x) => x.id === c.clientId)?.nom || "—"}</td>
                  <td data-libelle="Budget HT" className="num">
                    {eur(c.budgetHtCents)}
                  </td>
                  <td data-libelle="Avancement">
                    <div className="chantier-progression">
                      <progress max={100} value={c.avancement} aria-label={"Avancement " + c.nom} />
                      <span>{c.avancement} %</span>
                    </div>
                  </td>
                  <td data-libelle="Statut">{STATUT_CHANTIER[c.statut]}</td>
                  <td data-libelle="Actions">
                    {ecrire && <Bouton icone={Pencil} aria-label={"Modifier " + c.nom} onClick={() => setEdition(c)} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EtatVide icone={Building2} titre="Aucun chantier trouvé">
          <p>Ajoutez un chantier et associez-le à un client.</p>
        </EtatVide>
      )}
      <Modale
        ouverte={edition !== undefined}
        titre={edition ? "Modifier le chantier" : "Nouveau chantier"}
        onFermer={() => setEdition(undefined)}
      >
        {edition !== undefined && d.etat === "ok" && (
          <FormulaireChantier
            initial={edition}
            clients={d.donnees.clients}
            onFin={() => {
              setEdition(undefined);
              d.recharger();
            }}
          />
        )}
      </Modale>
    </div>
  );
}
function FormulaireChantier({
  initial,
  clients,
  onFin,
}: {
  initial: Chantier | null;
  clients: Client[];
  onFin: () => void;
}) {
  const [c, setC] = useState<Omit<Chantier, "id">>(
    initial ?? {
      nom: "",
      code: "",
      clientId: "",
      adresse: "",
      budgetHtCents: 0,
      avancement: 0,
      statut: "en_cours",
      debut: null,
      fin: null,
      notes: "",
      archive: false,
    },
  );
  const [budget, setBudget] = useState(String(c.budgetHtCents / 100));
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const toast = useToast();
  async function sauver(e: FormEvent) {
    e.preventDefault();
    setEnvoi(true);
    setErreur(null);
    try {
      const p = { ...c, budgetHtCents: versCentimes(budget) ?? 0 };
      if (initial) await api.modifierChantier(initial.id, p);
      else await api.creerChantier(p);
      toast("Chantier enregistré");
      onFin();
    } catch (e) {
      setErreur(e as ErreurApi);
    } finally {
      setEnvoi(false);
    }
  }
  return (
    <form className="grille" onSubmit={sauver}>
      <ResumeErreurs erreur={erreur} />
      <ChampTexte
        libelle="Nom du chantier"
        requis
        value={c.nom}
        onChange={(e) => setC({ ...c, nom: e.target.value })}
      />
      <div className="grille grille-2">
        <ChampTexte
          libelle="Code analytique"
          requis
          aide="Unique dans votre entreprise, par exemple CH-001."
          value={c.code}
          onChange={(e) => setC({ ...c, code: e.target.value })}
        />
        <ChampListe
          libelle="Client"
          requis
          value={c.clientId}
          onChange={(e) => {
            const client = clients.find((c) => c.id === e.target.value);
            setC({ ...c, clientId: e.target.value, adresse: c.adresse || client?.adresse || "" });
          }}
        >
          <option value="">Choisir un client</option>
          {clients.map((c) => (
            <option value={c.id} key={c.id}>
              {c.nom}
            </option>
          ))}
        </ChampListe>
      </div>
      {!clients.length && (
        <Bandeau>
          <p>
            Ajoutez d’abord un client dans <Lien href="/app/clients">Clients</Lien>.
          </p>
        </Bandeau>
      )}
      <ChampTexte
        libelle="Adresse du chantier"
        value={c.adresse}
        onChange={(e) => setC({ ...c, adresse: e.target.value })}
      />
      <div className="grille grille-2">
        <ChampTexte
          libelle="Budget HT (€)"
          inputMode="decimal"
          requis
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          erreur={versCentimes(budget) === null ? "Saisissez un montant valide." : null}
        />
        <ChampTexte
          libelle="Avancement (%)"
          type="number"
          min={0}
          max={100}
          requis
          value={c.avancement}
          onChange={(e) => setC({ ...c, avancement: Number(e.target.value) })}
        />
        <ChampTexte
          libelle="Début"
          type="date"
          value={c.debut || ""}
          onChange={(e) => setC({ ...c, debut: e.target.value || null })}
        />
        <ChampTexte
          libelle="Fin prévue"
          type="date"
          min={c.debut || undefined}
          value={c.fin || ""}
          onChange={(e) => setC({ ...c, fin: e.target.value || null })}
        />
      </div>
      <ChampListe
        libelle="Statut"
        value={c.statut}
        onChange={(e) => setC({ ...c, statut: e.target.value as Chantier["statut"] })}
      >
        {Object.entries(STATUT_CHANTIER).map(([v, l]) => (
          <option value={v} key={v}>
            {l}
          </option>
        ))}
      </ChampListe>
      <ChampZone libelle="Notes" value={c.notes} onChange={(e) => setC({ ...c, notes: e.target.value })} />
      {initial && (
        <label className="rangee">
          <input type="checkbox" checked={c.archive} onChange={(e) => setC({ ...c, archive: e.target.checked })} />
          Chantier archivé (pièces et analytique conservées)
        </label>
      )}
      <div className="rangee">
        <Bouton onClick={onFin}>Annuler</Bouton>
        <Bouton
          type="submit"
          variante="primaire"
          chargement={envoi}
          disabled={!clients.length || versCentimes(budget) === null}
        >
          Enregistrer
        </Bouton>
      </div>
    </form>
  );
}

export function DetailChantier({ id }: { id: string }) {
  const d = useDonnees(() => api.chantier(id), [id]);
  useTitrePage(d.etat === "ok" ? d.donnees.chantier.nom : "Chantier");
  return (
    <div className="page pile">
      <Lien href="/app/chantiers">← Tous les chantiers</Lien>
      {d.etat === "ok" ? (
        <Dossier dossier={d.donnees} recharger={d.recharger} />
      ) : (
        <Attente etat={d} onReessayer={d.recharger} />
      )}
    </div>
  );
}
function Dossier({ dossier, recharger }: { dossier: DossierChantier; recharger: () => void }) {
  const { moi } = useSession();
  const ecrire = peut(moi.role, "ecrire");
  const { chantier: c, analytique: a } = dossier;
  const [onglet, setOnglet] = useState("synthese");
  const [piece, setPiece] = useState<PieceChantier | null | undefined>();
  const [edition, setEdition] = useState(false);
  const tiers = useDonnees(async () => {
    const [fournisseurs, clients, recues] = await Promise.all([
      api.fournisseurs(),
      api.clients(),
      accesSegment(moi, "fournisseurs") ? api.recues() : Promise.resolve([]),
    ]);
    return { fournisseurs, clients, recues };
  });
  const nouveau = (type: string) => "/app/documents/nouveau?type=" + type + "&chantier=" + c.id;
  return (
    <>
      <div className="page-entete">
        <div>
          <h1>{c.nom}</h1>
          <p className="attenue">
            {c.code} · {STATUT_CHANTIER[c.statut]}
            {c.archive ? " · Archivé" : ""} · {c.avancement} %
          </p>
        </div>
        {ecrire && (
          <div className="rangee">
            <Bouton icone={Pencil} onClick={() => setEdition(true)}>
              Modifier
            </Bouton>
            {accesSegment(moi, "clients") && (
              <Lien className="bouton bouton-primaire" href={nouveau("devis")}>
                Créer un devis
              </Lien>
            )}
          </div>
        )}
      </div>
      <div className="onglets" role="group" aria-label="Dossier chantier">
        {[
          ["synthese", "Synthèse analytique"],
          ["documents", "Devis et factures"],
          ["achats", "Achats fournisseurs"],
          ["pieces", "Livraisons et commandes"],
        ]
          .filter(
            ([v]) =>
              v === "synthese" ||
              (v === "documents" && accesSegment(moi, "clients")) ||
              (v === "achats" && accesSegment(moi, "fournisseurs")) ||
              (v === "pieces" && (accesSegment(moi, "livraisons") || accesSegment(moi, "commandes"))),
          )
          .map(([v, l]) => (
            <button className="onglet" type="button" aria-pressed={onglet === v} onClick={() => setOnglet(v!)} key={v}>
              {l}
            </button>
          ))}
      </div>
      {onglet === "synthese" && (
        <>
          <div className="chantier-indicateurs">
            {[
              ["Ventes émises HT", a.ventesHtCents],
              ["Achats validés HT", a.achatsHtCents],
              ["Solde HT", a.soldeHtCents],
              ["Commandes non facturées HT", a.commandesHtCents],
            ].map(([l, v]) => (
              <section className="carte" key={l}>
                <h2 className="chantier-libelle">{l}</h2>
                <strong className="chantier-montant">{eur(v as number)}</strong>
              </section>
            ))}
          </div>
          <Bandeau titre="Périmètre du calcul">
            <p>
              Ventes émises, acomptes et avoirs affectés à ce chantier ; achats validés en EUR. Les devis, brouillons,
              livraisons et commandes ne sont pas inclus dans le solde. Hors main-d’œuvre et charges non saisies.
            </p>
            <p>
              {a.achatsAffectes} achat(s) affecté(s).{" "}
              {a.achatsNonChiffres > 0
                ? `${a.achatsNonChiffres} achat(s) validé(s) non chiffré(s) : extraction absente ou devise différente de l’euro.`
                : "Les achats non validés restent exclus du calcul."}
            </p>
          </Bandeau>
          <section className="carte grille grille-2">
            <div>
              <h2>Informations chantier</h2>
              <p>{c.adresse || "Adresse non renseignée"}</p>
              <p>
                Budget HT : <strong>{eur(c.budgetHtCents)}</strong>
              </p>
              <p>
                {c.debut || c.fin
                  ? `Début : ${dateFr(c.debut || "") || "—"} · Fin prévue : ${dateFr(c.fin || "") || "—"}`
                  : "Dates non renseignées"}
              </p>
              <p>{c.notes}</p>
            </div>
            <div>
              <h2>Avancement</h2>
              <div className="chantier-progression">
                <progress max={100} value={c.avancement} aria-label="Avancement du chantier" />
                {c.avancement} %
              </div>
              <p className="attenue">
                Les affectations restent modifiables sans toucher aux exemplaires de facturation figés.
              </p>
            </div>
          </section>
          <Bouton icone={FileDown} onClick={() => exporterAnalytique(dossier)}>
            Exporter l’analytique (CSV)
          </Bouton>
        </>
      )}
      {onglet === "documents" && (
        <>
          <div className="rangee">
            {ecrire && (
              <Lien className="bouton" href={nouveau("facture")}>
                Nouvelle facture préremplie
              </Lien>
            )}
          </div>
          {dossier.documents.length ? (
            <div className="tableau-conteneur">
              <table className="tableau">
                <thead>
                  <tr>
                    {["Document", "Type", "Date", "HT", "Statut"].map((x) => (
                      <th scope="col" key={x}>
                        {x}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dossier.documents.map((d) => (
                    <tr key={d.id}>
                      <td data-libelle="Document">
                        <Lien href={"/app/documents/" + d.id}>{d.numero || "Brouillon"}</Lien>
                      </td>
                      <td data-libelle="Type">{LIBELLE_TYPE[d.type]}</td>
                      <td data-libelle="Date">{dateFr(d.data.date)}</td>
                      <td data-libelle="HT" className="num">
                        {eur(d.htCents)}
                      </td>
                      <td data-libelle="Statut">{d.statut}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EtatVide titre="Aucun devis ou facture affecté">
              <p>Créez un document ici ou affectez un document existant depuis sa fiche.</p>
            </EtatVide>
          )}
        </>
      )}
      {onglet === "achats" && (
        <>
          {dossier.achats.length ? (
            <div className="tableau-conteneur">
              <table className="tableau">
                <thead>
                  <tr>
                    {["Fournisseur", "Facture", "Date", "HT", "Statut"].map((x) => (
                      <th scope="col" key={x}>
                        {x}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dossier.achats.map((r) => (
                    <tr key={r.id}>
                      <td data-libelle="Fournisseur">
                        {tiers.etat === "ok"
                          ? tiers.donnees.fournisseurs.find((f) => f.id === r.fournisseurId)?.nom || r.fournisseur
                          : r.fournisseur}
                      </td>
                      <td data-libelle="Facture">
                        <a href={api.urlFichierRecu(r.id)} target="_blank" rel="noopener">
                          {r.numero || "Ouvrir la pièce"}
                        </a>
                      </td>
                      <td data-libelle="Date">{dateFr(r.date || "")}</td>
                      <td data-libelle="HT" className="num">
                        {r.facture?.devise === "EUR" ? eur(r.facture.totaux.htCents) : "—"}
                      </td>
                      <td data-libelle="Statut">
                        {r.statut === "validee" ? "Validée" : r.statut === "rejetee" ? "Rejetée" : "À vérifier"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EtatVide titre="Aucun achat affecté">
              <p>Classez vos factures reçues par fournisseur et chantier.</p>
            </EtatVide>
          )}
          <Lien className="bouton" href="/app/achats">
            Classer les factures reçues
          </Lien>
        </>
      )}
      {onglet === "pieces" && (
        <>
          <div className="rangee">
            {ecrire && (
              <Bouton variante="primaire" icone={Plus} onClick={() => setPiece(null)}>
                Ajouter une pièce
              </Bouton>
            )}
            <p className="attenue">Bons de livraison et confirmations de commande, archives comprises.</p>
          </div>
          <PiecesTableau
            pieces={dossier.pieces}
            fournisseurs={tiers.etat === "ok" ? tiers.donnees.fournisseurs : []}
            chantiers={[c]}
            onEdit={ecrire ? setPiece : undefined}
          />
        </>
      )}
      <Modale ouverte={edition} titre="Modifier le chantier" onFermer={() => setEdition(false)}>
        {edition && tiers.etat === "ok" && (
          <FormulaireChantier
            initial={c}
            clients={tiers.donnees.clients}
            onFin={() => {
              setEdition(false);
              recharger();
            }}
          />
        )}
        {edition && tiers.etat !== "ok" && <Attente etat={tiers} onReessayer={tiers.recharger} />}
      </Modale>
      <Modale
        ouverte={piece !== undefined}
        titre={piece ? "Modifier la pièce" : "Nouvelle pièce de chantier"}
        onFermer={() => setPiece(undefined)}
      >
        {piece !== undefined && tiers.etat === "ok" && (
          <FormulairePiece
            initial={piece}
            chantierId={c.id}
            fournisseurs={tiers.donnees.fournisseurs}
            chantiers={[c]}
            recues={tiers.donnees.recues}
            onFin={() => {
              setPiece(undefined);
              recharger();
            }}
          />
        )}
        {piece !== undefined && tiers.etat !== "ok" && <Attente etat={tiers} onReessayer={tiers.recharger} />}
      </Modale>
    </>
  );
}
export function exporterAnalytique(d: DossierChantier) {
  const cell = (v: unknown) =>
    '"' +
    String(v ?? "")
      .replaceAll('"', '""')
      .replace(/^[=+@-]/, "'$&") +
    '"';
  const rows: unknown[][] = [
    ["Code chantier", "Chantier", "Segment", "Référence", "Date", "Statut", "HT EUR", "Inclus dans le solde"],
  ];
  for (const x of d.documents)
    rows.push([
      d.chantier.code,
      d.chantier.nom,
      "Vente",
      x.numero || "Brouillon",
      x.data.date,
      x.statut,
      ((x.type === "avoir" ? -1 : 1) * x.htCents) / 100,
      x.statut !== "brouillon" && x.type !== "devis" ? "Selon statut et avoirs" : "Non",
    ]);
  for (const x of d.achats)
    rows.push([
      d.chantier.code,
      d.chantier.nom,
      "Achat",
      x.numero,
      x.date,
      x.statut,
      x.facture?.devise === "EUR" ? ((x.facture.type === "avoir" ? -1 : 1) * x.facture.totaux.htCents) / 100 : "",
      x.statut === "validee" && x.facture?.devise === "EUR" ? "Oui" : "Non",
    ]);
  const contenu = "\uFEFF" + rows.map((r) => r.map(cell).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([contenu], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "analytique-" + d.chantier.code.replace(/[^\w-]/g, "_") + ".csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DetailFournisseur({ id }: { id: string }) {
  const { moi } = useSession();
  const ecrire = peut(moi.role, "ecrire");
  const [edition, setEdition] = useState(false);
  const d = useDonnees(async () => {
    const [dossier, chantiers] = await Promise.all([api.dossierFournisseur(id), api.chantiers()]);
    return { ...dossier, chantiers };
  }, [id]);
  useTitrePage(d.etat === "ok" ? d.donnees.fournisseur.nom : "Fournisseur");
  if (d.etat !== "ok")
    return (
      <div className="page">
        <Attente etat={d} onReessayer={d.recharger} />
      </div>
    );
  const { fournisseur: f, achats, pieces, chantiers } = d.donnees;
  return (
    <div className="page pile">
      <Lien href="/app/fournisseurs">← Tous les fournisseurs</Lien>
      <div className="page-entete">
        <div>
          <h1>{f.nom}</h1>
          <p className="attenue">
            {f.contact}
            {f.archive ? " · Archivé" : ""}
          </p>
        </div>
        {ecrire && (
          <Bouton icone={Pencil} onClick={() => setEdition(true)}>
            Modifier le fournisseur
          </Bouton>
        )}
      </div>
      <section className="carte grille grille-2">
        <div>
          <h2>Coordonnées</h2>
          <p>{f.adresse || "Adresse non renseignée"}</p>
          <p>{f.email || "E-mail non renseigné"}</p>
          <p>{f.telephone}</p>
          <p>SIRET : {f.siret || "—"}</p>
        </div>
        <div>
          <h2>Notes</h2>
          <p>{f.notes || "Aucune note."}</p>
          <p className="attenue">
            {achats.length} facture(s) classée(s) · {pieces.length} pièce(s) de chantier
          </p>
        </div>
      </section>
      <section className="pile">
        <h2>Factures reçues classées</h2>
        {achats.length ? (
          <div className="tableau-conteneur">
            <table className="tableau">
              <thead>
                <tr>
                  {["Facture", "Date", "Chantier", "TTC", "Statut"].map((t) => (
                    <th scope="col" key={t}>
                      {t}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {achats.map((r) => (
                  <tr key={r.id}>
                    <td data-libelle="Facture">
                      <a href={api.urlFichierRecu(r.id)} target="_blank" rel="noopener">
                        {r.numero || "Ouvrir le fichier"}
                      </a>
                    </td>
                    <td data-libelle="Date">{dateFr(r.date || "")}</td>
                    <td data-libelle="Chantier">
                      {r.chantierId ? (
                        <Lien href={"/app/chantiers/" + r.chantierId}>
                          {chantiers.find((c) => c.id === r.chantierId)?.nom || "Voir le chantier"}
                        </Lien>
                      ) : (
                        "Sans chantier"
                      )}
                    </td>
                    <td data-libelle="TTC" className="num">
                      {r.facture?.devise === "EUR" ? eur(r.ttcCents ?? 0) : "—"}
                    </td>
                    <td data-libelle="Statut">
                      {r.statut === "validee" ? "Validée" : r.statut === "rejetee" ? "Rejetée" : "À vérifier"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EtatVide titre="Aucune facture classée">
            <p>Utilisez « Classer » dans les factures reçues pour associer un achat à ce fournisseur.</p>
          </EtatVide>
        )}
        <Lien className="bouton" href="/app/achats">
          Ouvrir les factures reçues
        </Lien>
      </section>
      <section className="pile">
        <h2>Livraisons et commandes</h2>
        <PiecesTableau pieces={pieces} fournisseurs={[f]} chantiers={chantiers} />
        <Lien className="bouton" href={"/app/pieces?fournisseur=" + f.id}>
          Gérer les pièces du fournisseur
        </Lien>
      </section>
      <Modale ouverte={edition} titre="Modifier le fournisseur" onFermer={() => setEdition(false)}>
        {edition && (
          <FormulaireFournisseur
            initial={f}
            onFin={() => {
              setEdition(false);
              d.recharger();
            }}
          />
        )}
      </Modale>
    </div>
  );
}
