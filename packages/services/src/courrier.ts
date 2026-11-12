import {
  analyser,
  chiffrer,
  dechiffrer,
  cleMaitre,
  Imap,
  echangerCourrier,
  autorisationCourrier,
  adresseValide,
  envoyeurDepuisEnv,
  urlGraphCourrier,
  type JetonsCourrier,
  type FournisseurCourrier,
} from "@auto/mail";
import {
  avecCourrier,
  stockerCourrier,
  ErreurMetier,
  type CompteCourrier,
  type CourrierRecu,
  type Sql,
} from "@auto/store";
import type { Auth } from "@auto/tenancy";

const usage = (a: Pick<Auth, "userId">) => `courrier/${a.userId}`;
const chiffrerSecret = (a: Auth, secret: unknown) => chiffrer(cleMaitre(), a.tenantId, usage(a), secret);
const hash = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
export const fournisseurCourrier = (s: string): FournisseurCourrier => {
  if (s !== "google" && s !== "microsoft") throw new ErreurMetier("fournisseur inconnu");
  return s;
};
export async function debutCourrier(sql: Sql, a: Auth, f: FournisseurCourrier) {
  const state = "courrier_" + crypto.randomUUID() + crypto.randomUUID(),
    verifier = crypto.randomUUID() + crypto.randomUUID();
  const url = await autorisationCourrier(f, state, verifier);
  const secret = await chiffrerSecret(a, { verifier });
  await avecCourrier(sql, a.tenantId, a.userId, async (tx) => {
    await tx`DELETE FROM courrier_oauth WHERE expire_at<now()`;
    await tx`INSERT INTO courrier_oauth(empreinte,user_id,fournisseur,secret) VALUES(${hash(state)},${a.userId},${f},${secret})`;
  });
  return { url };
}
class ErreurDistant extends ErreurMetier {
  constructor(
    public code: number,
    f: string,
    public raison?: string,
    public retryAfterMs?: number,
  ) {
    super(`Synchronisation ${f} indisponible (${code}${raison ? `:${raison}` : ""})`, [], 502);
  }
}
async function requeteDistant(f: FournisseurCourrier, url: string, token: string, signal?: AbortSignal) {
  const u = new URL(url),
    origin = f === "google" ? "https://gmail.googleapis.com" : "https://graph.microsoft.com";
  if (u.origin !== origin || u.username || u.password) throw new Error("Origine de messagerie invalide");
  for (let tentative = 0; ; tentative++) {
    const r = await fetch(u, {
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${token}`, prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' },
    });
    if (r.status === 401) throw new ErreurMetier("Autorisation expirée : reconnecter le compte", [], 409);
    if (r.ok) return r;
    // Ne conserver que le code structurel du fournisseur : son message peut
    // contenir des détails de compte ou des données renvoyées par le service.
    let raison: string | undefined;
    try {
      const body = (await r.json()) as { error?: { code?: string; errors?: { reason?: string }[] } };
      const candidate = body.error?.errors?.[0]?.reason ?? body.error?.code;
      if (typeof candidate === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(candidate)) raison = candidate;
    } catch {}
    const quotaGoogle =
      f === "google" && r.status === 403 && ["rateLimitExceeded", "userRateLimitExceeded"].includes(raison ?? "");
    if (quotaGoogle && tentative < 4) {
      const header = r.headers.get("retry-after");
      const valeurRetry = header
        ? /^\d+(?:\.\d+)?$/.test(header)
          ? Number(header) * 1000
          : Date.parse(header) - Date.now()
        : 0;
      const retryAfter = Number.isFinite(valeurRetry) && valeurRetry > 0 ? valeurRetry : 0;
      const attente = Math.min(32_000, retryAfter || 1000 * 2 ** tentative) + Math.random() * 1000;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, attente);
        if (signal) {
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }
      });
      continue;
    }
    throw new ErreurDistant(r.status, f, raison);
  }
}
export async function retourCourrier(sql: Sql, a: Auth, f: FournisseurCourrier, state: string, code: string) {
  if (state.length > 200 || !state || code.length > 4096 || !code) throw new ErreurMetier("Retour OAuth invalide");
  const row = await avecCourrier(
    sql,
    a.tenantId,
    a.userId,
    async (tx) =>
      (
        await tx`DELETE FROM courrier_oauth WHERE empreinte=${hash(state)} AND fournisseur=${f} AND expire_at>now() RETURNING secret`
      )[0],
  );
  if (!row) throw new ErreurMetier("Autorisation mail expirée ou déjà utilisée", [], 409);
  const { verifier } = await dechiffrer<{ verifier: string }>(
    cleMaitre(),
    a.tenantId,
    usage(a),
    new Uint8Array(row.secret),
  );
  const jetons = await echangerCourrier(f, { grant_type: "authorization_code", code, code_verifier: verifier });
  const profile = await (
    await requeteDistant(
      f,
      f === "google"
        ? "https://gmail.googleapis.com/gmail/v1/users/me/profile"
        : "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName",
      jetons.access_token,
    )
  ).json();
  const adresse = String(profile.emailAddress ?? profile.mail ?? profile.userPrincipalName ?? "").toLowerCase();
  if (!adresseValide(adresse)) throw new ErreurMetier("Adresse du compte introuvable");
  const ancien = await avecCourrier(
    sql,
    a.tenantId,
    a.userId,
    async (tx) => (await tx`SELECT secret FROM courrier_compte WHERE fournisseur=${f} AND adresse=${adresse}`)[0],
  );
  if (!jetons.refresh_token && ancien && ancien.secret.length >= 29)
    jetons.refresh_token = (
      await dechiffrer<JetonsCourrier>(cleMaitre(), a.tenantId, usage(a), new Uint8Array(ancien.secret))
    ).refresh_token;
  if (!jetons.refresh_token) throw new ErreurMetier("Accès hors ligne non accordé : reconnecter le compte", [], 409);
  const secret = await chiffrerSecret(a, jetons);
  return avecCourrier(
    sql,
    a.tenantId,
    a.userId,
    async (tx) =>
      (
        await tx`INSERT INTO courrier_compte(user_id,fournisseur,adresse,secret)
 VALUES(${a.userId},${f},${adresse},${secret}) ON CONFLICT(tenant_id,user_id,fournisseur,adresse) DO UPDATE SET secret=EXCLUDED.secret,actif=true,erreur=null RETURNING id,adresse`
      )[0],
  );
}
export async function connecterAphrody(sql: Sql, a: Auth) {
  const [user] = await sql`SELECT email FROM app_user WHERE id=${a.userId}`;
  if (
    !Bun.env.AUTO_COURRIER_PROPRIETAIRE ||
    String(user?.email).toLowerCase() !== Bun.env.AUTO_COURRIER_PROPRIETAIRE.toLowerCase()
  )
    throw new ErreurMetier("Cette boîte Aphrody est réservée à son propriétaire", [], 403);
  const adresse = Bun.env.AUTO_SMTP_UTILISATEUR,
    motDePasse = Bun.env.AUTO_SMTP_MOT_DE_PASSE;
  if (!adresse || !motDePasse) throw new ErreurMetier("Boîte Aphrody non configurée", [], 503);
  const i = await Imap.ouvrir({
    hote: "imap.mail.ovh.net",
    port: 993,
    securite: "tls",
    identifiants: { utilisateur: adresse, motDePasse },
  });
  try {
    await i.examiner();
  } finally {
    await i.fermer();
  }
  const secret = await chiffrerSecret(a, { utilisateur: adresse, motDePasse });
  return avecCourrier(
    sql,
    a.tenantId,
    a.userId,
    async (tx) =>
      (
        await tx`INSERT INTO courrier_compte(user_id,fournisseur,adresse,secret) VALUES(${a.userId},'ovh',${adresse},${secret})
 ON CONFLICT(tenant_id,user_id,fournisseur,adresse) DO UPDATE SET secret=EXCLUDED.secret,actif=true,erreur=null RETURNING id,adresse`
      )[0],
  );
}
const deMime = (distantId: string, bytes: Uint8Array, lu = false): CourrierRecu => {
  const m = analyser(bytes);
  return {
    distantId,
    messageId: m.messageId,
    expediteur: m.de ?? "",
    destinataires: m.a,
    sujet: m.sujet,
    texte: m.texte || (m.html ?? "").replace(/<[^>]*>/g, " "),
    date: (m.date ?? new Date()).toISOString(),
    lu,
    pieces: m.pieces,
  };
};
export async function synchroniserCourrier(sql: Sql, a: Auth, id: string, signal = AbortSignal.timeout(10 * 60_000)) {
  const apiDistant = (f: FournisseurCourrier, url: string, token: string) => requeteDistant(f, url, token, signal);
  const verrou = crypto.randomUUID();
  const c = await avecCourrier(
    sql,
    a.tenantId,
    a.userId,
    async (tx) =>
      (
        await tx<CompteCourrier[]>`UPDATE courrier_compte SET verrou=${verrou},verrou_jusqua=now()+interval '15 minutes'
 WHERE id=${id} AND actif AND (verrou_jusqua IS NULL OR verrou_jusqua<now()) RETURNING *`
      )[0],
  );
  if (!c) throw new ErreurMetier("Compte absent, déconnecté ou synchronisation déjà en cours", [], 409);
  let curseur = { ...c.curseur },
    n = 0;
  const sauver = (m: CourrierRecu) => avecCourrier(sql, a.tenantId, a.userId, (tx) => stockerCourrier(tx, c, m));
  try {
    const reprise = Number(curseur.repriseApresLimitation ?? 0);
    if (reprise > Date.now()) {
      return { nouveaux: 0, suite: false, repriseApresLimitation: true, repriseA: new Date(reprise).toISOString() };
    }
    delete curseur.repriseApresLimitation;
    const secret = await dechiffrer<JetonsCourrier & { utilisateur: string; motDePasse: string }>(
      cleMaitre(),
      a.tenantId,
      usage(a),
      new Uint8Array(c.secret),
    );
    if (c.fournisseur === "ovh") {
      const imap = await Imap.ouvrir({ hote: "imap.mail.ovh.net", port: 993, securite: "tls", identifiants: secret });
      try {
        const etat = await imap.examiner(),
          dernier = curseur.uidValidity === etat.uidValidity ? Number(curseur.dernierUid ?? 0) : 0;
        const uids = await imap.uidsApres(dernier);
        for (const uid of uids.slice(0, 20)) {
          const b = await imap.lire(uid);
          if (b) {
            await sauver(deMime(`${etat.uidValidity}:${uid}`, b));
            n++;
          }
          curseur.dernierUid = uid;
        }
        curseur.uidValidity = etat.uidValidity;
        curseur.suite = uids.length > 20;
      } finally {
        await imap.fermer();
      }
    } else {
      if (secret.expires_at < Date.now() + 60000) {
        if (!secret.refresh_token)
          throw new ErreurMetier("Reconnecter le compte pour renouveler son autorisation", [], 409);
        const nouveau = await echangerCourrier(c.fournisseur, {
          grant_type: "refresh_token",
          refresh_token: secret.refresh_token,
        });
        Object.assign(secret, { ...nouveau, refresh_token: nouveau.refresh_token ?? secret.refresh_token });
        const chiffre = await chiffrerSecret(a, secret);
        await avecCourrier(sql, a.tenantId, a.userId, async (tx) => {
          await tx`UPDATE courrier_compte SET secret=${chiffre} WHERE id=${id} AND verrou=${verrou}`;
        });
      }
      if (c.fournisseur === "google") {
        const base = "https://gmail.googleapis.com/gmail/v1/users/me";
        const importer = async (messageId: string, forcer = false) => {
          const exists = await avecCourrier(
            sql,
            a.tenantId,
            a.userId,
            async (tx) =>
              (await tx`SELECT id FROM courrier_message WHERE compte_id=${id} AND distant_id=${messageId}`)[0],
          );
          if (exists && !forcer) return;
          let data;
          try {
            data = await (
              await apiDistant(
                "google",
                `${base}/messages/${encodeURIComponent(messageId)}?format=raw`,
                secret.access_token,
              )
            ).json();
          } catch (e) {
            if (e instanceof ErreurDistant && e.code === 404) {
              await avecCourrier(sql, a.tenantId, a.userId, async (tx) => {
                await tx`UPDATE courrier_message SET present=false WHERE compte_id=${id} AND distant_id=${messageId}`;
              });
              return;
            }
            throw e;
          }
          if (!(data.labelIds ?? []).includes("INBOX")) {
            await avecCourrier(sql, a.tenantId, a.userId, async (tx) => {
              await tx`UPDATE courrier_message SET present=false WHERE compte_id=${id} AND distant_id=${messageId}`;
            });
            return;
          }
          if (!data.raw) throw new Error("Message Gmail sans contenu");
          await sauver(
            deMime(
              messageId,
              Uint8Array.fromBase64(data.raw, { alphabet: "base64url" }),
              !(data.labelIds ?? []).includes("UNREAD"),
            ),
          );
          n++;
        };
        if (curseur.history) {
          const u = new URL(`${base}/history`);
          u.search = new URLSearchParams({
            startHistoryId: String(curseur.history),
            maxResults: "20",
            ...(curseur.histoirePage ? { pageToken: String(curseur.histoirePage) } : {}),
          }).toString();
          let data;
          try {
            data = await (await apiDistant("google", u.href, secret.access_token)).json();
          } catch (e) {
            if (e instanceof ErreurDistant && e.code === 404) {
              curseur = { suite: true };
              data = null;
            } else throw e;
          }
          if (data) {
            const ids = new Set<string>();
            for (const h of data.history ?? []) for (const m of h.messages ?? []) ids.add(m.id);
            for (const messageId of ids) await importer(messageId, true);
            curseur = data.nextPageToken
              ? { ...curseur, histoirePage: data.nextPageToken, suite: true }
              : { history: data.historyId ?? curseur.history, suite: false };
          }
        } else {
          if (!curseur.initialHistory)
            curseur.initialHistory = (
              await (await apiDistant("google", `${base}/profile`, secret.access_token)).json()
            ).historyId;
          const u = new URL(`${base}/messages`);
          u.search = new URLSearchParams({
            labelIds: "INBOX",
            maxResults: "20",
            ...(curseur.page ? { pageToken: String(curseur.page) } : {}),
          }).toString();
          const liste = await (await apiDistant("google", u.href, secret.access_token)).json();
          const tete = curseur.page
            ? await (
                await apiDistant("google", `${base}/messages?labelIds=INBOX&maxResults=20`, secret.access_token)
              ).json()
            : liste;
          const messages = new Map<string, { id: string }>();
          for (const m of [...(tete.messages ?? []), ...(liste.messages ?? [])]) messages.set(m.id, m);
          for (const m of messages.values()) await importer(m.id);
          curseur = liste.nextPageToken
            ? { initialHistory: curseur.initialHistory, page: liste.nextPageToken, suite: true }
            : { history: curseur.initialHistory, suite: false };
        }
      } else {
        const url = urlGraphCourrier(
          String(
            curseur.url ??
              "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$select=id,internetMessageId,from,toRecipients,subject,body,receivedDateTime,isRead&$top=20",
          ),
        );
        let data;
        try {
          data = await (await apiDistant("microsoft", url, secret.access_token)).json();
        } catch (e) {
          if (e instanceof ErreurDistant && e.code === 410) {
            data = {
              value: [],
              "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$top=20",
            };
          } else throw e;
        }
        for (const m of data.value ?? []) {
          if (m["@removed"]) {
            await avecCourrier(sql, a.tenantId, a.userId, async (tx) => {
              await tx`UPDATE courrier_message SET present=false WHERE compte_id=${id} AND distant_id=${m.id}`;
            });
            continue;
          }
          // Le MIME permet de récupérer les pièces jointes avec Mail.Read, sans permission d'écriture.
          const r = await apiDistant(
            "microsoft",
            `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(m.id)}/$value`,
            secret.access_token,
          );
          await sauver(deMime(m.id, new Uint8Array(await r.arrayBuffer()), !!m.isRead));
          n++;
        }
        const next = data["@odata.nextLink"] ?? data["@odata.deltaLink"];
        if (!next) throw new Error("Curseur Outlook absent");
        curseur = { url: urlGraphCourrier(next), suite: !!data["@odata.nextLink"] };
      }
    }
    await avecCourrier(sql, a.tenantId, a.userId, async (tx) => {
      await tx`UPDATE courrier_compte SET curseur=${JSON.stringify(curseur)}::text::jsonb,synchronise_at=now(),erreur=null WHERE id=${id} AND verrou=${verrou}`;
    });
    return { nouveaux: n, suite: !!curseur.suite };
  } catch (e) {
    const message =
      e instanceof ErreurMetier ? e.message : "Synchronisation impossible : réessayer ou reconnecter le compte";
    if (
      e instanceof ErreurDistant &&
      e.code === 403 &&
      ["rateLimitExceeded", "userRateLimitExceeded"].includes(e.raison ?? "")
    ) {
      curseur.repriseApresLimitation = Date.now() + 5 * 60_000;
      await avecCourrier(sql, a.tenantId, a.userId, async (tx) => {
        await tx`UPDATE courrier_compte SET curseur=${JSON.stringify(curseur)}::text::jsonb,synchronise_at=now(),erreur='Limitation temporaire Google ; reprise automatique dans cinq minutes' WHERE id=${id} AND verrou=${verrou}`;
      });
    }
    await avecCourrier(sql, a.tenantId, a.userId, async (tx) => {
      await tx`UPDATE courrier_compte SET erreur=${curseur.repriseApresLimitation ? "Limitation temporaire Google ; reprise automatique dans cinq minutes" : message} WHERE id=${id} AND verrou=${verrou}`;
    });
    throw new ErreurMetier(message, [], 502);
  } finally {
    await avecCourrier(sql, a.tenantId, a.userId, async (tx) => {
      await tx`UPDATE courrier_compte SET verrou=null,verrou_jusqua=null WHERE id=${id} AND verrou=${verrou}`;
    });
  }
}
export async function envoyerCourrier(
  sql: Sql,
  a: Auth,
  body: { a?: string[]; sujet?: string; texte?: string; repondreA?: string },
) {
  if (
    !Array.isArray(body.a) ||
    !body.a.length ||
    body.a.length > 20 ||
    body.a.some((x) => typeof x !== "string" || !adresseValide(x)) ||
    typeof body.sujet !== "string" ||
    !body.sujet.trim() ||
    body.sujet.length > 998 ||
    typeof body.texte !== "string" ||
    body.texte.length > 100000
  )
    throw new ErreurMetier("Message ou destinataires invalides");
  if (Bun.env.AUTO_MAIL_FOURNISSEUR !== "resend") throw new ErreurMetier("Envoi Resend non configuré", [], 503);
  const [user] = await sql`SELECT email FROM app_user WHERE id=${a.userId}`;
  if (
    !Bun.env.AUTO_COURRIER_PROPRIETAIRE ||
    String(user?.email).toLowerCase() !== Bun.env.AUTO_COURRIER_PROPRIETAIRE.toLowerCase()
  )
    throw new ErreurMetier("Envoi Aphrody réservé à son propriétaire", [], 403);
  const compte = await avecCourrier(
    sql,
    a.tenantId,
    a.userId,
    async (tx) =>
      (
        await tx<
          CompteCourrier[]
        >`SELECT * FROM courrier_compte WHERE fournisseur='ovh' AND actif ORDER BY created_at LIMIT 1`
      )[0],
  );
  if (!compte) throw new ErreurMetier("Connecter la boîte Aphrody avant un envoi", [], 409);
  const envoi = await envoyeurDepuisEnv().envoyer({ a: body.a, sujet: body.sujet, texte: body.texte });
  await avecCourrier(sql, a.tenantId, a.userId, (tx) =>
    stockerCourrier(tx, compte, {
      distantId: `resend:${envoi.messageId}`,
      messageId: envoi.messageId,
      expediteur: Bun.env.AUTO_RESEND_EXPEDITEUR ?? "Auto <auto@notifications.aphrody.com>",
      destinataires: body.a!,
      sujet: body.sujet!,
      texte: body.texte!,
      date: new Date().toISOString(),
      lu: true,
      dossier: "envoyes",
    }),
  );
  return { messageId: envoi.messageId };
}
