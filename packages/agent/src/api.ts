// Client de l'API /v1 avec le jeton de l'utilisateur : l'agent n'a que ses droits et son tenant.

export class ErreurApi extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

export class ApiAuto {
  readonly url: string;

  constructor(
    url: string,
    private readonly jeton: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.url = url.replace(/\/+$/, "");
  }

  async appeler<T = unknown>(methode: string, chemin: string, corps?: unknown): Promise<T> {
    const res = await this.fetcher(`${this.url}${chemin}`, {
      method: methode,
      headers: { authorization: `Bearer ${this.jeton}`, "content-type": "application/json" },
      body: corps === undefined ? undefined : JSON.stringify(corps),
    });
    const texte = await res.text();
    const j = texte ? (JSON.parse(texte) as T & { erreur?: string; details?: string[] }) : (null as T);
    if (!res.ok) {
      const e = j as { erreur?: string; details?: string[] } | null;
      throw new ErreurApi(res.status, e?.erreur ?? `HTTP ${res.status}`, e?.details ?? []);
    }
    return j;
  }

  get = <T = unknown>(chemin: string) => this.appeler<T>("GET", chemin);
  post = <T = unknown>(chemin: string, corps: unknown = {}) => this.appeler<T>("POST", chemin, corps);
}

export function apiDepuisEnv(env = Bun.env): ApiAuto {
  const jeton = env.AUTO_TOKEN;
  if (!jeton) throw new Error("AUTO_TOKEN manquant : créez un jeton API (POST /v1/jetons) et exportez-le");
  return new ApiAuto(env.AUTO_API_URL ?? "https://auto.aphrody.com", jeton);
}
