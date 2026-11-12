// À exécuter sur le VPS : assertions sur les conteneurs actifs, sans afficher leurs variables secrètes.
export {};
function lire(args: string[]) {
  const p = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode) throw Error(`Contrôle impossible : ${args[0]} ${args[1]}`);
  return p.stdout.toString().trim();
}
const controles: string[] = [];
function exiger(ok: boolean, nom: string) {
  if (!ok) throw Error(nom);
  controles.push(nom);
}
for (const nom of ["auto-api", "auto-worker", "auto-web"]) {
  const [c] = JSON.parse(lire(["docker", "inspect", nom]));
  exiger(c.State.Running && c.RestartCount === 0, `${nom} : actif sans redémarrage`);
  exiger(
    c.Config.User === "10001:10001" && c.HostConfig.ReadonlyRootfs,
    `${nom} : non-root et racine en lecture seule`,
  );
  exiger(
    c.HostConfig.CapDrop.includes("ALL") && c.HostConfig.SecurityOpt.includes("no-new-privileges:true"),
    `${nom} : capacités retirées`,
  );
  exiger(
    Object.values(c.NetworkSettings.Ports ?? {}).every((p) => p === null),
    `${nom} : aucun port publié`,
  );
  if (nom !== "auto-worker") exiger(c.State.Health?.Status === "healthy", `${nom} : santé validée`);
  if (nom === "auto-web") {
    for (const destination of ["/mnt/media", "/mnt/distributions"])
      exiger(
        c.Mounts.some((m: { Destination: string; RW: boolean }) => m.Destination === destination && !m.RW),
        `web : ${destination} en lecture seule`,
      );
    const outils = JSON.parse(
      lire([
        "docker",
        "exec",
        nom,
        "bun",
        "-e",
        "console.log(JSON.stringify(['chromium','tesseract','pdftotext'].map(n=>Bun.which(n))))",
      ]),
    );
    exiger(
      outils.every((x: unknown) => x === null),
      "web : aucun outil OCR/navigateur système",
    );
  }
}
exiger(
  lire([
    "docker",
    "exec",
    "auto-api",
    "bun",
    "-e",
    "const u=new URL(Bun.env.DATABASE_URL);const s=new Bun.SQL(u.href,{max:1});const [r]=await s`select current_setting('server_version_num')::int v`;await s.close();console.log(u.hostname.endsWith('.neon.tech')&&u.hostname.includes('-pooler')&&r.v>=180000?'ok':'non')",
  ]) === "ok",
  "PostgreSQL : Neon (point d'accès poolé, Postgres 18) joignable depuis l'API",
);
const etat = lire([
  "docker",
  "exec",
  "auto-web",
  "bun",
  "-e",
  "const r=await fetch('http://127.0.0.1:3001/health');if(!r.ok)process.exit(1);console.log('ok')",
]);
exiger(etat === "ok", "proxy web vers API : santé accessible");
console.log(JSON.stringify({ statut: "PRODUCTION_CONTENEURS_OK", controles }, null, 2));
