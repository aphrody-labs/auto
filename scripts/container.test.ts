import { expect, test } from "bun:test";
import { $ } from "bun";

const image = Bun.env.AUTO_CONTAINER_IMAGE;
const imageApplication = Bun.env.AUTO_APP_IMAGE;
(image ? test : test.skip)(
  "image web : démarrage non-root en lecture seule, HTML et proxy santé",
  async () => {
    const api = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => Response.json({ statut: "ok" }) });
    const nom = `auto-web-test-${crypto.randomUUID()}`;
    try {
      await $`docker run -d --name ${nom} --read-only --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:rw,nosuid,nodev,size=128m,mode=1777 --tmpfs /home/auto:rw,nosuid,nodev,size=128m,uid=10001,gid=10001 --add-host host.docker.internal:host-gateway -e ${`AUTO_API_URL=http://host.docker.internal:${api.port}`} -p 127.0.0.1::3001 ${image!}`.quiet();
      const adresse = (await $`docker port ${nom} 3001/tcp`.text()).trim();
      let reponse: Response | undefined;
      for (let essai = 0; essai < 100; essai++) {
        reponse = await fetch(`http://${adresse}/health`).catch(() => undefined);
        if (reponse?.ok) break;
        await Bun.sleep(200);
      }
      expect(reponse?.status).toBe(200);
      expect(await reponse!.json()).toEqual({ statut: "ok" });
      const app = await fetch(`http://${adresse}/app`);
      expect(app.status).toBe(200);
      expect(await app.text()).toContain("racine");
      const outils =
        await $`docker exec ${nom} bun -e ${"console.log(Bun.which('chromium'),Bun.which('tesseract'))"}`.text();
      expect(outils.trim()).toBe("null null");
    } finally {
      await $`docker rm -f ${nom}`.quiet().nothrow();
      await api.stop(true);
    }
  },
  60_000,
);

(image && imageApplication ? test : test.skip)(
  "Compose production : migrations, API, worker, front et PostgreSQL durable",
  async () => {
    const projet = `auto-test-${crypto.randomUUID()}`;
    const fichier = `.cache/${projet}.env`;
    await Bun.write(
      fichier,
      [
        `AUTO_ENV_FILE=${fichier}`,
        `AUTO_IMAGE=${imageApplication}`,
        `AUTO_WEB_IMAGE=${image}`,
        `AUTO_DB_PASSWORD=${crypto.randomUUID().replaceAll("-", "")}`,
        `AUTO_CLE_MAITRE=${crypto.randomUUID()}${crypto.randomUUID()}`,
        "AUTO_URL_APP=http://localhost",
        "AUTO_SMTP_HOTE=localhost",
        "AUTO_SMTP_SECURITE=tls",
        "AUTO_PORT=0",
      ].join("\n"),
    );
    const compose = ["docker", "compose", "--env-file", fichier, "-p", projet, "-f", "compose.production.yaml"];
    const executer = async (...args: string[]) => {
      const p = Bun.spawn([...compose, ...args], { stdout: "pipe", stderr: "pipe" });
      const [sortie, erreurs, code] = await Promise.all([p.stdout.text(), p.stderr.text(), p.exited]);
      if (code !== 0) throw new Error(`Compose ${args[0]} : ${erreurs}`);
      return sortie;
    };
    try {
      await executer("up", "-d", "--no-build", "--wait", "--wait-timeout", "90");
      const adresse = (await executer("port", "web", "3001")).trim();
      expect((await fetch(`http://${adresse}/health`)).status).toBe(200);
      expect(await (await fetch(`http://${adresse}/app`)).text()).toContain("racine");
      expect(
        (await executer("exec", "-T", "postgres", "psql", "-U", "auto", "-d", "auto", "-Atc", "SHOW fsync")).trim(),
      ).toBe("on");
      const worker = (await executer("ps", "-q", "worker")).trim();
      expect((await $`docker inspect ${worker} --format ${"{{.State.Status}} {{.RestartCount}}"}`.text()).trim()).toBe(
        "running 0",
      );
    } finally {
      await executer("down", "--volumes", "--remove-orphans");
      await $`rm -f ${fichier}`.quiet();
    }
  },
  120_000,
);
