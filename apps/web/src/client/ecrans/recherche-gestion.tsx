import { useDeferredValue, useState } from "react";
import { api } from "@auto/client";
import { ChampTexte, EtatChargement, EtatErreur, EtatVide, Lien, useDonnees, useTitrePage } from "@auto/ui/react";
import { Search } from "@auto/ui/symboles";
const LIBELLES: Record<string, string> = {
  devis: "Devis",
  facture: "Facture client",
  acompte: "Acompte",
  avoir: "Avoir",
  achat: "Facture fournisseur",
  bon_livraison: "Bon de livraison",
  confirmation_commande: "Confirmation de commande",
  chantier: "Chantier",
  devis_recu: "Devis reçu",
  fichier_clients: "Fichier clients",
  fichier_fournisseurs: "Fichier fournisseurs",
  fichier_chantiers: "Fichier chantier",
  fichier_livraisons: "Fichier livraison",
  fichier_commandes: "Fichier commande",
};
export function RechercheGestion() {
  useTitrePage("Rechercher un document");
  const [q, setQ] = useState("");
  const recherche = useDeferredValue(q.trim());
  const d = useDonnees(
    () => (recherche.length >= 2 ? api.rechercherGestion(recherche) : Promise.resolve({ resultats: [], total: 0 })),
    [recherche],
  );
  return (
    <div className="page pile">
      <div className="page-entete">
        <div>
          <h1>Rechercher un document</h1>
          <p className="attenue">
            Retrouvez vos pièces par référence, tiers, chantier ou contenu extrait, archives comprises.
          </p>
        </div>
      </div>
      <ChampTexte
        libelle="Votre recherche"
        type="search"
        value={q}
        minLength={2}
        maxLength={200}
        placeholder="Ex. Moreau, ciment, BL-042…"
        onChange={(e) => setQ(e.target.value)}
      />
      {recherche.length < 2 ? (
        <EtatVide icone={Search} titre="Que recherchez-vous ?">
          <p>Saisissez au moins deux caractères. La recherche porte sur les documents connus d’auto.</p>
        </EtatVide>
      ) : d.etat === "chargement" ? (
        <EtatChargement />
      ) : d.etat === "erreur" ? (
        <EtatErreur message={d.erreur} onReessayer={d.recharger} />
      ) : !d.donnees.resultats.length ? (
        <EtatVide titre="Aucune pièce trouvée">
          <p>Essayez un nom de client, un fournisseur ou une désignation de ligne.</p>
        </EtatVide>
      ) : (
        <>
          <p className="attenue">
            {d.donnees.total} résultat(s)
            {d.donnees.total > 100 ? " · Les 100 premiers sont affichés. Affinez votre recherche." : ""}
          </p>
          <div className="tableau-conteneur" tabIndex={0} role="region" aria-label="Résultats de recherche">
            <table className="tableau">
              <thead>
                <tr>
                  {["Référence", "Espace", "Tiers", "Chantier", "Archive"].map((l) => (
                    <th scope="col" key={l}>
                      {l}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.donnees.resultats.map((r) => (
                  <tr key={r.segment + r.id}>
                    <td data-libelle="Référence">
                      {r.url.startsWith("/v1/") ? (
                        <a href={r.url} target="_blank" rel="noopener">
                          {r.reference}
                        </a>
                      ) : (
                        <Lien href={r.url}>{r.reference}</Lien>
                      )}
                    </td>
                    <td data-libelle="Espace">{LIBELLES[r.segment] || r.segment}</td>
                    <td data-libelle="Tiers">{r.tiers || "—"}</td>
                    <td data-libelle="Chantier">{r.chantier || "—"}</td>
                    <td data-libelle="Archive">{r.archive ? "Archivé" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
