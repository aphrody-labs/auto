import { FileDown, FileSpreadsheet, Landmark } from "@auto/ui/symboles";
import { useState } from "react";
import { api } from "@auto/client";
import { aujourdhui } from "@auto/ui/format";
import { Bandeau, ChampTexte, useTitrePage } from "@auto/ui/react";
import { useSession } from "../session";
import { accesSegment } from "@auto/tenancy/segments";

export function Exports() {
  const { moi } = useSession();
  useTitrePage("Exports");
  const jour = aujourdhui();
  const [du, setDu] = useState(`${jour.slice(0, 4)}-01-01`);
  const [au, setAu] = useState(`${jour.slice(0, 4)}-12-31`);
  const [arrete, setArrete] = useState(jour);
  const invalide = !du || !au || au < du;

  const lien = (href: string, Icone: typeof FileDown, texte: string, desactive = false) =>
    desactive ? (
      <span className="bouton" aria-disabled="true">
        <Icone className="icone" aria-hidden="true" />
        {texte}
      </span>
    ) : (
      <a className="bouton" href={href} download>
        <Icone className="icone" aria-hidden="true" />
        {texte}
      </a>
    );

  return (
    <div className="page">
      <div className="page-entete">
        <h1>Exports comptables</h1>
      </div>

      {accesSegment(moi, "clients") && (
        <>
          <section className="carte grille" aria-labelledby="sec-periode">
            <h2 id="sec-periode">Journal des ventes et FEC</h2>
            <div className="grille grille-2">
              <ChampTexte libelle="Du" type="date" value={du} onChange={(e) => setDu(e.target.value)} />
              <ChampTexte
                libelle="Au"
                type="date"
                value={au}
                erreur={invalide ? "La fin de période doit suivre le début." : null}
                onChange={(e) => setAu(e.target.value)}
              />
            </div>
            <div className="rangee">
              {lien(api.urlExport("ventes.xlsx", { du, au }), FileSpreadsheet, "Journal des ventes (xlsx)", invalide)}
              {lien(api.urlExport("fec", { du, au }), Landmark, "Fichier des écritures comptables (FEC)", invalide)}
            </div>
            <p className="attenue petit">
              FEC conforme à l'article A47 A-1 du LPF : encodage ISO 8859-15, écritures équilibrées contrôlées avant
              export.
            </p>
          </section>

          <section className="carte grille" aria-labelledby="sec-creances">
            <h2 id="sec-creances">Créances clients</h2>
            <ChampTexte libelle="Arrêtées au" type="date" value={arrete} onChange={(e) => setArrete(e.target.value)} />
            <div>{lien(api.urlExport("creances.xlsx", { au: arrete }), FileDown, "Créances (xlsx)")}</div>
          </section>
        </>
      )}
      <section className="carte grille" aria-labelledby="sec-gestion">
        <h2 id="sec-gestion">Les cinq espaces de gestion</h2>
        <p>
          Un classeur avec les onglets autorisés : comptabilité fournisseurs, comptabilité clients, analytique
          chantiers, bons de livraison et confirmations de commande.
        </p>
        <div className="rangee">
          {lien(api.url("/v1/exports/gestion.xlsx"), FileSpreadsheet, "Classeur complet (Excel)")}
          {lien(api.url("/v1/exports/gestion.pdf"), FileDown, "Rapport des données (PDF)")}
        </div>
        <p className="attenue petit">
          Toutes les données enregistrées sont reprises, archives comprises ; brouillons et statuts sont indiqués. Le
          PDF est un rapport des données, sans reproduire la mise en page d’un classeur Excel existant.
        </p>
      </section>

      <Bandeau>
        <p>Les fichiers sont produits à la demande à partir des documents émis ; les brouillons n'y figurent jamais.</p>
      </Bandeau>
    </div>
  );
}
