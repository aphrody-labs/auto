//! EN 16931 / Factur-X CII D16B XML generator from `auto_model::Document`.

use crate::FacturxError;
use auto_model::{Document, DocumentType, round_js};
use std::fmt::Write as _;

const PROFILE_EN16931: &str = "urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:en16931";

/// Generates an EN 16931 Cross Industry Invoice (D16B) XML string for `Invoice`, `Deposit`, or `CreditNote`.
pub fn generate_cii_xml(doc: &Document) -> Result<String, FacturxError> {
    let type_code = doc.doc_type.untdid_code().ok_or(FacturxError::QuoteNotAllowed)?;
    if doc.doc_type == DocumentType::Quote {
        return Err(FacturxError::QuoteNotAllowed);
    }

    let totals = doc.totals();
    let issue_102 = date_102(&doc.date)?;
    let delivery_102 = match doc.service_date.as_deref() {
        Some(d) => date_102(d)?,
        None => issue_102.clone(),
    };
    let due_102 = doc.due_date.as_deref().map(date_102).transpose()?;

    let mut xml = String::with_capacity(4096);
    xml.push_str(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <rsm:CrossIndustryInvoice \
         xmlns:qdt=\"urn:un:unece:uncefact:data:standard:QualifiedDataType:100\" \
         xmlns:ram=\"urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100\" \
         xmlns:rsm=\"urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100\" \
         xmlns:udt=\"urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100\">\n",
    );

    xml.push_str(
        "  <rsm:ExchangedDocumentContext>\n\
         \x20   <ram:GuidelineSpecifiedDocumentContextParameter>\n\
         \x20     <ram:ID>",
    );
    xml.push_str(PROFILE_EN16931);
    xml.push_str(
        "</ram:ID>\n    </ram:GuidelineSpecifiedDocumentContextParameter>\n  </rsm:ExchangedDocumentContext>\n",
    );

    xml.push_str("  <rsm:ExchangedDocument>\n");
    let _ = writeln!(xml, "    <ram:ID>{}</ram:ID>", escape_xml(&doc.number));
    let _ = writeln!(xml, "    <ram:TypeCode>{type_code}</ram:TypeCode>");
    let _ = writeln!(
        xml,
        "    <ram:IssueDateTime><udt:DateTimeString format=\"102\">{issue_102}</udt:DateTimeString></ram:IssueDateTime>"
    );
    if let Some(notes) = doc.notes.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let _ =
            writeln!(xml, "    <ram:IncludedNote><ram:Content>{}</ram:Content></ram:IncludedNote>", escape_xml(notes));
    }
    xml.push_str("  </rsm:ExchangedDocument>\n");

    xml.push_str("  <rsm:SupplyChainTradeTransaction>\n");

    // Line items (BT-126 .. BT-156).
    for (idx, line) in doc.lines.iter().enumerate() {
        let gross = round_js(line.quantity * line.unit_price_excl_vat_cents as f64);
        let net = line.net_excl_vat_cents();
        let line_discount = gross - net;
        let line_rate = if doc.vat_exempt { 0 } else { line.vat };
        let cat = if doc.vat_exempt { "E" } else { "S" };
        let unit_code = unit_to_unece(line.unit.as_deref());

        xml.push_str("    <ram:IncludedSupplyChainTradeLineItem>\n");
        let _ = writeln!(
            xml,
            "      <ram:AssociatedDocumentLineDocument><ram:LineID>{}</ram:LineID></ram:AssociatedDocumentLineDocument>",
            idx + 1
        );
        let _ = writeln!(
            xml,
            "      <ram:SpecifiedTradeProduct><ram:Name>{}</ram:Name></ram:SpecifiedTradeProduct>",
            escape_xml(&line.description)
        );
        xml.push_str("      <ram:SpecifiedLineTradeAgreement>\n");
        let _ = writeln!(
            xml,
            "        <ram:NetPriceProductTradePrice><ram:ChargeAmount>{}</ram:ChargeAmount></ram:NetPriceProductTradePrice>",
            format_cents(line.unit_price_excl_vat_cents)
        );
        xml.push_str("      </ram:SpecifiedLineTradeAgreement>\n");
        let _ = writeln!(
            xml,
            "      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode=\"{unit_code}\">{}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>",
            format_qty(line.quantity)
        );
        xml.push_str("      <ram:SpecifiedLineTradeSettlement>\n");
        let _ = writeln!(
            xml,
            "        <ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>{cat}</ram:CategoryCode><ram:RateApplicablePercent>{}</ram:RateApplicablePercent></ram:ApplicableTradeTax>",
            format_rate(line_rate)
        );
        if line_discount > 0 {
            xml.push_str(
                "        <ram:SpecifiedTradeAllowanceCharge>\n\
                 \x20         <ram:ChargeIndicator><udt:Indicator>false</udt:Indicator></ram:ChargeIndicator>\n",
            );
            if let Some(bp) = line.discount_bp {
                let _ = writeln!(
                    xml,
                    "          <ram:CalculationPercent>{}</ram:CalculationPercent>",
                    format_cents_rate(i64::from(bp))
                );
            }
            let _ = writeln!(
                xml,
                "          <ram:ActualAmount>{}</ram:ActualAmount>\n\
                 \x20         <ram:Reason>Line discount</ram:Reason>\n\
                 \x20       </ram:SpecifiedTradeAllowanceCharge>",
                format_cents(line_discount)
            );
        }
        let _ = writeln!(
            xml,
            "        <ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>{}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>",
            format_cents(net)
        );
        xml.push_str("      </ram:SpecifiedLineTradeSettlement>\n");
        xml.push_str("    </ram:IncludedSupplyChainTradeLineItem>\n");
    }

    // Header agreement: Seller (BG-4) and Buyer (BG-7).
    xml.push_str("    <ram:ApplicableHeaderTradeAgreement>\n");
    write_party(&mut xml, "SellerTradeParty", &doc.issuer, true);
    write_party(&mut xml, "BuyerTradeParty", &doc.customer, false);
    xml.push_str("    </ram:ApplicableHeaderTradeAgreement>\n");

    // Header delivery (BG-13 / BT-72).
    xml.push_str("    <ram:ApplicableHeaderTradeDelivery>\n");
    if let Some(deliv) = doc.customer.delivery_address.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        xml.push_str("      <ram:ShipToTradeParty>\n");
        let _ = writeln!(xml, "        <ram:Name>{}</ram:Name>", escape_xml(&doc.customer.name));
        write_address(&mut xml, "        ", deliv);
        xml.push_str("      </ram:ShipToTradeParty>\n");
    }
    let _ = writeln!(
        xml,
        "      <ram:ActualDeliverySupplyChainEvent><ram:OccurrenceDateTime><udt:DateTimeString format=\"102\">{delivery_102}</udt:DateTimeString></ram:OccurrenceDateTime></ram:ActualDeliverySupplyChainEvent>"
    );
    xml.push_str("    </ram:ApplicableHeaderTradeDelivery>\n");

    // Header settlement: VAT breakdown (BG-23), payment terms, monetary summation (BG-22).
    xml.push_str("    <ram:ApplicableHeaderTradeSettlement>\n");
    xml.push_str("      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>\n");

    for tax in &totals.by_rate {
        let cat = if doc.vat_exempt { "E" } else { "S" };
        xml.push_str("      <ram:ApplicableTradeTax>\n");
        let _ = writeln!(xml, "        <ram:CalculatedAmount>{}</ram:CalculatedAmount>", format_cents(tax.vat_cents));
        xml.push_str("        <ram:TypeCode>VAT</ram:TypeCode>\n");
        if doc.vat_exempt {
            xml.push_str("        <ram:ExemptionReason>TVA non applicable, art. 293 B du CGI</ram:ExemptionReason>\n");
        }
        let _ = writeln!(xml, "        <ram:BasisAmount>{}</ram:BasisAmount>", format_cents(tax.base_excl_vat_cents));
        let _ = writeln!(xml, "        <ram:CategoryCode>{cat}</ram:CategoryCode>");
        let _ =
            writeln!(xml, "        <ram:RateApplicablePercent>{}</ram:RateApplicablePercent>", format_rate(tax.rate));
        xml.push_str("      </ram:ApplicableTradeTax>\n");
    }

    if doc.payment_terms.is_some() || due_102.is_some() {
        xml.push_str("      <ram:SpecifiedTradePaymentTerms>\n");
        if let Some(terms) = doc.payment_terms.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let _ = writeln!(xml, "        <ram:Description>{}</ram:Description>", escape_xml(terms));
        }
        if let Some(due) = due_102 {
            let _ = writeln!(
                xml,
                "        <ram:DueDateDateTime><udt:DateTimeString format=\"102\">{due}</udt:DateTimeString></ram:DueDateDateTime>"
            );
        }
        xml.push_str("      </ram:SpecifiedTradePaymentTerms>\n");
    }

    xml.push_str("      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>\n");
    let _ = writeln!(
        xml,
        "        <ram:LineTotalAmount>{}</ram:LineTotalAmount>",
        format_cents(totals.total_excl_vat_cents)
    );
    let _ = writeln!(
        xml,
        "        <ram:TaxBasisTotalAmount>{}</ram:TaxBasisTotalAmount>",
        format_cents(totals.total_excl_vat_cents)
    );
    let _ = writeln!(
        xml,
        "        <ram:TaxTotalAmount currencyID=\"EUR\">{}</ram:TaxTotalAmount>",
        format_cents(totals.total_vat_cents)
    );
    let _ = writeln!(
        xml,
        "        <ram:GrandTotalAmount>{}</ram:GrandTotalAmount>",
        format_cents(totals.total_incl_vat_cents)
    );
    let _ = writeln!(
        xml,
        "        <ram:DuePayableAmount>{}</ram:DuePayableAmount>",
        format_cents(totals.total_incl_vat_cents)
    );
    xml.push_str("      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>\n");
    xml.push_str("    </ram:ApplicableHeaderTradeSettlement>\n");
    xml.push_str("  </rsm:SupplyChainTradeTransaction>\n");
    xml.push_str("</rsm:CrossIndustryInvoice>\n");

    Ok(xml)
}

fn write_party(xml: &mut String, tag: &str, party: &auto_model::Party, is_seller: bool) {
    let _ = writeln!(xml, "      <ram:{tag}>");
    let _ = writeln!(xml, "        <ram:Name>{}</ram:Name>", escape_xml(&party.name));
    if let Some(tax_id) = party.tax_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let digits: String = tax_id.chars().filter(char::is_ascii_digit).collect();
        let legal_id = if digits.len() == 14 { &digits[..9] } else { tax_id };
        let _ = writeln!(
            xml,
            "        <ram:SpecifiedLegalOrganization><ram:ID schemeID=\"0002\">{}</ram:ID></ram:SpecifiedLegalOrganization>",
            escape_xml(legal_id)
        );
    }
    if is_seller && let Some(email) = party.email.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let _ = writeln!(
            xml,
            "        <ram:DefinedTradeContact><ram:EmailURIUniversalCommunication><ram:URIID>{}</ram:URIID></ram:EmailURIUniversalCommunication></ram:DefinedTradeContact>",
            escape_xml(email)
        );
    }
    write_address(xml, "        ", &party.address);
    if let Some(vat) = party.vat_number.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let _ = writeln!(
            xml,
            "        <ram:SpecifiedTaxRegistration><ram:ID schemeID=\"VA\">{}</ram:ID></ram:SpecifiedTaxRegistration>",
            escape_xml(vat)
        );
    }
    let _ = writeln!(xml, "      </ram:{tag}>");
}

fn write_address(xml: &mut String, indent: &str, raw: &str) {
    let lines: Vec<&str> = raw.lines().map(str::trim).filter(|s| !s.is_empty()).collect();
    let line_one = lines.first().copied().unwrap_or("");
    let tail = lines.get(1).copied().unwrap_or("");
    let (postcode, city) = parse_postcode_city(tail);
    let _ = writeln!(xml, "{indent}<ram:PostalTradeAddress>");
    if let Some(pc) = postcode {
        let _ = writeln!(xml, "{indent}  <ram:PostcodeCode>{}</ram:PostcodeCode>", escape_xml(pc));
    }
    if !line_one.is_empty() {
        let _ = writeln!(xml, "{indent}  <ram:LineOne>{}</ram:LineOne>", escape_xml(line_one));
    }
    if let Some(c) = city {
        let _ = writeln!(xml, "{indent}  <ram:CityName>{}</ram:CityName>", escape_xml(c));
    }
    let _ = writeln!(xml, "{indent}  <ram:CountryID>FR</ram:CountryID>");
    let _ = writeln!(xml, "{indent}</ram:PostalTradeAddress>");
}

fn parse_postcode_city(line: &str) -> (Option<&str>, Option<&str>) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return (None, None);
    }
    if let Some((first, rest)) = trimmed.split_once(' ')
        && first.chars().all(|c| c.is_ascii_digit())
        && (4..=6).contains(&first.len())
        && !rest.trim().is_empty()
    {
        return (Some(first), Some(rest.trim()));
    }
    (None, Some(trimmed))
}

fn date_102(iso: &str) -> Result<String, FacturxError> {
    let parts: Vec<&str> = iso.trim().split('-').collect();
    if parts.len() == 3
        && parts[0].len() == 4
        && parts[1].len() == 2
        && parts[2].len() == 2
        && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit()))
    {
        return Ok(format!("{}{}{}", parts[0], parts[1], parts[2]));
    }
    Err(FacturxError::InvalidDate(iso.to_owned()))
}

fn format_cents(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let abs = cents.unsigned_abs();
    format!("{sign}{}.{:02}", abs / 100, abs % 100)
}

fn format_cents_rate(bp: i64) -> String {
    format!("{}.{:02}", bp / 100, bp % 100)
}

fn format_rate(tenth_pct: u16) -> String {
    format!("{}.{:02}", tenth_pct / 10, (tenth_pct % 10) * 10)
}

fn format_qty(q: f64) -> String {
    if q.fract().abs() < 1e-6 { format!("{:.4}", q) } else { format!("{q:.4}") }
}

fn unit_to_unece(unit: Option<&str>) -> &'static str {
    match unit.map(|u| u.trim().to_ascii_lowercase()).as_deref() {
        Some("h" | "hr" | "hour" | "hours" | "heure" | "heures") => "HUR",
        Some("j" | "jour" | "jours" | "d" | "day" | "days") => "DAY",
        Some("m2" | "m²" | "sqm") => "MTK",
        Some("m" | "ml" | "meter" | "meters") => "MTR",
        Some("kg") => "KGM",
        _ => "C62",
    }
}

fn escape_xml(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}
