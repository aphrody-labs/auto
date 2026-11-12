import { useState, type FormEvent } from "react";
import { api, ErreurApi, type Chantier, type Fournisseur, type PieceChantier, type Recue } from "@auto/client";
import { totaux, type Ligne, type Tva } from "@auto/domain";
import { aujourdhui, dateFr, eur, TAUX_TVA, tauxTva, versCentimes } from "@auto/ui/format";
import { Package, Pencil, Plus, Trash2 } from "@auto/ui/symboles";
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
  parametre,
  useDonnees,
  useTitrePage,
  useToast,
} from "@auto/ui/react";
import { peut, useSession } from "../session";
import { accesSegment } from "@auto/tenancy/segments";
export const LIBELLE_PIECE = { bon_livraison: "Bon de livraison", confirmation_commande: "Confirmation de commande" };
const STATUT_PIECE = { a_verifier: "À vérifier", valide: "Validé", annule: "Annulé" };
export function PiecesChantier({ typePiece }: { typePiece?: PieceChantier["type"] } = {}) {
  const titre =
    typePiece === "bon_livraison"
      ? "Bons de livraison"
      : typePiece === "confirmation_commande"
        ? "Confirmations de commande"
        : "Livraisons et commandes";
  useTitrePage(titre);
  const { moi } = useSession();
  const ecrire = peut(moi.role, "ecrire");
  const [q, setQ] = useState(parametre("q") || "");
  const [type, setType] = useState(typePiece || "");
  const [fournisseur, setFournisseur] = useState(parametre("fournisseur") || "");
  const [archives, setArchives] = useState(parametre("archives") === "1");
  const [edition, setEdition] = useState<PieceChantier | null | undefined>();
  const d = useDonnees(async () => {
    const [pieces, fournisseurs, chantiers, recues] = await Promise.all([
      api.piecesChantier(),
      api.fournisseurs(),
      api.chantiers(),
      accesSegment(moi, "fournisseurs") ? api.recues() : Promise.resolve([]),
    ]);
    return { pieces, fournisseurs, chantiers, recues };
  });
  return (
    <div className="page pile">
      <div className="page-entete">
        <div>
          <h1>{titre}</h1>
          <p className="attenue">Classez les pièces, vérifiez les livraisons et rapprochez les factures.</p>
        </div>
        {ecrire && (
          <Bouton variante="primaire" icone={Plus} onClick={() => setEdition(null)}>
            Nouvelle pièce
          </Bouton>
        )}
      </div>
      <div className="grille grille-4">
        <ChampTexte libelle="Référence ou désignation" value={q} onChange={(e) => setQ(e.target.value)} />
        <ChampListe
          libelle="Type"
          disabled={!!typePiece}
          value={type}
          onChange={(e) => setType(e.target.value as typeof type)}
        >
          <option value="">Tous les types</option>
          {Object.entries(LIBELLE_PIECE).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </ChampListe>
        <ChampListe libelle="Fournisseur" value={fournisseur} onChange={(e) => setFournisseur(e.target.value)}>
          <option value="">Tous les fournisseurs</option>
          {d.etat === "ok" &&
            d.donnees.fournisseurs.map((f) => (
              <option value={f.id} key={f.id}>
                {f.nom}
              </option>
            ))}
        </ChampListe>
        <ChampListe
          libelle="Afficher"
          value={archives ? "archives" : "actifs"}
          onChange={(e) => setArchives(e.target.value === "archives")}
        >
          <option value="actifs">Pièces actives</option>
          <option value="archives">Pièces archivées</option>
        </ChampListe>
      </div>
      {d.etat === "ok" ? (
        <PiecesTableau
          pieces={d.donnees.pieces.filter(
            (p) =>
              p.archive === archives &&
              (!type || p.type === type) &&
              (!fournisseur || p.fournisseurId === fournisseur) &&
              [p.reference, ...p.lignes.map((l) => l.designation)].join(" ").toLowerCase().includes(q.toLowerCase()),
          )}
          fournisseurs={d.donnees.fournisseurs}
          chantiers={d.donnees.chantiers}
          onEdit={ecrire ? setEdition : undefined}
        />
      ) : d.etat === "erreur" ? (
        <EtatErreur message={d.erreur} onReessayer={d.recharger} />
      ) : (
        <EtatChargement />
      )}
      <Modale
        ouverte={edition !== undefined}
        titre={edition ? "Modifier la pièce" : "Nouvelle pièce de chantier"}
        onFermer={() => setEdition(undefined)}
      >
        {edition !== undefined && d.etat === "ok" && (
          <FormulairePiece
            typePiece={typePiece}
            initial={edition}
            fournisseurs={d.donnees.fournisseurs}
            chantiers={d.donnees.chantiers}
            recues={d.donnees.recues}
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
export function PiecesTableau({
  pieces,
  fournisseurs,
  chantiers,
  onEdit,
}: {
  pieces: PieceChantier[];
  fournisseurs: Fournisseur[];
  chantiers: Chantier[];
  onEdit?: (p: PieceChantier) => void;
}) {
  const { moi } = useSession();
  if (!pieces.length)
    return (
      <EtatVide icone={Package} titre="Aucune pièce trouvée">
        <p>Ajoutez un bon de livraison ou une confirmation de commande.</p>
      </EtatVide>
    );
  return (
    <div className="tableau-conteneur" role="region" aria-label="Pièces de chantier" tabIndex={0}>
      <table className="tableau">
        <thead>
          <tr>
            {["Pièce", "Fournisseur / Chantier", "Date", "Total HT", "Statut", "Actions"].map((x) => (
              <th scope="col" key={x}>
                {x}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pieces.map((p) => (
            <tr key={p.id}>
              <td data-libelle="Pièce">
                <details>
                  <summary>
                    <strong>{p.reference}</strong>
                    <span className="aide"> · {LIBELLE_PIECE[p.type]}</span>
                  </summary>
                  <ul>
                    {p.lignes.map((l, i) => (
                      <li key={i}>
                        {l.quantite} {l.unite} × {l.designation} · {eur(l.prixUnitaireHtCents)} HT
                      </li>
                    ))}
                  </ul>
                  <p>{p.notes}</p>
                  {p.recueId && accesSegment(moi, "fournisseurs") && (
                    <a href={api.urlFichierRecu(p.recueId)} target="_blank" rel="noopener">
                      Facture rapprochée (nouvel onglet)
                    </a>
                  )}
                </details>
              </td>
              <td data-libelle="Fournisseur / Chantier">
                {fournisseurs.find((f) => f.id === p.fournisseurId)?.nom || "—"}
                <div>
                  {accesSegment(moi, "chantiers") ? (
                    <Lien href={"/app/chantiers/" + p.chantierId}>
                      {chantiers.find((c) => c.id === p.chantierId)?.nom || "Voir le chantier"}
                    </Lien>
                  ) : (
                    <span>{chantiers.find((c) => c.id === p.chantierId)?.nom || "Chantier"}</span>
                  )}
                </div>
              </td>
              <td data-libelle="Date">{dateFr(p.date)}</td>
              <td data-libelle="Total HT" className="num">
                {eur(totaux(p.lignes).htCents)}
              </td>
              <td data-libelle="Statut">
                {STATUT_PIECE[p.statut]}
                {p.archive ? " · Archivé" : ""}
              </td>
              <td data-libelle="Actions">
                {onEdit && <Bouton icone={Pencil} aria-label={"Modifier " + p.reference} onClick={() => onEdit(p)} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
const ligneVide = (): Ligne => ({ designation: "", quantite: 1, prixUnitaireHtCents: 0, tva: 200, unite: "" });
export function FormulairePiece({
  typePiece,
  initial,
  chantierId,
  fournisseurs,
  chantiers,
  recues,
  onFin,
}: {
  typePiece?: PieceChantier["type"];
  initial: PieceChantier | null;
  chantierId?: string;
  fournisseurs: Fournisseur[];
  chantiers: Chantier[];
  recues: Recue[];
  onFin: () => void;
}) {
  const { moi } = useSession();
  const [p, setP] = useState<Omit<PieceChantier, "id">>(
    initial ?? {
      type: typePiece || "bon_livraison",
      reference: "",
      fournisseurId: "",
      chantierId: chantierId || "",
      recueId: null,
      date: aujourdhui(),
      statut: "a_verifier",
      lignes: [ligneVide()],
      notes: "",
      archive: false,
    },
  );
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const toast = useToast();
  const total = totaux(p.lignes);
  const ligne = (i: number, patch: Partial<Ligne>) =>
    setP({ ...p, lignes: p.lignes.map((l, j) => (i === j ? { ...l, ...patch } : l)) });
  async function sauver(e: FormEvent) {
    e.preventDefault();
    setEnvoi(true);
    setErreur(null);
    try {
      if (initial) await api.modifierPieceChantier(initial.id, p);
      else await api.creerPieceChantier(p);
      toast("Pièce de chantier enregistrée");
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
      <div className="grille grille-2">
        <ChampListe
          libelle="Type de pièce"
          disabled={!!typePiece}
          value={p.type}
          onChange={(e) => setP({ ...p, type: e.target.value as PieceChantier["type"] })}
        >
          {Object.entries(LIBELLE_PIECE).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </ChampListe>
        <ChampTexte
          libelle="Référence fournisseur"
          requis
          value={p.reference}
          onChange={(e) => setP({ ...p, reference: e.target.value })}
        />
        <ChampListe
          libelle="Fournisseur"
          requis
          value={p.fournisseurId}
          onChange={(e) => setP({ ...p, fournisseurId: e.target.value, recueId: null })}
        >
          <option value="">Sélectionner</option>
          {fournisseurs
            .filter((f) => !f.archive || f.id === p.fournisseurId)
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.nom}
              </option>
            ))}
        </ChampListe>
        <ChampListe
          libelle="Chantier"
          requis
          value={p.chantierId}
          onChange={(e) => setP({ ...p, chantierId: e.target.value, recueId: null })}
        >
          <option value="">Sélectionner</option>
          {chantiers
            .filter((c) => !c.archive || c.id === p.chantierId)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} · {c.nom}
              </option>
            ))}
        </ChampListe>
        <ChampTexte
          libelle="Date"
          type="date"
          requis
          value={p.date}
          onChange={(e) => setP({ ...p, date: e.target.value })}
        />
        <ChampListe
          libelle="Statut"
          value={p.statut}
          onChange={(e) => setP({ ...p, statut: e.target.value as PieceChantier["statut"] })}
        >
          {Object.entries(STATUT_PIECE).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </ChampListe>
      </div>
      {(!fournisseurs.length || !chantiers.length) && (
        <Bandeau>
          <p>Créez un fournisseur et un chantier avant d’enregistrer une pièce.</p>
        </Bandeau>
      )}
      <h3>Fournitures et prestations</h3>
      {p.lignes.map((l, i) => (
        <fieldset className="carte grille" key={i}>
          <legend>Ligne {i + 1}</legend>
          <ChampTexte
            libelle="Désignation"
            requis
            value={l.designation}
            onChange={(e) => ligne(i, { designation: e.target.value })}
          />
          <div className="grille grille-3">
            <ChampTexte
              libelle="Quantité"
              type="number"
              min="0.001"
              step="0.001"
              requis
              value={l.quantite}
              onChange={(e) => ligne(i, { quantite: Number(e.target.value) })}
            />
            <ChampTexte
              libelle="Prix unitaire HT (€)"
              type="number"
              min="0"
              step="0.01"
              requis
              value={l.prixUnitaireHtCents / 100}
              onChange={(e) => ligne(i, { prixUnitaireHtCents: versCentimes(e.target.value) ?? 0 })}
            />
            <ChampListe libelle="TVA" value={l.tva} onChange={(e) => ligne(i, { tva: Number(e.target.value) as Tva })}>
              {TAUX_TVA.map((v) => (
                <option value={v} key={v}>
                  {tauxTva(v)}
                </option>
              ))}
            </ChampListe>
          </div>
          <Bouton
            icone={Trash2}
            disabled={p.lignes.length === 1}
            onClick={() => setP({ ...p, lignes: p.lignes.filter((_, j) => j !== i) })}
          >
            Retirer la ligne {i + 1}
          </Bouton>
        </fieldset>
      ))}
      <Bouton icone={Plus} onClick={() => setP({ ...p, lignes: [...p.lignes, ligneVide()] })}>
        Ajouter une ligne
      </Bouton>
      <p className="chiffres">
        <strong>Total HT : {eur(total.htCents)}</strong> · TVA : {eur(total.tvaCents)} · TTC : {eur(total.ttcCents)}
      </p>
      {accesSegment(moi, "fournisseurs") && (
        <ChampListe
          libelle="Rapprocher d’une facture reçue"
          aide="Le fournisseur et le chantier doivent correspondre. Le montant de cette pièce n’est pas ajouté au montant facturé."
          value={p.recueId || ""}
          onChange={(e) => setP({ ...p, recueId: e.target.value || null })}
        >
          <option value="">Pas encore facturée</option>
          {recues.map((r) => (
            <option key={r.id} value={r.id}>
              {r.numero || "Sans référence"} · {r.fournisseur || "Fournisseur non lu"}
            </option>
          ))}
        </ChampListe>
      )}
      <ChampZone
        libelle="Notes / réserves de livraison"
        value={p.notes}
        onChange={(e) => setP({ ...p, notes: e.target.value })}
      />
      {initial && (
        <label className="rangee">
          <input type="checkbox" checked={p.archive} onChange={(e) => setP({ ...p, archive: e.target.checked })} />
          Pièce archivée (calculs et rapprochement conservés)
        </label>
      )}
      <div className="rangee">
        <Bouton onClick={onFin}>Annuler</Bouton>
        <Bouton
          type="submit"
          variante="primaire"
          chargement={envoi}
          disabled={!fournisseurs.length || !chantiers.length}
        >
          Enregistrer
        </Bouton>
      </div>
    </form>
  );
}
