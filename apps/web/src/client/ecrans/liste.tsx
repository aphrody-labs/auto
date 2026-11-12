import type { Type } from "@auto/domain";
import type { StatutVisuel } from "@auto/ui";
import { FilePlus2, FileText, Search } from "@auto/ui/symboles";
import { useMemo, useState } from "react";
import { api, type DocumentApi } from "@auto/client";
import { aujourdhui, dateFr, eur, LIBELLE_TYPE, libelleStatut, statutVisuel } from "@auto/ui/format";
import {
  BadgeStatut,
  ChampTexte,
  EtatChargement,
  EtatErreur,
  EtatVide,
  Lien,
  useDonnees,
  useTitrePage,
} from "@auto/ui/react";

export function TableauDocuments({ docs, jour = aujourdhui() }: { docs: DocumentApi[]; jour?: string }) {
  return (
    <div className="tableau-conteneur">
      <table className="tableau">
        <thead>
          <tr>
            <th scope="col">Numéro</th>
            <th scope="col">Type</th>
            <th scope="col">Client</th>
            <th scope="col">Date</th>
            <th scope="col">Échéance</th>
            <th scope="col" className="num">
              TTC
            </th>
            <th scope="col">Statut</th>
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => {
            const s = statutVisuel(d, jour);
            return (
              <tr key={d.id}>
                <td data-libelle="Numéro" className="chiffres">
                  <Lien href={`/app/documents/${d.id}`}>{d.numero ?? "Brouillon"}</Lien>
                </td>
                <td data-libelle="Type">{LIBELLE_TYPE[d.type]}</td>
                <td data-libelle="Client">{d.data.client.nom}</td>
                <td data-libelle="Date" className="num">
                  {dateFr(d.data.date)}
                </td>
                <td data-libelle="Échéance" className={`num ${s === "en_retard" ? "texte-danger" : ""}`}>
                  {dateFr(d.data.echeance) || "—"}
                </td>
                <td data-libelle="TTC" className="num">
                  {eur(d.type === "avoir" ? -d.ttcCents : d.ttcCents)}
                </td>
                <td data-libelle="Statut">
                  <BadgeStatut statut={s} libelle={libelleStatut(s, d.type)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type Filtre = "tous" | StatutVisuel;

const FILTRES: Record<"devis" | "factures" | "avoirs", Filtre[]> = {
  devis: ["tous", "brouillon", "emis", "envoye", "accepte", "refuse"],
  factures: ["tous", "brouillon", "emis", "envoye", "en_retard", "paye", "annule"],
  avoirs: ["tous", "brouillon", "emis"],
};

const TITRES = { devis: "Devis", factures: "Factures", avoirs: "Avoirs" };

/** Filtre d'une liste : statut (dérivé, « en retard » compris) et recherche sur numéro ou client. */
export function filtrer(docs: DocumentApi[], filtre: Filtre, q: string, jour = aujourdhui()) {
  const r = q.trim().toLowerCase();
  return docs.filter((d) => {
    if (filtre !== "tous" && statutVisuel(d, jour) !== filtre) return false;
    if (!r) return true;
    return (d.numero ?? "").toLowerCase().includes(r) || d.data.client.nom.toLowerCase().includes(r);
  });
}

export function ListeDocuments({ types }: { types: Type[] }) {
  const genre = types.includes("devis") ? "devis" : types.includes("avoir") ? "avoirs" : "factures";
  useTitrePage(TITRES[genre]);
  const jour = aujourdhui();
  const [filtre, setFiltre] = useState<Filtre>("tous");
  const [q, setQ] = useState("");
  const d = useDonnees(async () => (await Promise.all(types.map((t) => api.documents(t)))).flat(), [types.join()]);
  const type0 = types[0]!;
  const visibles = useMemo(() => (d.etat === "ok" ? filtrer(d.donnees, filtre, q, jour) : []), [d, filtre, q, jour]);

  const nouveau =
    genre === "avoirs" ? null : (
      <Lien className="bouton bouton-primaire" href={`/app/documents/nouveau?type=${type0}`}>
        <FilePlus2 className="icone" aria-hidden="true" />
        {genre === "devis" ? "Nouveau devis" : "Nouvelle facture"}
      </Lien>
    );

  let corps;
  if (d.etat === "chargement") corps = <EtatChargement />;
  else if (d.etat === "erreur") corps = <EtatErreur message={d.erreur} onReessayer={d.recharger} />;
  else if (d.donnees.length === 0)
    corps = (
      <EtatVide
        icone={FileText}
        titre={genre === "avoirs" ? "Aucun avoir" : `Aucun ${genre === "devis" ? "devis" : "facture"} pour l'instant`}
      >
        {genre === "avoirs" ? (
          <p>Un avoir se crée depuis une facture émise, pour l'annuler ou la corriger.</p>
        ) : (
          nouveau
        )}
      </EtatVide>
    );
  else
    corps = (
      <>
        <div className="rangee rangee-bas">
          <div className="onglets" role="group" aria-label="Filtrer par statut">
            {FILTRES[genre].map((f) => (
              <button key={f} type="button" className="onglet" aria-pressed={filtre === f} onClick={() => setFiltre(f)}>
                {f === "tous" ? "Tous" : libelleStatut(f, type0)}
              </button>
            ))}
          </div>
          <span className="espace" />
          <ChampTexte
            libelle="Rechercher"
            type="search"
            placeholder="Numéro ou client"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <p className="visuellement-cache" aria-live="polite">
          {visibles.length} {visibles.length > 1 ? "documents affichés" : "document affiché"}
        </p>
        {visibles.length === 0 ? (
          <EtatVide icone={Search} titre="Aucun document ne correspond">
            <p>Changez de filtre ou de recherche.</p>
          </EtatVide>
        ) : (
          <TableauDocuments docs={visibles} jour={jour} />
        )}
      </>
    );

  return (
    <div className="page">
      <div className="page-entete">
        <h1>{TITRES[genre]}</h1>
        {nouveau}
      </div>
      {corps}
    </div>
  );
}
