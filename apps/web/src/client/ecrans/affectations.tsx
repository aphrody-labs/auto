import { useState, type FormEvent } from "react";
import { api, ErreurApi } from "@auto/client";
import {
  Bouton,
  ChampListe,
  EtatChargement,
  EtatErreur,
  Lien,
  Modale,
  ResumeErreurs,
  useDonnees,
  useToast,
} from "@auto/ui/react";
import { peut, useSession } from "../session";
/** Classement indépendant du contenu comptable figé. */
export function AffectationDocument({ id, clientId }: { id: string; clientId: string | null }) {
  const { moi } = useSession();
  const ecrire = peut(moi.role, "ecrire");
  const d = useDonnees(async () => {
    const [affectation, chantiers] = await Promise.all([api.affectationDocument(id), api.chantiers()]);
    return { affectation, chantiers };
  }, [id]);
  const [edition, setEdition] = useState(false);
  const [choix, setChoix] = useState("");
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const toast = useToast();
  async function sauver(e: FormEvent) {
    e.preventDefault();
    setEnvoi(true);
    setErreur(null);
    try {
      await api.affecterDocument(id, choix || null);
      setEdition(false);
      d.recharger();
      toast("Affectation chantier enregistrée");
    } catch (e) {
      setErreur(e as ErreurApi);
    } finally {
      setEnvoi(false);
    }
  }
  return (
    <section className="carte chantier-affectation">
      <h2>Chantier et analytique</h2>
      {d.etat === "chargement" ? (
        <EtatChargement lignes={1} />
      ) : d.etat === "erreur" ? (
        <EtatErreur message={d.erreur} onReessayer={d.recharger} />
      ) : (
        <>
          <div className="rangee">
            {d.donnees.affectation.chantierId ? (
              <Lien href={"/app/chantiers/" + d.donnees.affectation.chantierId}>
                {d.donnees.chantiers.find((c) => c.id === d.donnees.affectation.chantierId)?.nom || "Voir le chantier"}
              </Lien>
            ) : (
              <span className="attenue">Aucun chantier affecté</span>
            )}
            {ecrire && (
              <Bouton
                onClick={() => {
                  setChoix(d.donnees.affectation.chantierId || "");
                  setEdition(true);
                }}
              >
                Modifier l’affectation
              </Bouton>
            )}
          </div>
          {edition && (
            <form className="grille grille-2" onSubmit={sauver}>
              <ResumeErreurs erreur={erreur} />
              <ChampListe
                libelle="Chantier du client"
                aide={
                  !clientId ? "Le document doit utiliser une fiche client enregistrée pour être affecté." : undefined
                }
                value={choix}
                onChange={(e) => setChoix(e.target.value)}
              >
                <option value="">Sans chantier</option>
                {d.donnees.chantiers
                  .filter((c) => c.clientId === clientId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} · {c.nom}
                      {c.archive ? " (archivé)" : ""}
                    </option>
                  ))}
              </ChampListe>
              <div className="rangee">
                <Bouton onClick={() => setEdition(false)}>Annuler</Bouton>
                <Bouton type="submit" variante="primaire" chargement={envoi}>
                  Enregistrer
                </Bouton>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
export function ClasserAchat({ id, onFin }: { id: string; onFin: () => void }) {
  const d = useDonnees(async () => {
    const [affectation, fournisseurs, chantiers] = await Promise.all([
      api.affectationAchat(id),
      api.fournisseurs(),
      api.chantiers(),
    ]);
    return { affectation, fournisseurs, chantiers };
  }, [id]);
  return (
    <Modale ouverte titre="Classer la facture reçue" onFermer={onFin}>
      {d.etat === "ok" ? (
        <FormulaireAffectation id={id} donnees={d.donnees} onFin={onFin} />
      ) : d.etat === "erreur" ? (
        <EtatErreur message={d.erreur} onReessayer={d.recharger} />
      ) : (
        <EtatChargement />
      )}
    </Modale>
  );
}
function FormulaireAffectation({
  id,
  donnees,
  onFin,
}: {
  id: string;
  donnees: {
    affectation: Awaited<ReturnType<typeof api.affectationAchat>>;
    fournisseurs: Awaited<ReturnType<typeof api.fournisseurs>>;
    chantiers: Awaited<ReturnType<typeof api.chantiers>>;
  };
  onFin: () => void;
}) {
  const [f, setF] = useState(donnees.affectation?.fournisseurId || "");
  const [c, setC] = useState(donnees.affectation?.chantierId || "");
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const toast = useToast();
  return (
    <form
      className="grille"
      onSubmit={async (e) => {
        e.preventDefault();
        setEnvoi(true);
        setErreur(null);
        try {
          await api.affecterAchat(id, f, c || null);
          toast("Facture classée");
          onFin();
        } catch (e) {
          setErreur(e as ErreurApi);
        } finally {
          setEnvoi(false);
        }
      }}
    >
      <ResumeErreurs erreur={erreur} />
      <ChampListe libelle="Fournisseur" requis value={f} onChange={(e) => setF(e.target.value)}>
        <option value="">Choisir un fournisseur</option>
        {donnees.fournisseurs.map((f) => (
          <option key={f.id} value={f.id}>
            {f.nom}
            {f.archive ? " (archivé)" : ""}
          </option>
        ))}
      </ChampListe>
      {!donnees.fournisseurs.length && (
        <p>
          Ajoutez une fiche dans <Lien href="/app/fournisseurs">Fournisseurs</Lien>.
        </p>
      )}
      <ChampListe
        libelle="Chantier"
        aide="Seuls les achats validés en EUR entrent dans le solde analytique."
        value={c}
        onChange={(e) => setC(e.target.value)}
      >
        <option value="">Sans chantier</option>
        {donnees.chantiers.map((c) => (
          <option key={c.id} value={c.id}>
            {c.code} · {c.nom}
          </option>
        ))}
      </ChampListe>
      <div className="rangee">
        <Bouton onClick={onFin}>Annuler</Bouton>
        <Bouton variante="primaire" type="submit" chargement={envoi} disabled={!donnees.fournisseurs.length}>
          Enregistrer le classement
        </Bouton>
      </div>
    </form>
  );
}
