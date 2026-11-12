import { useState } from "react";
import { api, ErreurApi, type DevisRecu } from "@auto/client";
import { totaux, type Tva } from "@auto/domain";
import { accesSegment } from "@auto/tenancy/segments";
import { aujourdhui, eur, TAUX_TVA, tauxTva, versCentimes } from "@auto/ui/format";
import { Bouton, ChampTexte, ChampListe, ResumeErreurs, useDonnees, useToast } from "@auto/ui/react";
import { useSession } from "../session";
export function RevueDevis({ devis, ecrire, onFin }: { devis: DevisRecu; ecrire: boolean; onFin: () => void }) {
  const { moi } = useSession();
  const [data, setData] = useState<NonNullable<DevisRecu["data"]>>(
    devis.data ?? {
      type: "devis",
      numero: "",
      date: aujourdhui(),
      devise: "EUR",
      fournisseur: { nom: "", siret: "" },
      lignes: [{ designation: "", quantite: 1, prixUnitaireHtCents: 0, tauxTva: 200, htCents: 0 }],
      totaux: { htCents: 0, tvaCents: 0, ttcCents: 0 },
    },
  );
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const [client, setClient] = useState("");
  const [typeBrouillon, setTypeBrouillon] = useState<"devis" | "facture">("devis");
  const [valide, setValide] = useState(devis.statut === "valide");
  const toast = useToast();
  const clients = useDonnees(() => (accesSegment(moi, "clients") ? api.clients() : Promise.resolve([])));
  const bloque = !ecrire || !!devis.brouillonId || devis.statut === "rejete";
  function modifier(p: Partial<typeof data>) {
    setData({ ...data, ...p });
    setValide(false);
  }
  function ligne(i: number, p: Partial<(typeof data.lignes)[number]>) {
    recalculer(
      data.lignes
        .map((l, j) => (i === j ? { ...l, ...p } : l))
        .map((l) => ({ ...l, htCents: Math.round(l.quantite * l.prixUnitaireHtCents) })),
    );
  }
  function recalculer(lignes: typeof data.lignes) {
    const t = totaux(lignes.map((l) => ({ ...l, tva: l.tauxTva as Tva })));
    modifier({ lignes, totaux: { htCents: t.htCents, tvaCents: t.tvaCents, ttcCents: t.ttcCents } });
  }
  async function action(f: () => Promise<unknown>, fin = false) {
    setEnvoi(true);
    setErreur(null);
    try {
      await f();
      if (fin) onFin();
    } catch (e) {
      setErreur(e instanceof ErreurApi ? e : new ErreurApi((e as Error).message, 422));
    } finally {
      setEnvoi(false);
    }
  }
  return (
    <div className="grille">
      <ResumeErreurs erreur={erreur} />
      <div className="grille grille-2">
        <ChampTexte
          libelle="Référence du devis"
          requis
          disabled={bloque}
          value={data.numero}
          onChange={(e) => modifier({ numero: e.target.value })}
        />
        <ChampTexte
          libelle="Date du devis"
          type="date"
          requis
          disabled={bloque}
          value={data.date}
          onChange={(e) => modifier({ date: e.target.value })}
        />
        <ChampTexte
          libelle="Émetteur"
          requis
          disabled={bloque}
          value={data.fournisseur.nom}
          onChange={(e) => modifier({ fournisseur: { ...data.fournisseur, nom: e.target.value } })}
        />
        <ChampTexte
          libelle="SIRET de l’émetteur"
          disabled={bloque}
          value={data.fournisseur.siret || ""}
          onChange={(e) => modifier({ fournisseur: { ...data.fournisseur, siret: e.target.value } })}
        />
        <ChampTexte
          libelle="Adresse de l’émetteur"
          disabled={bloque}
          value={data.fournisseur.adresse || ""}
          onChange={(e) => modifier({ fournisseur: { ...data.fournisseur, adresse: e.target.value } })}
        />
        <ChampTexte
          libelle="TVA intracommunautaire"
          disabled={bloque}
          value={data.fournisseur.tvaIntracom || ""}
          onChange={(e) => modifier({ fournisseur: { ...data.fournisseur, tvaIntracom: e.target.value } })}
        />
      </div>
      <h3>Prestations détectées</h3>
      {data.lignes.map((l, i) => (
        <fieldset className="carte grille" key={i}>
          <legend>Ligne {i + 1}</legend>
          <ChampTexte
            libelle={`Désignation, ligne ${i + 1}`}
            requis
            disabled={bloque}
            value={l.designation}
            onChange={(e) => ligne(i, { designation: e.target.value })}
          />
          <div className="grille grille-3">
            <ChampTexte
              libelle={`Quantité, ligne ${i + 1}`}
              type="number"
              min="0.001"
              step="0.001"
              disabled={bloque}
              value={l.quantite}
              onChange={(e) => ligne(i, { quantite: Number(e.target.value) })}
            />
            <ChampTexte
              libelle={`Prix HT, ligne ${i + 1}`}
              type="number"
              min="0"
              step="0.01"
              disabled={bloque}
              value={l.prixUnitaireHtCents / 100}
              onChange={(e) => ligne(i, { prixUnitaireHtCents: versCentimes(e.target.value) ?? 0 })}
            />
            <ChampListe
              libelle={`TVA, ligne ${i + 1}`}
              disabled={bloque}
              value={l.tauxTva}
              onChange={(e) => ligne(i, { tauxTva: Number(e.target.value) })}
            >
              {TAUX_TVA.map((v) => (
                <option key={v} value={v}>
                  {tauxTva(v)}
                </option>
              ))}
            </ChampListe>
          </div>
          {!bloque && data.lignes.length > 1 && (
            <Bouton variante="danger" onClick={() => recalculer(data.lignes.filter((_, j) => j !== i))}>
              Supprimer la ligne {i + 1}
            </Bouton>
          )}
        </fieldset>
      ))}
      {!bloque && (
        <Bouton
          disabled={data.lignes.length >= 200}
          onClick={() =>
            recalculer([
              ...data.lignes,
              { designation: "", quantite: 1, prixUnitaireHtCents: 0, tauxTva: 200, htCents: 0 },
            ])
          }
        >
          Ajouter une prestation
        </Bouton>
      )}
      <p>
        <strong>Total détecté / corrigé : {eur(data.totaux.ttcCents)}</strong>
      </p>
      <details>
        <summary>Texte extrait du document</summary>
        <p className="texte-extrait">{devis.texte || "Aucun texte extrait."}</p>
      </details>
      {!bloque && (
        <>
          <div className="rangee">
            {devis.statut === "a_verifier" && (
              <Bouton
                disabled={envoi}
                onClick={() =>
                  action(async () => {
                    const d = await api.reextraireDevis(devis.id);
                    if (d.data) setData(d.data);
                    setValide(false);
                    toast(
                      d.anomalies.length
                        ? "Extraction relancée : des informations restent à vérifier"
                        : "Extraction terminée, vérifiez les informations",
                    );
                  })
                }
              >
                Relancer l’extraction
              </Bouton>
            )}
            <Bouton
              chargement={envoi}
              onClick={() =>
                action(async () => {
                  await api.deciderDevis(devis.id, "valide", data);
                  setValide(true);
                  toast("Informations validées");
                })
              }
            >
              Valider les informations
            </Bouton>
            <Bouton
              variante="danger"
              disabled={envoi}
              onClick={() => action(() => api.deciderDevis(devis.id, "rejete"), true)}
            >
              Rejeter le devis
            </Bouton>
          </div>
          {accesSegment(moi, "clients") && (
            <>
              <ChampListe
                libelle="Document à préparer"
                value={typeBrouillon}
                onChange={(e) => setTypeBrouillon(e.target.value as "devis" | "facture")}
              >
                <option value="devis">Devis client</option>
                <option value="facture">Facture client en brouillon</option>
              </ChampListe>
              <ChampListe
                libelle="Client pour le nouveau brouillon"
                value={client}
                onChange={(e) => setClient(e.target.value)}
              >
                <option value="">Choisir un client</option>
                {clients.etat === "ok" &&
                  clients.donnees.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nom}
                    </option>
                  ))}
              </ChampListe>
              <Bouton
                variante="primaire"
                disabled={!valide || !client || envoi}
                onClick={() =>
                  action(async () => {
                    const doc = await api.brouillonDevisRecu(devis.id, client, undefined, typeBrouillon);
                    toast("Brouillon prérempli créé");
                    location.assign("/app/documents/" + doc.id);
                  })
                }
              >
                Créer un brouillon client prérempli
              </Bouton>
            </>
          )}
        </>
      )}
      <Bouton onClick={onFin}>Fermer</Bouton>
    </div>
  );
}
