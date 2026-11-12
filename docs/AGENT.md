# Ingestion des factures reçues et agent `auto`

## Factures fournisseurs reçues

`@auto/ingest` (fonctions sans état) transforme un fichier reçu en facture normalisée (`FactureRecue` :
fournisseur, SIREN/SIRET/TVA, numéro, dates, échéance, lignes, totaux HT/TVA/TTC en centimes, taux de TVA
en dixièmes de pourcent).

| Fichier reçu       | Traitement                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------- |
| Factur-X (PDF/A-3) | `extraireXml` (auto-ffi) puis lecture directe du XML CII (`lireCii`)                          |
| XML CII seul       | `lireCii`                                                                                     |
| PDF sans XML       | OCR (interface `Ocr`) puis LLM en JSON contraint par `SCHEMA` (JSON Schema strict), revérifié |
| Autre / échec      | file « à vérifier », sans extraction                                                          |

Puis `valider` : SIREN et SIRET (clé de Luhn), TVA FR cohérente avec le SIREN, dates réelles, échéance
postérieure à la facture, date non future, HT + TVA = TTC, somme des lignes, TVA recalculée par taux.
Sans anomalie : `validee` ; sinon `a_verifier`. La validation manuelle peut corriger la facture (revérifiée,
anomalies restantes enregistrées) ou la rejeter (définitif).

OCR par défaut (`ocrParDefaut`) : couche texte du PDF par `pdftotext` (poppler ou xpdf), sinon OCR
d'image par `aphrody-ocr <fichier>`, sinon `pdftoppm` + `tesseract -l fra`. Chaque outil n'est utilisé
que s'il est trouvé dans le `PATH`. Sur le poste de dev (2026-10-22) : seul `pdftotext` (xpdf 4.06, Git
for Windows) est présent ; ni `aphrody-ocr` (suite non clonée dans `vendor/`) ni `tesseract`. Un PDF
scanné y part donc en « à vérifier ».

### API

| Route                              | Méthode | Droit    | Rôle                                                                 |
| ---------------------------------- | ------- | -------- | -------------------------------------------------------------------- |
| `/v1/factures-recues`              | POST    | `ecrire` | dépôt (`application/pdf`, `application/xml`, ou multipart `fichier`) |
| `/v1/factures-recues?statut=`      | GET     | `lire`   | liste (`a_verifier`, `validee`, `rejetee`)                           |
| `/v1/factures-recues/:id`          | GET     | `lire`   | détail, anomalies                                                    |
| `/v1/factures-recues/:id/fichier`  | GET     | `lire`   | fichier d'origine (ETag = SHA-256)                                   |
| `/v1/factures-recues/:id/decision` | POST    | `ecrire` | `{ statut: "validee" \| "rejetee", facture?, motif? }`               |

Le même fichier (SHA-256) déposé deux fois dans un tenant renvoie la facture existante (`doublon: true`).
Le dépôt d'un fichier binaire exige un jeton `Bearer` (l'anti-CSRF refuse un corps non JSON authentifié
par cookie). Les lots mail et PA appellent `deposer(sql, tenantId, actor, { contenu, nom, typeMime, canal })`
exporté par `apps/api/src/modules/ingest.ts`.

Stockage (migration `010_ingest.sql`, RLS forcée) : `fichier_recu` (ajout seul, unique par tenant et
SHA-256) et `facture_recue` (clé étrangère composite vers le fichier). Chaque dépôt et chaque décision
est journalisé dans l'audit chaîné.

### LLM

API compatible OpenAI (`POST {AUTO_LLM_URL}/chat/completions`) : llama-server, Ollama, vLLM.

| Variable              | Exemple                                                                         |
| --------------------- | ------------------------------------------------------------------------------- |
| `AUTO_LLM_URL`        | `http://localhost:8080/v1` (llama-server), `http://localhost:11434/v1` (Ollama) |
| `AUTO_LLM_MODEL`      | `qwen2.5-7b-instruct` (défaut : `local`)                                        |
| `AUTO_LLM_KEY`        | clé `Bearer` si le serveur en exige une                                         |
| `AUTO_LLM_TIMEOUT_MS` | `120000`                                                                        |

Extraction : `temperature: 0`, `response_format: { type: "json_schema", strict: true }`. La réponse est
de toute façon revalidée contre le schéma. Isolation : aucun cache côté API, une requête par fichier,
`cache_prompt: false` (llama-server ne réutilise pas le préfixe d'une requête d'un autre tenant).

## Agent `auto`

`apps/cli` : binaire Bun `auto` (outils, boucle d'agent et serveur MCP dans `packages/agent`). Il n'accède jamais à la base : chaque outil appelle l'API `/v1` avec le
jeton API de l'utilisateur, donc avec ses droits et son seul tenant.

```sh
# Jeton API (session d'un utilisateur, droit « parametres »)
curl -X POST $AUTO_API_URL/v1/jetons -H "authorization: Bearer $SESSION" -H "content-type: application/json" -d '{"nom":"agent"}'

export AUTO_API_URL=http://localhost:3000
export AUTO_TOKEN=auto_…
export AUTO_LLM_URL=http://localhost:8080/v1

bun apps/cli/src/cli.ts agent "Facture 2 jours de conseil à 450 € HT à Dupont et émets-la"
bun apps/cli/src/cli.ts agent          # conversation sur l'entrée standard
bun apps/cli/src/cli.ts outils         # liste des outils
bun run --cwd apps/cli build           # binaire autonome dist/auto(.exe)
```

Outils : `lister_documents`, `lire_document`, `chercher_document`, `chercher_client`, `creer_devis`,
`creer_facture`, `emettre_document`, `enregistrer_paiement`, `lister_relances`, `relancer`,
`lister_absences` (droit `rh`), `lister_factures_recues`, `exporter` (CSV `;` ou JSON).

Boucle (`executerAgent`) : message système, outils au format OpenAI `tools`, exécution des `tool_calls`,
résultats renvoyés en messages `tool` (une erreur d'API devient un résultat `{ erreur, status }` que le
modèle peut lire), au plus 10 étapes.

### Serveur MCP

`auto mcp` : serveur MCP sur stdio, JSON-RPC 2.0, un message par ligne, sans SDK. Versions du protocole
`2025-06-18`, `2025-03-26`, `2024-11-05` ; méthodes `initialize`, `ping`, `tools/list`, `tools/call`
(résultat `content` texte, `structuredContent` pour un objet, `isError` pour une erreur d'outil) ;
notifications ignorées. Pas de LLM côté serveur : c'est le client MCP qui raisonne.

Ajout à Claude Code :

```sh
claude mcp add auto --env AUTO_API_URL=http://localhost:3000 --env AUTO_TOKEN=auto_… \
  -- bun /chemin/vers/auto/apps/cli/src/cli.ts mcp
# ou, avec le binaire compilé :
claude mcp add auto --env AUTO_API_URL=https://api.exemple.fr --env AUTO_TOKEN=auto_… -- /chemin/vers/dist/auto mcp
```

Serveur distant (mêmes outils, sans jeton à copier) : `POST /mcp` de l'API, OAuth 2.1 avec PKCE, inscription
du client par CIMD ou RFC 7591, jeton lié à l'entreprise choisie au consentement.

```sh
claude mcp add --transport http auto https://auto.aphrody.com/mcp   # puis /mcp pour s'authentifier
```

## Limites

- OCR d'image non disponible sans `aphrody-ocr` ou `tesseract` + `pdftoppm` ; pas de lecture des
  remises et frais d'en-tête CII (seuls les montants de ligne et les totaux sont repris).
- Pas encore d'événement publié au dépôt d'une facture reçue (types d'événements fermés dans `evenements.ts`).
- Validation automatique d'une extraction LLM si tous les contrôles passent : pas de score de confiance.
- Agent : pas de quota d'appels LLM par plan (lot abonnement), pas de confirmation interactive avant
  `emettre_document` ; l'outil `exporter` est construit côté client depuis `/v1/documents` en attendant
  les exports du lot L3. Pas de panneau web (lot UI).
- MCP : outils seulement (ni ressources, ni prompts). Transport HTTP : serveur distant `POST /mcp` de l'API,
  authentifié par OAuth 2.1 (voir [AUTH.md](AUTH.md#serveur-mcp-distant)).
