// Clé stable hors dépôt, mot de passe dans le coffre système ; jamais de secret dans les arguments.
import { join } from "node:path";
const java = Bun.env.JAVA_HOME;
if (!java) throw Error("JAVA_HOME est requis");
const sdk = Bun.env.ANDROID_HOME ?? join(Bun.env.LOCALAPPDATA!, "Android/Sdk");
const outils = join(sdk, "build-tools/37.0.0");
const cle = join(Bun.env.USERPROFILE!, ".auto/android-release.p12");
const identite = { service: "Auto.Android.Release", name: "mot-de-passe-signature" };
let motDePasse = await Bun.secrets.get(identite);
if (!motDePasse) {
  if (await Bun.file(cle).exists())
    throw Error("Clé existante sans mot de passe dans le coffre ; restauration nécessaire");
  motDePasse = crypto.randomUUID() + crypto.randomUUID();
  await Bun.secrets.set({ ...identite, value: motDePasse });
}
const env = { ...Bun.env, AUTO_ANDROID_SIGNATURE_PASSWORD: motDePasse };
async function commande(args: string[]) {
  const p = Bun.spawn(args, { env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (await p.exited) throw Error(`Échec de ${args[0]}`);
}
if (!(await Bun.file(cle).exists()))
  await commande([
    join(java, "bin/keytool.exe"),
    "-genkeypair",
    "-keystore",
    cle,
    "-storetype",
    "PKCS12",
    "-alias",
    "auto",
    "-keyalg",
    "RSA",
    "-keysize",
    "4096",
    "-validity",
    "36500",
    "-dname",
    "CN=Auto mobile, O=Aphrody, C=FR",
    "-storepass:env",
    "AUTO_ANDROID_SIGNATURE_PASSWORD",
    "-keypass:env",
    "AUTO_ANDROID_SIGNATURE_PASSWORD",
  ]);
const version = (await Bun.file("apps/desktop/src-tauri/tauri.conf.json").json()).version as string;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error("Version invalide");
const entree = "dist/mobile/android/auto-release-unsigned.apk";
const aligne = "dist/mobile/android/auto-release-aligned.apk";
const sortie = `dist/mobile/android/auto-${version}-arm64.apk`;
await commande([join(outils, "zipalign.exe"), "-P", "16", "-f", "4", entree, aligne]);
const signer = [join(java, "bin/java.exe"), "-jar", join(outils, "lib/apksigner.jar")];
await commande([
  ...signer,
  "sign",
  "--ks",
  cle,
  "--ks-key-alias",
  "auto",
  "--ks-pass",
  "env:AUTO_ANDROID_SIGNATURE_PASSWORD",
  "--key-pass",
  "env:AUTO_ANDROID_SIGNATURE_PASSWORD",
  "--out",
  sortie,
  aligne,
]);
await commande([...signer, "verify", "--verbose", "--print-certs", sortie]);
await commande([join(outils, "zipalign.exe"), "-c", "-P", "16", "4", sortie]);
const sha = new Bun.CryptoHasher("sha256").update(await Bun.file(sortie).bytes()).digest("hex");
await Bun.write(`${sortie}.sha256`, `${sha}  auto-${version}-arm64.apk\n`);
console.log(`APK de production signé et vérifié : ${sortie}`);
