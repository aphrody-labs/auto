// Classement des messages reçus : facture (Factur-X ou PDF de facture) ou courrier ordinaire.
import type { PieceJointe } from "./mime";

export type Classement = "facture" | "autre";

const MOTS_FACTURE = /factur|invoice|avoir|rechnung/i;

const estPdf = (p: PieceJointe) =>
  p.type === "application/pdf" ||
  (p.nom.toLowerCase().endsWith(".pdf") && new TextDecoder().decode(p.octets.subarray(0, 5)) === "%PDF-");

/**
 * `estFacturx` reçoit les octets d'un PDF et dit s'il embarque un XML Factur-X (extraction Rust).
 * Une facture est reconnue par un Factur-X, ou par un PDF dont le nom ou le sujet parle de facture.
 */
export function classer(
  sujet: string,
  pieces: PieceJointe[],
  estFacturx: (pdf: Uint8Array) => boolean,
): { classement: Classement; facturx: boolean[] } {
  const facturx = pieces.map((p) => estPdf(p) && estFacturx(p.octets));
  const facture =
    facturx.some(Boolean) || pieces.some((p) => estPdf(p) && (MOTS_FACTURE.test(p.nom) || MOTS_FACTURE.test(sujet)));
  return { classement: facture ? "facture" : "autre", facturx };
}
