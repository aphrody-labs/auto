// Instance Windows locale : secrets dans le Gestionnaire d’identifiants du compte Windows courant.
import windows from "bun:windows";
import { mkdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
if (process.platform !== "win32") throw Error("Ce lanceur nécessite Windows");
const root = resolve(import.meta.dir, "..");
const prive = join(homedir(), ".auto");
const service = "Auto.Windows.Local",
  name = "instance";
async function cmd(args: string[]) {
  const p = Bun.spawn(args, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code) throw Error(args[0] + " : " + err.slice(0, 500));
  return out.trim();
}
async function powershell(code: string) {
  return cmd(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; " + code]);
}
const identite = JSON.parse(
  await powershell(
    "$i=[Security.Principal.WindowsIdentity]::GetCurrent(); @{nom=$i.Name;sid=$i.User.Value;authentification=$i.AuthenticationType}|ConvertTo-Json -Compress",
  ),
);
async function lire() {
  const v = await Bun.secrets.get({ service, name });
  if (!v) throw Error("Exécuter d’abord : bun scripts/windows-local.ts configurer");
  const c = JSON.parse(v);
  if (c.sid !== identite.sid) throw Error("Cette configuration appartient à un autre compte Windows");
  return c as { sid: string; env: Record<string, string>; dossiers: string };
}
const action = Bun.argv[2] ?? "etat";
if (action === "inventaire") {
  const reseau = JSON.parse(
    await powershell(
      "@{interfaces=@(Get-NetIPConfiguration|ForEach-Object{ @{nom=$_.InterfaceAlias;ipv4=@($_.IPv4Address.IPAddress);passerelle=@($_.IPv4DefaultGateway.NextHop)} });partages=@(Get-SmbMapping|Select-Object LocalPath,RemotePath,Status);excel=(Test-Path 'Registry::HKEY_CLASSES_ROOT\\Excel.Application')}|ConvertTo-Json -Depth 5 -Compress",
    ),
  );
  console.log(
    JSON.stringify(
      { windows: windows.version().productName, identite, lecteurs: windows.storage.drives(), reseau },
      null,
      2,
    ),
  );
} else if (action === "configurer") {
  await mkdir(prive, { recursive: true });
  if (await Bun.secrets.get({ service, name })) {
    console.log("Configuration existante conservée dans le coffre Windows");
    process.exit(0);
  }
  const dossiers = join(windows.knownFolder("Documents"), "Auto", "Arrivages");
  await mkdir(dossiers, { recursive: true });
  const password = crypto.randomUUID() + crypto.randomUUID();
  const env = {
    DATABASE_URL: "postgres://auto_local:" + password + "@127.0.0.1:5544/auto_local",
    AUTO_CLE_MAITRE: crypto.getRandomValues(new Uint8Array(32)).toBase64(),
    BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
    AUTO_URL_APP: "http://127.0.0.1:3007",
    AUTO_BIND_HOST: "127.0.0.1",
    AUTO_DOSSIERS_PARENT: dossiers,
    AUTO_API_URL: "http://127.0.0.1:3006",
    AUTO_LLM_URL: "http://127.0.0.1:18798/v1",
    AUTO_LLM_MODEL: "auto-extraction",
    AUTO_LLM_TIMEOUT_MS: "300000",
    NODE_ENV: "development",
  };
  const existant = Bun.spawn(["docker", "inspect", "auto-pg-windows"], {
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  });
  if ((await existant.exited) === 0)
    throw Error("Conteneur auto-pg-windows existant sans configuration locale : aucune modification automatique");
  const pgEnv = join(prive, "local-postgres-initialisation.env");
  await Bun.write(pgEnv, `POSTGRES_USER=auto_local\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=auto_local\n`);
  await cmd(["icacls", pgEnv, "/inheritance:r", "/grant:r", identite.nom + ":(F)"]);
  try {
    await cmd([
      "docker",
      "create",
      "--name",
      "auto-pg-windows",
      "--restart",
      "unless-stopped",
      "--env-file",
      pgEnv,
      "-p",
      "127.0.0.1:5544:5432",
      "-v",
      "auto_windows_pgdata:/var/lib/postgresql",
      "postgres:18-alpine",
    ]);
  } finally {
    await unlink(pgEnv);
  }
  await Bun.secrets.set({ service, name, value: JSON.stringify({ sid: identite.sid, env, dossiers }) });
  await cmd(["docker", "start", "auto-pg-windows"]);
  console.log(
    "Postgres persistant local configuré (fsync actif), secrets protégés par Windows, documents : " + dossiers,
  );
} else if (action === "installer") {
  await lire();
  const citer = (s: string) => "'" + s.replaceAll("'", "''") + "'";
  const lancement =
    "$p=Start-Process -FilePath " +
    citer(process.execPath) +
    " -ArgumentList " +
    citer('"' + resolve(root, "scripts/windows-local.ts") + '" demarrer') +
    " -WorkingDirectory " +
    citer(root) +
    " -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode";
  const argument =
    "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " +
    Buffer.from(lancement, "utf16le").toString("base64");
  await powershell(
    "$ancien=Get-ScheduledTask -TaskName 'Auto local Windows' -ErrorAction SilentlyContinue; if($ancien -and $ancien.Description -notlike 'Auto local,*'){throw 'Tâche existante étrangère'}; " +
      "if($ancien -and $ancien.State -eq 'Running'){Stop-ScheduledTask -TaskName 'Auto local Windows';for($n=0;$n -lt 40 -and (Get-ScheduledTask -TaskName 'Auto local Windows').State -eq 'Running';$n++){Start-Sleep -Milliseconds 250};if((Get-ScheduledTask -TaskName 'Auto local Windows').State -eq 'Running'){throw 'Arrêt local en cours : relancer installer'}}; " +
      "$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument " +
      citer(argument) +
      "; " +
      "$p=New-ScheduledTaskPrincipal -UserId " +
      citer(identite.nom) +
      " -LogonType Interactive -RunLevel Limited; " +
      "$t=New-ScheduledTaskTrigger -AtLogOn -User " +
      citer(identite.nom) +
      "; " +
      "$s=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1); " +
      "Register-ScheduledTask -TaskName 'Auto local Windows' -Action $a -Principal $p -Trigger $t -Settings $s -Description 'Auto local, coffre du compte Windows courant, boucle locale uniquement.' -Force|Out-Null; Start-ScheduledTask -TaskName 'Auto local Windows'",
  );
  const connexion =
    "& " + citer(process.execPath) + " " + citer(resolve(root, "scripts/windows-local.ts")) + " connexion";
  const connexionEncodee = Buffer.from(connexion, "utf16le").toString("base64");
  await powershell(
    "$d=Join-Path ([Environment]::GetFolderPath('Programs')) 'Auto';New-Item -ItemType Directory -Force -Path $d|Out-Null;$s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'Auto local.lnk'));$s.TargetPath='powershell.exe';$s.Arguments='-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " +
      connexionEncodee +
      "';$s.WorkingDirectory=" +
      citer(root) +
      ";$s.Description='Connexion Auto locale depuis cette session Windows';$s.Save()",
  );
  console.log(
    "Démarrage local installé à l’ouverture de cette session Windows, sans mot de passe Windows stocké ni console visible.",
  );
} else if (action === "arreter") {
  await lire();
  await powershell(
    "$t=Get-ScheduledTask -TaskName 'Auto local Windows';if($t.Description -notlike 'Auto local,*'){throw 'Tâche étrangère'};Stop-ScheduledTask -TaskName 'Auto local Windows'",
  );
  console.log("Instance locale arrêtée ; données Postgres conservées.");
} else if (action === "demarrer") {
  const c = await lire();
  await cmd(["docker", "start", "auto-pg-windows"]);
  const sql = new Bun.SQL({ url: c.env.DATABASE_URL, connectionTimeout: 2 });
  let pret = false;
  for (let n = 0; n < 20; n++) {
    try {
      await sql`SELECT 1`;
      pret = true;
      break;
    } catch {
      await Bun.sleep(500);
    }
  }
  await sql.close();
  if (!pret) throw Error("Postgres local indisponible");
  const enfants: ReturnType<typeof Bun.spawn>[] = [];
  let tunnel: ReturnType<typeof Bun.spawn> | undefined;
  let sondeTunnel = false;
  const maintenirTunnel = async () => {
    if (sondeTunnel || c.env.AUTO_LLM_URL !== "http://127.0.0.1:18798/v1") return;
    sondeTunnel = true;
    try {
      const disponible = await fetch(c.env.AUTO_LLM_URL + "/models", { signal: AbortSignal.timeout(2000) })
        .then((r) => r.ok)
        .catch(() => false);
      if (!disponible && (!tunnel || tunnel.exitCode !== null)) {
        tunnel = Bun.spawn(
          [
            "ssh",
            "-NT",
            "-o",
            "BatchMode=yes",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            "-L",
            "127.0.0.1:18798:127.0.0.1:8798",
            "dbfr",
          ],
          {
            stdin: "ignore",
            stdout: "ignore",
            stderr: Bun.file(join(prive, "local-ia-tunnel.log")),
            windowsHide: true,
          },
        );
      }
    } finally {
      sondeTunnel = false;
    }
  };
  await maintenirTunnel();
  const minuterieTunnel = setInterval(() => {
    void maintenirTunnel();
  }, 15000);
  const env = { ...Bun.env, ...c.env };
  const entries = [
    ["api", "apps/api/src/index.ts", "3006"],
    ["web", "apps/web/src/index.ts", "3007"],
    ["worker", "apps/worker/src/index.ts", "0"],
  ];
  for (const [nom, entry, port] of entries) {
    if (nom === "worker") {
      for (let n = 0; n < 60; n++) {
        try {
          if ((await fetch("http://127.0.0.1:3006/health")).ok) break;
        } catch {}
        await Bun.sleep(500);
      }
    }
    enfants.push(
      Bun.spawn([process.execPath, resolve(root, entry!)], {
        cwd: root,
        env: { ...env, PORT: port! },
        stdout: Bun.file(join(prive, "local-" + nom + ".log")),
        stderr: Bun.file(join(prive, "local-" + nom + "-erreurs.log")),
        windowsHide: true,
      }),
    );
  }
  let arretDemande = false;
  const arreter = () => {
    arretDemande = true;
    clearInterval(minuterieTunnel);
    tunnel?.kill();
    for (const p of enfants) p.kill();
  };
  process.on("SIGINT", arreter);
  process.on("SIGTERM", arreter);
  console.log("Auto local : http://127.0.0.1:3007/app — compte Windows : " + identite.nom);
  const sorti = await Promise.race(enfants.map((p) => p.exited.then((code) => ({ pid: p.pid, code }))));
  if (!arretDemande) {
    console.error("Service local arrêté : pid=" + sorti.pid + ", code=" + sorti.code);
    process.exitCode = sorti.code || 1;
  }
  arreter();
} else if (action === "raccorder") {
  const [tenant, alias, chemin] = Bun.argv.slice(3);
  if (
    !tenant ||
    !/^[a-f0-9-]{36}$/i.test(tenant) ||
    !alias ||
    !/^[a-z][a-z0-9_-]{0,40}$/.test(alias) ||
    alias === "arrivages" ||
    !chemin
  )
    throw Error("Usage : raccorder UUID_ENTREPRISE alias chemin_windows_ou_UNC");
  const c = await lire(),
    cible = resolve(chemin);
  const stat = await import("node:fs/promises").then((fs) => fs.stat(cible));
  if (!stat.isDirectory()) throw Error("Dossier accessible requis sous le compte Windows courant");
  const racines = JSON.parse(c.env.AUTO_DOSSIERS_RACINES ?? "{}");
  if (racines[alias]) throw Error("Alias existant : aucune réaffectation implicite");
  racines[alias] = { tenantId: tenant, chemin: cible };
  c.env.AUTO_DOSSIERS_RACINES = JSON.stringify(racines);
  await Bun.secrets.set({ service, name, value: JSON.stringify(c) });
  console.log(
    "Dossier autorisé pour cette entreprise. Redémarrer Auto local, puis connecter ce dossier dans l’interface.",
  );
} else if (action === "etat") {
  const c = await lire();
  const s = await fetch(c.env.AUTO_URL_APP + "/health")
    .then((r) => r.ok)
    .catch(() => false);
  console.log(
    JSON.stringify(
      {
        accessible: s,
        url: c.env.AUTO_URL_APP,
        identiteWindows: identite.nom,
        dossiers: c.dossiers,
        authWindows: "identité Windows et coffre utilisateur ; connexion Auto par lien Better Auth à usage unique",
      },
      null,
      2,
    ),
  );
} else if (action === "preparer") {
  const c = await lire();
  Object.assign(Bun.env, c.env);
  const { connect } = await import("../packages/store/src/index");
  const { preparerArrivages } = await import("../packages/services/src/sources-fichiers");
  const sql = connect();
  try {
    console.log(JSON.stringify(await preparerArrivages(sql)));
  } finally {
    await sql.close();
  }
} else if (action === "proprietaire" || action === "connexion") {
  const c = await lire();
  if (action === "proprietaire") {
    const email = Bun.argv[3]?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error("Usage : proprietaire adresse_email");
    if (c.env.AUTO_LOCAL_WINDOWS_EMAIL && c.env.AUTO_LOCAL_WINDOWS_EMAIL !== email)
      throw Error("Propriétaire déjà lié à ce compte Windows : aucune réaffectation implicite");
    c.env.AUTO_LOCAL_WINDOWS_EMAIL = email;
    c.env.AUTO_SUPER_ADMIN_EMAILS = email;
    c.env.AUTO_COURRIER_PROPRIETAIRE = email;
    await Bun.secrets.set({ service, name, value: JSON.stringify(c) });
  }
  const email = c.env.AUTO_LOCAL_WINDOWS_EMAIL;
  if (!email) throw Error("Lier d’abord le propriétaire local avec la commande proprietaire");
  if (c.env.AUTO_BIND_HOST !== "127.0.0.1" || c.env.AUTO_URL_APP !== "http://127.0.0.1:3007")
    throw Error("La connexion Windows nécessite l’instance locale de boucle interne");
  Object.assign(Bun.env, c.env);
  const { connect, migrate } = await import("../packages/store/src/index");
  const { authDe, brancherEnvoyeur, synchroniserOperateurs } = await import("../packages/tenancy/src/index");
  const sql = connect();
  try {
    await migrate(sql);
    const auth = authDe(sql),
      contexte = await auth.$context;
    const [existant] = await sql`SELECT id FROM app_user WHERE lower(email)=${email}`;
    if (!existant) {
      const user = await contexte.internalAdapter.createUser(
        {
          email,
          name: identite.nom,
          emailVerified: true,
          role: "admin",
        },
        { method: "windows-local" },
      );
      await contexte.internalAdapter.createAccount({
        userId: user.id,
        providerId: "windows-local",
        accountId: identite.sid,
      });
    } else {
      const [lien] =
        await sql`SELECT id FROM account WHERE user_id=${existant.id} AND provider_id='windows-local' AND account_id=${identite.sid}`;
      if (!lien) throw Error("Le compte local existe sans liaison à cette identité Windows : connexion Auto requise");
    }
    await synchroniserOperateurs(sql);
    if (action === "connexion") {
      let lien: string | undefined;
      brancherEnvoyeur(async (m) => {
        if (m.a !== email || m.modele !== "lien-magique")
          throw Error("Connexion Windows limitée au propriétaire local");
        lien = m.donnees.lien;
      });
      await auth.api.signInMagicLink({
        headers: new Headers({ origin: c.env.AUTO_URL_APP! }),
        body: { email, callbackURL: c.env.AUTO_URL_APP + "/app/administration" },
      });
      if (!lien || new URL(lien).origin !== c.env.AUTO_URL_APP) throw Error("Lien local non créé");
      await Bun.secrets.set({ service, name: "connexion-en-attente", value: lien });
      if (!Bun.argv.includes("--sans-ouvrir"))
        await powershell("Start-Process -FilePath '" + lien.replaceAll("'", "''") + "'");
      console.log(
        "Connexion Auto locale autorisée par le compte Windows, lien Better Auth à usage unique créé sans envoi de mail.",
      );
    } else
      console.log(
        "Propriétaire Auto local lié au compte Windows ; aucune entreprise ni mot de passe cloud copiés. Redémarrer l’instance locale.",
      );
  } finally {
    await sql.close();
  }
} else
  throw Error(
    "Actions : configurer, installer, demarrer, arreter, etat, inventaire, raccorder, preparer, proprietaire, connexion",
  );
