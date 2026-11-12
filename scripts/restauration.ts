// Restauration d'une sauvegarde chiffrée (scripts/sauvegarde.ts) dans une base existante et vide :
//
//   bun scripts/restauration.ts <fichier.dump.chiffre> <base-cible> [base-d-origine]
//
// La base d'origine (déduite du nom du fichier) fixe la clé de déchiffrement. La restauration vers une
// base neuve, puis le basculement, évite d'écraser la production en cas d'échec.
import { dechiffrer } from "../packages/tenancy/src/chiffrement";
import { ENTETE, envLibpq, executer, infoCle, local } from "./sauvegarde";

export interface OptionsRestauration {
  fichier: string;
  base: string;
  /** Base sauvegardée (clé de déchiffrement) ; par défaut, préfixe du nom de fichier. */
  origine?: string;
  conteneur?: string;
  utilisateur?: string;
  cle?: Uint8Array<ArrayBuffer>;
}

export async function restaurer(o: OptionsRestauration) {
  const octets = await Bun.file(o.fichier).bytes();
  if (!ENTETE.every((b, i) => octets[i] === b)) throw new Error("restauration : fichier de sauvegarde inconnu");
  const origine = o.origine ?? (o.fichier.split(/[\\/]/).pop() ?? "").replace(/-\d{4}-\d\d-\d\dT.*$/, "");
  const dump = await dechiffrer(infoCle(origine), octets.subarray(ENTETE.length), o.cle);
  // AUTO_PG_LOCAL=1 : pg_restore local vers DATABASE_URL_DIRECT, base `o.base`, sans docker.
  if (local() && Bun.env.DATABASE_URL_DIRECT) {
    const libpq = { ...envLibpq(Bun.env.DATABASE_URL_DIRECT), PGDATABASE: o.base };
    await executer(["pg_restore", "-d", o.base, "--no-owner", "--exit-on-error"], dump, libpq);
    return;
  }
  await executer(
    [
      "docker",
      "exec",
      "-i",
      o.conteneur ?? Bun.env.AUTO_PG_CONTENEUR ?? "auto-pg",
      "pg_restore",
      "-U",
      o.utilisateur ?? Bun.env.AUTO_PG_UTILISATEUR ?? "auto",
      "-d",
      o.base,
      "--no-owner",
      "--exit-on-error",
    ],
    dump,
  );
}

if (import.meta.main) {
  const [fichier, base, origine] = Bun.argv.slice(2);
  if (!fichier || !base) throw new Error("usage : bun scripts/restauration.ts <fichier> <base-cible> [origine]");
  await restaurer({ fichier, base, origine });
  console.log(`restauré dans ${base}`);
}
