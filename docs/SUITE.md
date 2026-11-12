# Suite Aphrody utilisable (aphrody-labs/bun-distribution, branche `os`)

Vérifié par lecture des sources le 2026-10-22. Une CLI Rust et une version web existent pour chaque Craft (`apps/<x>craft-cli`, `apps/<x>craft-web`).

| Besoin                              | Équivalent                                             | Crate / app                                                                                                       | Notes                               |
| ----------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Word, devis, courriers              | wordcraft                                              | `wordcraft-docx`, `wordcraft-pdf`, `wordcraft-cli` (convert, inspect, render, MCP)                                | `fichier.document`                  |
| Excel                               | gridcraft                                              | `gridcraft-xlsx` (`read_xlsx`, `write_xlsx`, xls/xlsb/ods/csv), `gridcraft-cli` (inspect, convert, evaluate, MCP) | remplace calamine + rust_xlsxwriter |
| PowerPoint                          | deckcraft                                              | `deckcraft-pptx`, `deckcraft-pdf`                                                                                 | `fichier.presentation`              |
| Acrobat                             | pdfcraft                                               | `pdfcraft-create`, `-organize`, `-render`, `-sign`, `-forms`, `-redact`, `-ocr`, `-preflight`, `pdfcraft-cli`     | `fichier.pdf_*`                     |
| Photoshop / Illustrator / Lightroom | photocraft / vectorcraft / lightcraft                  |                                                                                                                   | hors périmètre administratif        |
| OCR                                 | `aphrody-ocr`, `-ocr-onnx`, `-ocr-vlm`, `pdfcraft-ocr` |                                                                                                                   | non retenu, voir plus bas           |
| LLM local                           | `aphrody-llama`, `aphrody-llama-server`                |                                                                                                                   | llama.cpp                           |
| Agent local                         | `aphrody-agent-runtime`                                | `ModelChoice::local_chat(url, model)` pour llama-server/Ollama/vLLM; `AgentRuntime::run_once`                     | autonomie FullAuto par défaut       |
| RAG                                 | `aphrody-rag-core`                                     | découpeurs prose/Markdown, `fusion::top_k_exact`, `fusion::mmr`                                                   | `ia.indexer`, `ia.rechercher`       |
| Jobs, secrets, stockage             | `aphrody-jobs`, `aphrody-secrets`, `aphrody-store`     |                                                                                                                   |                                     |
| MCP / A2A                           | `aphrody-mcp`, `aphrody-a2a-*`                         |                                                                                                                   |                                     |

## Fichiers des automatisations (`crates/auto-fichiers`)

API lues dans les sources du commit épinglé (2026-10-23) :

| Besoin              | Appel                                                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ouvrir, enregistrer | `pdfcraft_cos::Document::open(Arc<Vec<u8>>)`, `write_full(&doc, &SaveOptions::default())`                                                                      |
| Fusionner           | `pdfcraft_organize::combine(&[(&str, &Document)])` (un signet par source, champs de formulaire renommés en cas de conflit)                                     |
| Pages               | `pdfcraft_organize::extract_pages(&Document, &[usize])`, `page_count`                                                                                          |
| Texte               | `pdfcraft_render::PageRenderer::new(bytes, RenderConfig::default())`, `render(RenderRequest { kind: RequestKind::Text, .. })` → `PageText::plain_text()`       |
| DOCX                | `wordcraft_docx::read(&[u8])`, `write(&Document)` ; modèle `wordcraft_doc` (`Paragraph::text` + `runs` par longueur, `delete`, `insert_text`, `props_of_char`) |
| DOCX → PDF          | `wordcraft_pdf::export(&Document, &PdfOptions::default())` (krilla, polices embarquées : aucune dépendance système)                                            |
| Recherche de texte  | `pdfcraft_render::inspect` → `PageInfo::view_rect_to_quad` ; `PageText::find_opts(texte, casse, mots_entiers)`, `find_with(motif)`, `line_rects`               |
| Caviardage          | `pdfcraft_annot::add_annotation` (`Shape::Redact { quads, overlay, look }`) puis `pdfcraft_redact::apply(&mut Document, None)` → `Report` ; `patterns::find`   |
| Signature           | `pdfcraft_sign::pkcs12::open(&[u8], mot_de_passe)`, `sign(&Document, &DigitalId, &SignOptions)` (PAdES B-B, `ETSI.CAdES.detached`, incrémental)                |
| Vérification        | `pdfcraft_sign::signatures(&Document, &[u8], &TrustStore)` → `SignatureInfo` (`status`, `modification`, `details`) ; `x509::load_certificates` (PEM/DER)       |
| Présentation        | `deckcraft_model::defaults::{new_presentation, new_slide, layout_of_kind}`, `deckcraft_pptx::export`/`import`, `deckcraft_pdf::export(&p, &PdfOptions)`        |

`pdfcraft-render` s'appuie sur les copies corrigées de hayro, hayro-interpret, hayro-syntax, hayro-jbig2 et lopdf
(`apps/pdfcraft/vendor`, API absentes de crates.io), renommées `aphrody-hayro*` et `aphrody-lopdf` : elles sont
vendorisées dans `vendor/suite/apps/pdfcraft/vendor` et référencées directement en `path`.

Taille de la bibliothèque native (release, strip) : Linux 4,41 Mo → 24,27 Mo, Windows (MinGW) 12,50 Mo → 39,48 Mo.
Sans `wordcraft-pdf` (mesuré) : Linux 12,90 Mo ; l'export DOCX → PDF (mise en page, krilla, codecs d'image, polices
Source Sans/Serif, Inter et JetBrains Mono, motifs de césure) pèse donc 11,4 Mo, PDF et DOCX 8,5 Mo.

Caviardage : `patterns` de pdfcraft reconnaît téléphones (dont le format national à 0 initial), e-mails, cartes
(Luhn), numéros de sécurité sociale américains et dates ; l'IBAN (clé modulo 97) est ajouté dans `auto-fichiers`.
`apply` retire glyphes, images (effacées ou supprimées), tracés, XObjects, annotations et champs sous chaque zone,
dessine les pavés dans la page et relit les pages : il échoue s'il reste un glyphe sous une zone (fail-closed). Les
pavés couvrent les rectangles de ligne de la couche texte : un texte dans une image (scan) n'est pas trouvé.

Signature : primitives RustCrypto, clé RSA signée par `aws-lc-rs` (C compilé par `cc`, sans bibliothèque système),
ECDSA P-256/P-384 ; aucun HSM ni magasin requis (le magasin Windows et le trousseau macOS ne sont pas utilisés ici).
Non livrés : horodatage RFC 3161 (B-T, `sign_with_timestamp` attend un transport TSA fourni par l'appelant), LTV
(`dss::embed` sans récupération des révocations), PKCS #11. Sans certificat de confiance fourni, une signature
intacte est « inconnue » (verdict d'Acrobat), jamais « valide ».

Présentation : `deckcraft-pdf` rend chaque diapositive (vello_cpu, ici à 150 ppp) avec une couche de texte réel
(polices de la suite et substituts ouverts des polices Office) ; le PDF est donc plus lourd qu'un PDF vectoriel.

Taille ajoutée par ces trois briques (release, strip) : Linux 24,27 Mo → 34,27 Mo (caviardage 1,5 Mo, signature
3,8 Mo, présentation PPTX + PDF 4,7 Mo, mesurés en retirant les opérations), Windows (MinGW) 39,48 Mo → 50,37 Mo.
Aucune ne dépasse 10 Mo ; si la taille devenait gênante, `deckcraft-pdf` (vello_cpu, codecs d'image) serait la
première à mettre derrière une feature Cargo de `auto-fichiers`.

OCR non retenu : `pdfcraft-ocr` (ocrs + rten) a besoin de deux modèles `.rten` téléchargés à part
(`text-detection.rten`, `text-recognition.rten`, CC-BY-SA-4.0) et ne lit que l'alphabet latin sans accents (anglais),
inutilisable sur des factures françaises ; `aphrody-ocr` lance `llama-mtmd-cli` avec un modèle de vision GGUF
(processus et poids externes, `aphrody-infer`), et `aphrody-ocr-onnx` lie ONNX Runtime (`ort`, bibliothèque
système). Le texte des PDF numériques passe par `fichier.pdf_texte` ; un scan donne un texte vide, à confier à un
nœud IA de vision.

## Base de connaissances (`crates/auto-connaissance`)

Le paquet npm `@aphrody/rag-core@1.4.4` ne s'installe pas (il dépend de `@aphrody/paths@1.4.4`, non publiée) : la crate
`aphrody-rag-core` (1.4.4) est prise au commit épinglé, sans la fonctionnalité `oxc` (découpeur JS/TS inutile ici).
API lues dans les sources :

| Besoin      | Appel                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Découper    | `ProseChunker.chunk(path, source, &ChunkOptions)`, `MarkdownChunker.chunk(..)` (trait `Chunker`) → `Vec<Chunk { ord, kind, symbol, start_line, end_line, text, hash }>` |
| Options     | `ChunkOptions { max_chars: 1400, overlap_pct: 0.15, min_chars: 64, length_unit: Utf16, cjk_sentence_breaks: true }` (défaut) ; `detect_language(path)`                  |
| Plus proche | `fusion::top_k_exact(&query, &matrix, dim, k) -> Vec<(usize, f32)>` (cosinus, tas borné, ex aequo par indice croissant)                                                 |
| Diversité   | `fusion::mmr(&[(Id, Vec<f32>, f64)], lambda, top_n) -> Vec<Id>`                                                                                                         |

Les opérations FFI `rag_decouper` et `rag_topk` (`crates/auto-ffi`) les exposent ; l'appel direct (plutôt que
`api::call_json("chunk")` ou `call_vec("top_k_cosine_f32")`) choisit le découpeur par type de document
(`chunker_for_path` enverrait un `.pdf` au découpeur structurel de code) et enchaîne la MMR sur les candidats. Taille
de la bibliothèque native (release, strip) : Linux 34,27 Mo → 35,94 Mo, Windows (MinGW) 50,37 Mo → 54,16 Mo (regex, blake3, syn et ndarray,
dépendances non optionnelles de la crate).

## Manques constatés

- Factur-X : implémenté dans `crates/auto-facturx` (XML CII EN 16931 + PDF/A-3b via `pdfcraft-preflight::convert`, pièce jointe `/AF` `Alternative`, extension XMP). Validé par `pdfcraft-preflight::verify(A3b)` et par `bun run validate:facturx` (XSD CII D16B + Schematron EN 16931 1.3.17).
- Plateforme agréée (PA) : `packages/pa` (contrat `Plateforme`, adaptateurs `mock` et B2Brouter) ; qualification en bac à sable B2Brouter en attente d'identifiants (voir `PA.md`).
- Mail IMAP/SMTP : aucune brique.

## Consommation par le workspace Cargo

Le dépôt amont `bun-distribution` n'existe plus. Les crates racines et la fermeture de leurs dépendances `path` sont versionnés dans `vendor/suite` (hors workspace, sans héritage `workspace = true`). Le workspace référence ces crates en `path`.

Le Rust se compile et se teste dans un conteneur Linux (`scripts/cargo.sh`, image `docker/rust.Dockerfile`) : c'est la cible de production, et la chaîne MSVC locale est incomplète.
