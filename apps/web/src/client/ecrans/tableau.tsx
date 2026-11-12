import { BadgeEuro, ClockAlert, FilePlus2, Landmark, Percent, ReceiptText } from "@auto/ui/symboles";
import type { Symbole } from "@auto/ui/symboles";
import { api } from "@auto/client";
import { aujourdhui, dateFr, eur, indicateurs, moisFr, nombre } from "@auto/ui/format";
import { useSession } from "../session";
import { EtatChargement, EtatErreur, EtatVide, Lien, useDonnees, useTitrePage } from "@auto/ui/react";
import { TableauDocuments } from "./liste";

function Kpi({
  icone: Icone,
  libelle,
  valeur,
  detail,
}: {
  icone: Symbole;
  libelle: string;
  valeur: string;
  detail?: string;
}) {
  return (
    <section className="carte kpi" aria-label={libelle}>
      <span className="kpi-libelle">
        <Icone className="icone icone-sm" aria-hidden="true" />
        {libelle}
      </span>
      <span className="kpi-valeur">{valeur}</span>
      {detail && <span className="kpi-detail">{detail}</span>}
    </section>
  );
}

export function TableauDeBord() {
  useTitrePage("Tableau de bord");
  const { moi } = useSession();
  const jour = aujourdhui();
  const d = useDonnees(async () => {
    const [docs, relances] = await Promise.all([api.documents(), api.aRelancer(jour)]);
    return { docs, relances };
  });

  let corps;
  if (d.etat === "chargement") corps = <EtatChargement />;
  else if (d.etat === "erreur") corps = <EtatErreur message={d.erreur} onReessayer={d.recharger} />;
  else if (d.donnees.docs.length === 0)
    corps = (
      <EtatVide icone={ReceiptText} titre="Créez votre premier devis">
        <p>
          Un devis accepté se transforme en facture en un clic ; les indicateurs apparaissent dès la première émission.
        </p>
        <div className="rangee">
          <Lien className="bouton bouton-primaire" href="/app/documents/nouveau?type=devis">
            Créer un devis
          </Lien>
          <Lien className="bouton" href="/app/documents/nouveau?type=facture">
            Créer une facture
          </Lien>
        </div>
      </EtatVide>
    );
  else {
    const { docs, relances } = d.donnees;
    const restes = Object.fromEntries(relances.map((r) => [r.documentId, r.resteCents]));
    const k = indicateurs(
      docs.map((x) => ({ ...x, data: x.data })),
      jour,
      restes,
    );
    const brouillons = docs.filter((x) => x.statut === "brouillon");
    corps = (
      <>
        <div className="kpis">
          <Kpi
            icone={BadgeEuro}
            libelle={`Chiffre d'affaires HT, ${moisFr(jour)}`}
            valeur={eur(k.caMoisHtCents)}
            detail="Factures et acomptes émis, avoirs déduits"
          />
          <Kpi
            icone={Landmark}
            libelle="Impayés"
            valeur={eur(k.impayesCents)}
            detail={`${nombre(k.impayes)} ${k.impayes > 1 ? "factures" : "facture"} à encaisser`}
          />
          <Kpi
            icone={ClockAlert}
            libelle="En retard"
            valeur={eur(k.enRetardCents)}
            detail={`${nombre(k.enRetard)} ${k.enRetard > 1 ? "factures échues" : "facture échue"}`}
          />
          <Kpi
            icone={Percent}
            libelle={`TVA collectée, ${moisFr(jour)}`}
            valeur={eur(k.tvaMoisCents)}
            detail={moi.entreprise.franchiseTva ? "Franchise en base de TVA" : "Avoirs déduits"}
          />
        </div>

        <section className="carte pile-serree" aria-labelledby="a-relancer">
          <h2 id="a-relancer">À relancer</h2>
          {relances.length === 0 ? (
            <p className="attenue">Aucune facture échue à relancer aujourd'hui.</p>
          ) : (
            <div className="tableau-conteneur">
              <table className="tableau">
                <thead>
                  <tr>
                    <th scope="col">Numéro</th>
                    <th scope="col">Client</th>
                    <th scope="col">Échéance</th>
                    <th scope="col" className="num">
                      Retard
                    </th>
                    <th scope="col" className="num">
                      Reste dû
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {relances.map((r) => (
                    <tr key={r.documentId}>
                      <td data-libelle="Numéro">
                        <Lien href={`/app/documents/${r.documentId}`}>{r.numero}</Lien>
                      </td>
                      <td data-libelle="Client">{r.client.nom}</td>
                      <td data-libelle="Échéance" className="num">
                        {dateFr(r.echeance)}
                      </td>
                      <td data-libelle="Retard" className="num">
                        {nombre(r.joursRetard)} j, palier {r.niveau}
                      </td>
                      <td data-libelle="Reste dû" className="num">
                        {eur(r.resteCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {brouillons.length > 0 && (
          <section className="pile-serree" aria-labelledby="brouillons">
            <h2 id="brouillons">Brouillons à terminer</h2>
            <TableauDocuments docs={brouillons} jour={jour} />
          </section>
        )}
      </>
    );
  }

  return (
    <div className="page">
      <div className="page-entete">
        <h1>Tableau de bord</h1>
        <Lien className="bouton bouton-primaire" href="/app/documents/nouveau?type=facture">
          <FilePlus2 className="icone" aria-hidden="true" />
          Nouvelle facture
        </Lien>
      </div>
      {corps}
    </div>
  );
}
