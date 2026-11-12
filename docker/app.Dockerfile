# Images de production d'auto, toutes sur Alpine (politique conteneurs : jamais Debian ni Ubuntu).
# Contexte : racine du dépôt ; la suite Rust est vendorisée dans vendor/suite.
#
#   docker build --target precompiled -t auto-app:<version> .   API et worker, natif déjà construit (native/)
#   docker build --target web         -t auto-web:<version> .   front, sans Chromium, OCR ni natif
#   docker build --target sauvegarde  -t auto-sauvegarde:<version> .   pg_dump chiffré (cron de l'hôte)
#   docker build --target application -t auto-app:<version> .  référence : natif compilé ici (rust Alpine)
#
# Le natif livré vient de `ay build -t linux-musl --release --dylib -- -p auto-ffi`, copié dans native/.

ARG BUN_IMAGE=oven/bun:1.4.4-alpine

FROM rust:1.99-alpine AS natif
# hadolint ignore=DL3018
RUN apk add --no-cache musl-dev
WORKDIR /w
COPY Cargo.toml Cargo.lock rustfmt.toml ./
COPY crates crates
COPY vendor/suite vendor/suite
# cdylib sur musl : sans -crt-static, cargo abandonne le type cdylib (AY_FIELD_TEST.md).
ENV RUSTFLAGS="-C target-feature=-crt-static"
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/w/target,sharing=locked \
    cargo build --release --locked -p auto-ffi \
    && install -D target/release/libauto_ffi.so /out/libauto_ffi.so

# Runtime : image Alpine officielle de Bun (musl). Bun.Video est propre au fork et absent ici : les nœuds vidéo
# échouent avec un message clair, le reste (Bun.Image, Bun.WebView, Bun.SQL, Bun.S3Client) est présent.
FROM ${BUN_IMAGE} AS runtime
# hadolint ignore=DL3018
RUN apk add --no-cache ca-certificates libgcc libstdc++ tzdata \
    && adduser -S -D -H -u 10001 -h /home/auto auto \
    && bun --version

# Front sans Chromium, OCR ni bibliothèque Rust.
FROM runtime AS web
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY apps apps
COPY packages packages
RUN bun install --frozen-lockfile --production && mkdir -p /home/auto && chown auto /home/auto
ENV HOME=/home/auto NODE_ENV=production PORT=3001
USER 10001
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(Bun.env.PORT??3001)+'/health',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["bun", "apps/web/src/index.ts"]

FROM runtime AS application-sources
# Chromium pour le nœud « Ouvrir dans un navigateur » (Bun.WebView, backend chrome) ; sans bac à sable de Chrome
# dans le conteneur (pas de namespaces utilisateur), l'isolation est celle du conteneur.
# OCR des scans français et extraction de la couche texte des PDF reçus.
# hadolint ignore=DL3018
RUN apk add --no-cache chromium font-dejavu poppler-utils tesseract-ocr tesseract-ocr-data-fra
ENV AUTO_CHROME_ARGS="--no-sandbox --disable-dev-shm-usage"
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY apps apps
COPY packages packages
RUN bun install --frozen-lockfile --production
# Dossier personnel inscriptible (profil de Chromium, caches) : /app reste en lecture seule pour `auto`.
RUN mkdir -p /home/auto && chown auto /home/auto
ENV HOME=/home/auto
USER 10001
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(Bun.env.PORT??3000)+'/health',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["bun", "apps/api/src/index.ts"]

# Livraison : bibliothèque Linux musl déjà qualifiée, sans recompiler Rust sur le serveur.
FROM application-sources AS precompiled
COPY native/libauto_ffi.so dist/native/linux-x64/libauto_ffi.so

# Construction de référence, depuis les sources Rust épinglées.
FROM application-sources AS application
COPY --from=natif /out/libauto_ffi.so dist/native/linux-x64/libauto_ffi.so

# Sauvegarde nocturne : pg_dump 18 local (AUTO_PG_LOCAL=1) puis chiffrement AES-256-GCM par la clé maître.
FROM runtime AS sauvegarde
# hadolint ignore=DL3018
RUN apk add --no-cache postgresql18-client
WORKDIR /app
COPY scripts/sauvegarde.ts scripts/restauration.ts scripts/
COPY packages/tenancy/src/chiffrement.ts packages/tenancy/src/
ENV AUTO_PG_LOCAL=1 AUTO_SAUVEGARDES=/sauvegardes
USER 10001
CMD ["bun", "scripts/sauvegarde.ts"]
