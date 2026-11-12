//! XML CII EN 16931 (Factur-X 1.0, profil EN 16931). L'ordre des éléments suit le XSD D16B.

use crate::Erreur;
use auto_modele::{Facture, INDEMNITE, Ligne, MENTION_FRANCHISE, Partie, TypeDocument};
use std::fmt::Write;

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => o.push(c),
        }
    }
    o
}

/// Centimes → « 1234.50 ».
fn montant(c: i64) -> String {
    let s = if c < 0 { "-" } else { "" };
    format!("{s}{}.{:02}", c.abs() / 100, c.abs() % 100)
}

/// Dixièmes de % → « 20.00 », « 5.50 ».
fn taux(t: i64) -> String {
    format!("{}.{}0", t / 10, t % 10)
}

fn quantite(q: f64) -> String {
    let s = format!("{q:.4}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// « 2026-10-22 » → « 20261022 » (format 102).
fn date102(d: &str) -> Result<String, Erreur> {
    let s: String = d.chars().take(10).filter(char::is_ascii_digit).collect();
    if s.len() != 8 {
        return Err(Erreur::Invalide(format!("date invalide : {d}")));
    }
    Ok(s)
}

fn date_el(out: &mut String, tag: &str, d: &str) -> Result<(), Erreur> {
    let _ =
        write!(out, "<ram:{tag}><udt:DateTimeString format=\"102\">{}</udt:DateTimeString></ram:{tag}>", date102(d)?);
    Ok(())
}

fn categorie(f: &Facture, tva: i64) -> &'static str {
    if f.franchise_tva {
        "E"
    } else if tva == 0 {
        "Z"
    } else {
        "S"
    }
}

fn siren(siret: &str) -> Option<String> {
    let d: String = siret.chars().filter(char::is_ascii_digit).collect();
    (d.len() >= 9).then(|| d[..9].to_string())
}

fn partie(out: &mut String, tag: &str, p: &Partie, vendeur: bool) {
    let _ = write!(out, "<ram:{tag}><ram:Name>{}</ram:Name>", esc(&p.nom));
    if let Some(s) = siren(&p.siret) {
        let _ = write!(
            out,
            "<ram:SpecifiedLegalOrganization><ram:ID schemeID=\"0002\">{s}</ram:ID></ram:SpecifiedLegalOrganization>"
        );
    }
    let _ = write!(
        out,
        "<ram:PostalTradeAddress><ram:LineOne>{}</ram:LineOne><ram:CountryID>FR</ram:CountryID></ram:PostalTradeAddress>",
        esc(&p.adresse)
    );
    if let Some(e) = p.email.as_deref().filter(|e| !e.is_empty()) {
        let _ = write!(
            out,
            "<ram:URIUniversalCommunication><ram:URIID schemeID=\"EM\">{}</ram:URIID></ram:URIUniversalCommunication>",
            esc(e)
        );
    }
    match p.tva_intracom.as_deref().filter(|t| !t.is_empty()) {
        Some(t) => {
            let _ = write!(
                out,
                "<ram:SpecifiedTaxRegistration><ram:ID schemeID=\"VA\">{}</ram:ID></ram:SpecifiedTaxRegistration>",
                esc(t)
            );
        }
        // Vendeur en franchise : identifiant fiscal local (BR-E-02).
        None if vendeur && !p.siret.is_empty() => {
            let _ = write!(
                out,
                "<ram:SpecifiedTaxRegistration><ram:ID schemeID=\"FC\">{}</ram:ID></ram:SpecifiedTaxRegistration>",
                esc(&p.siret)
            );
        }
        None => {}
    }
    let _ = write!(out, "</ram:{tag}>");
}

/// Remise de ligne (BG-27) : montant = HT brut − HT net, motif obligatoire (BR-42).
fn remise(l: &Ligne) -> String {
    let montant_remise = l.brut_cents() - l.ht_cents();
    if l.remise_bp == 0 || montant_remise == 0 {
        return String::new();
    }
    format!(
        "<ram:SpecifiedTradeAllowanceCharge><ram:ChargeIndicator><udt:Indicator>false</udt:Indicator></ram:ChargeIndicator><ram:ActualAmount>{}</ram:ActualAmount><ram:Reason>Remise {}</ram:Reason></ram:SpecifiedTradeAllowanceCharge>",
        montant(montant_remise),
        esc(&auto_modele::pourcent_bp(l.remise_bp)),
    )
}

fn ligne(out: &mut String, f: &Facture, i: usize, l: &Ligne) {
    let ht = l.ht_cents();
    let _ = write!(
        out,
        "<ram:IncludedSupplyChainTradeLineItem>\
<ram:AssociatedDocumentLineDocument><ram:LineID>{}</ram:LineID></ram:AssociatedDocumentLineDocument>\
<ram:SpecifiedTradeProduct><ram:Name>{}</ram:Name></ram:SpecifiedTradeProduct>\
<ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>{}</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>\
<ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode=\"C62\">{}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>\
<ram:SpecifiedLineTradeSettlement><ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>{}</ram:CategoryCode><ram:RateApplicablePercent>{}</ram:RateApplicablePercent></ram:ApplicableTradeTax>{}\
<ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>{}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation></ram:SpecifiedLineTradeSettlement>\
</ram:IncludedSupplyChainTradeLineItem>",
        i + 1,
        esc(&l.designation),
        montant(l.prix_unitaire_ht_cents),
        quantite(l.quantite),
        categorie(f, l.tva),
        taux(l.tva),
        remise(l),
        montant(ht),
    );
}

fn note(out: &mut String, contenu: &str, code: &str) {
    let _ = write!(
        out,
        "<ram:IncludedNote><ram:Content>{}</ram:Content><ram:SubjectCode>{code}</ram:SubjectCode></ram:IncludedNote>",
        esc(contenu)
    );
}

/// XML CII EN 16931 d'une facture, d'un acompte ou d'un avoir émis.
pub fn xml(f: &Facture) -> Result<String, Erreur> {
    if f.numero.is_empty() {
        return Err(Erreur::Invalide("numéro manquant (document non émis)".into()));
    }
    if f.lignes.is_empty() {
        return Err(Erreur::Invalide("aucune ligne".into()));
    }
    let code = f.type_document().code().ok_or_else(|| Erreur::Invalide("un devis n'est pas une facture".into()))?;
    let t = f.totaux();
    let mut o = String::with_capacity(8192);
    o.push_str(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<rsm:CrossIndustryInvoice xmlns:rsm=\"urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100\" \
xmlns:qdt=\"urn:un:unece:uncefact:data:standard:QualifiedDataType:100\" \
xmlns:ram=\"urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100\" \
xmlns:udt=\"urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100\">\
<rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:cen.eu:en16931:2017</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>",
    );
    let _ =
        write!(o, "<rsm:ExchangedDocument><ram:ID>{}</ram:ID><ram:TypeCode>{}</ram:TypeCode>", esc(&f.numero), code);
    date_el(&mut o, "IssueDateTime", &f.date)?;
    if f.franchise_tva {
        note(&mut o, MENTION_FRANCHISE, "TXD");
    }
    if let Some(p) = &f.penalites_retard {
        note(&mut o, &format!("Pénalités de retard : {p}"), "PMD");
    }
    note(&mut o, INDEMNITE, "PMT");
    if let Some(e) = &f.escompte {
        note(&mut o, &format!("Escompte : {e}"), "AAB");
    }
    o.push_str("</rsm:ExchangedDocument><rsm:SupplyChainTradeTransaction>");
    for (i, l) in f.lignes.iter().enumerate() {
        ligne(&mut o, f, i, l);
    }
    o.push_str("<ram:ApplicableHeaderTradeAgreement>");
    partie(&mut o, "SellerTradeParty", &f.emetteur, true);
    partie(&mut o, "BuyerTradeParty", &f.client, false);
    o.push_str("</ram:ApplicableHeaderTradeAgreement><ram:ApplicableHeaderTradeDelivery>");
    if let Some(d) = &f.date_prestation {
        o.push_str("<ram:ActualDeliverySupplyChainEvent>");
        date_el(&mut o, "OccurrenceDateTime", d)?;
        o.push_str("</ram:ActualDeliverySupplyChainEvent>");
    }
    o.push_str(
        "</ram:ApplicableHeaderTradeDelivery><ram:ApplicableHeaderTradeSettlement><ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>",
    );
    for (tx, (base, tva)) in &t.par_taux {
        let cat = categorie(f, *tx);
        let _ = write!(
            o,
            "<ram:ApplicableTradeTax><ram:CalculatedAmount>{}</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode>",
            montant(*tva)
        );
        if cat == "E" {
            let _ = write!(o, "<ram:ExemptionReason>{MENTION_FRANCHISE}</ram:ExemptionReason>");
        }
        let _ = write!(
            o,
            "<ram:BasisAmount>{}</ram:BasisAmount><ram:CategoryCode>{cat}</ram:CategoryCode><ram:RateApplicablePercent>{}</ram:RateApplicablePercent></ram:ApplicableTradeTax>",
            montant(*base),
            taux(*tx)
        );
    }
    if f.echeance.is_some() || f.conditions_paiement.is_some() {
        o.push_str("<ram:SpecifiedTradePaymentTerms>");
        if let Some(c) = &f.conditions_paiement {
            let _ = write!(o, "<ram:Description>{}</ram:Description>", esc(c));
        }
        if let Some(e) = &f.echeance {
            date_el(&mut o, "DueDateDateTime", e)?;
        }
        o.push_str("</ram:SpecifiedTradePaymentTerms>");
    }
    let _ = write!(
        o,
        "<ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:LineTotalAmount>{ht}</ram:LineTotalAmount>\
<ram:TaxBasisTotalAmount>{ht}</ram:TaxBasisTotalAmount><ram:TaxTotalAmount currencyID=\"EUR\">{tva}</ram:TaxTotalAmount>\
<ram:GrandTotalAmount>{ttc}</ram:GrandTotalAmount><ram:DuePayableAmount>{ttc}</ram:DuePayableAmount>\
</ram:SpecifiedTradeSettlementHeaderMonetarySummation>",
        ht = montant(t.ht_cents),
        tva = montant(t.tva_cents),
        ttc = montant(t.ttc_cents),
    );
    if let Some(origine) = f.origine.as_deref().filter(|_| f.type_document() == TypeDocument::Avoir) {
        let _ = write!(
            o,
            "<ram:InvoiceReferencedDocument><ram:IssuerAssignedID>{}</ram:IssuerAssignedID></ram:InvoiceReferencedDocument>",
            esc(origine)
        );
    }
    o.push_str("</ram:ApplicableHeaderTradeSettlement></rsm:SupplyChainTradeTransaction></rsm:CrossIndustryInvoice>\n");
    Ok(o)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        assert_eq!(montant(123450), "1234.50");
        assert_eq!(montant(5), "0.05");
        assert_eq!(taux(200), "20.00");
        assert_eq!(taux(55), "5.50");
        assert_eq!(quantite(3.0), "3");
        assert_eq!(quantite(1.25), "1.25");
        assert_eq!(date102("2026-10-22").unwrap(), "20261022");
        assert_eq!(esc("a<b & \"c\""), "a&lt;b &amp; &quot;c&quot;");
    }
}
