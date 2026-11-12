// Lecture directe du XML CII (EN 16931, Factur-X) vers le format normalisé.
import type { FactureRecue, LigneRecue } from "./facture";

interface Noeud {
  nom: string;
  attrs: Record<string, string>;
  enfants: Noeud[];
  texte: string;
}

const ENTITES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decoder = (s: string) =>
  s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : (ENTITES[e] ?? m),
  );

/** Analyseur XML minimal (éléments, attributs, texte ; préfixes d'espace de noms retirés). */
export function analyserXml(xml: string): Noeud {
  const racine: Noeud = { nom: "#", attrs: {}, enfants: [], texte: "" };
  const pile = [racine];
  const re =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const m of xml.matchAll(re)) {
    const haut = pile.at(-1)!;
    if (m[1] !== undefined) haut.texte += m[1];
    else if (m[6] !== undefined) haut.texte += decoder(m[6]);
    else if (m[3]) {
      const nom = m[3].replace(/^.*:/, "");
      if (m[2]) {
        if (pile.length > 1) pile.pop();
        continue;
      }
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? "").matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
        attrs[a[1]!.replace(/^.*:/, "")] = decoder(a[2] ?? a[3] ?? "");
      const n: Noeud = { nom, attrs, enfants: [], texte: "" };
      haut.enfants.push(n);
      if (!m[5]) pile.push(n);
    }
  }
  return racine;
}

/** Premier descendant suivant le chemin `A/B/C` (noms locaux). */
function trouver(n: Noeud | undefined, chemin: string): Noeud | undefined {
  let cur = n;
  for (const p of chemin.split("/")) {
    cur = cur?.enfants.find((e) => e.nom === p);
    if (!cur) return undefined;
  }
  return cur;
}

const tous = (n: Noeud | undefined, nom: string) => n?.enfants.filter((e) => e.nom === nom) ?? [];
const val = (n: Noeud | undefined, chemin: string) => trouver(n, chemin)?.texte.trim() || undefined;

/** Montant décimal (« 2182.16 ») → centimes, sans erreur d'arrondi binaire. */
export function centimes(s: string | undefined): number {
  if (!s) return 0;
  const m = /^(-?)(\d*)(?:[.,](\d*))?$/.exec(s.trim());
  if (!m) return Number.NaN;
  const dec = (m[3] ?? "").padEnd(3, "0");
  const c = Number(m[2] || "0") * 100 + Number(dec.slice(0, 2)) + (Number(dec[2]) >= 5 ? 1 : 0);
  return m[1] ? -c : c;
}

/** Date CII format 102 (AAAAMMJJ) → ISO. */
function date(n: Noeud | undefined, chemin: string): string | undefined {
  const s = val(n, `${chemin}/DateTimeString`);
  return s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : undefined;
}

const TYPES: Record<string, FactureRecue["type"]> = { "380": "facture", "381": "avoir", "386": "acompte" };

function partie(p: Noeud | undefined) {
  const org = trouver(p, "SpecifiedLegalOrganization/ID");
  const id = org?.texte.trim();
  const scheme = org?.attrs.schemeID;
  const siret = id && (scheme === "0009" || /^\d{14}$/.test(id)) ? id : undefined;
  const siren = siret?.slice(0, 9) ?? (id && /^\d{9}$/.test(id) ? id : undefined);
  const tva = tous(p, "SpecifiedTaxRegistration")
    .map((t) => trouver(t, "ID"))
    .find((i) => i?.attrs.schemeID === "VA")
    ?.texte.trim();
  const adr = trouver(p, "PostalTradeAddress");
  const adresse = adr
    ? ["LineOne", "LineTwo", "LineThree", "PostcodeCode", "CityName"]
        .map((k) => val(adr, k))
        .filter(Boolean)
        .join(", ") || undefined
    : undefined;
  return { nom: val(p, "Name") ?? "", siren, siret, tvaIntracom: tva, adresse };
}

/** XML CII → facture normalisée (null si ce n'est pas une CrossIndustryInvoice). */
export function lireCii(xml: string): FactureRecue | null {
  const cii = analyserXml(xml).enfants.find((e) => e.nom === "CrossIndustryInvoice");
  if (!cii) return null;
  const doc = trouver(cii, "ExchangedDocument");
  const tx = trouver(cii, "SupplyChainTradeTransaction");
  const accord = trouver(tx, "ApplicableHeaderTradeAgreement");
  const reglement = trouver(tx, "ApplicableHeaderTradeSettlement");
  const somme = trouver(reglement, "SpecifiedTradeSettlementHeaderMonetarySummation");

  const lignes: LigneRecue[] = tous(tx, "IncludedSupplyChainTradeLineItem").map((l) => {
    const qte = Number(val(l, "SpecifiedLineTradeDelivery/BilledQuantity") ?? "1");
    const prix = trouver(l, "SpecifiedLineTradeAgreement/NetPriceProductTradePrice");
    const base = Number(val(prix, "BasisQuantity") ?? "1") || 1;
    const taux = val(l, "SpecifiedLineTradeSettlement/ApplicableTradeTax/RateApplicablePercent");
    return {
      designation: val(l, "SpecifiedTradeProduct/Name") ?? "",
      quantite: qte,
      prixUnitaireHtCents: Math.round(centimes(val(prix, "ChargeAmount")) / base),
      tauxTva: Math.round(Number(taux ?? "0") * 10),
      htCents: centimes(
        val(l, "SpecifiedLineTradeSettlement/SpecifiedTradeSettlementLineMonetarySummation/LineTotalAmount"),
      ),
    };
  });

  const acheteur = partie(trouver(accord, "BuyerTradeParty"));
  const f = partie(trouver(accord, "SellerTradeParty"));
  const echeance = tous(reglement, "SpecifiedTradePaymentTerms")
    .map((t) => date(t, "DueDateDateTime"))
    .find(Boolean);
  const devise = val(reglement, "InvoiceCurrencyCode") ?? "EUR";
  // TaxTotalAmount peut figurer deux fois (devise de facture et devise de TVA).
  const tva = tous(somme, "TaxTotalAmount");
  const tvaFacture = (tva.find((t) => t.attrs.currencyID === devise) ?? tva[0])?.texte.trim();
  const r: FactureRecue = {
    type: TYPES[val(doc, "TypeCode") ?? "380"] ?? "facture",
    numero: val(doc, "ID") ?? "",
    date: date(doc, "IssueDateTime") ?? "",
    echeance,
    datePrestation: date(tx, "ApplicableHeaderTradeDelivery/ActualDeliverySupplyChainEvent/OccurrenceDateTime"),
    devise,
    fournisseur: f,
    acheteur: acheteur.nom ? { nom: acheteur.nom, siren: acheteur.siren } : undefined,
    lignes,
    totaux: {
      htCents: centimes(val(somme, "TaxBasisTotalAmount")),
      tvaCents: centimes(tvaFacture),
      ttcCents: centimes(val(somme, "GrandTotalAmount")),
    },
  };
  return JSON.parse(JSON.stringify(r)) as FactureRecue; // retire les champs undefined
}
