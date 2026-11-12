export const FORMATS_CRAFT = { word: "Word", excel: "Excel", pdf: "PDF" } as const;
export type MessageCraft =
  | { type: "pret" }
  | { type: "sale"; sale: boolean }
  | { type: "erreur"; message: string }
  | { type: "sauver"; nom: string; octets: Uint8Array<ArrayBuffer> };
/** Le nom du protocole ne remplace jamais la vérification de la fenêtre émettrice. */
export function messageCraft(
  e: Pick<MessageEvent, "source" | "origin" | "data">,
  fenetre: Window | null,
  prefixe: string,
  origine: string,
): MessageCraft | null {
  if (
    !fenetre ||
    origine === "null" ||
    e.origin !== origine ||
    e.source !== fenetre ||
    !e.data ||
    typeof e.data !== "object" ||
    Array.isArray(e.data)
  )
    return null;
  const d = e.data;
  if (d.type === prefixe + ":ready") return { type: "pret" };
  if (d.type === prefixe + ":dirty" && typeof d.dirty === "boolean") return { type: "sale", sale: d.dirty };
  if (d.type === prefixe + ":failed")
    return { type: "erreur", message: "L’éditeur n’a pas pu démarrer. Votre original est conservé." };
  if (d.type !== prefixe + ":save") return null;
  const b = d.bytes instanceof ArrayBuffer ? new Uint8Array(d.bytes) : d.bytes instanceof Uint8Array ? d.bytes : null;
  if (
    typeof d.name !== "string" ||
    !d.name.trim() ||
    d.name.length > 200 ||
    [...d.name].some((c) => c.charCodeAt(0) < 32 || "/\\".includes(c)) ||
    !b?.length ||
    b.length > 20 * 1024 * 1024
  )
    return { type: "erreur", message: "Sauvegarde invalide ou supérieure à 20 Mo." };
  return { type: "sauver", nom: d.name, octets: new Uint8Array(b) };
}
