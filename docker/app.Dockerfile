# Image de production de l'API et du worker : bibliothèque auto-ffi compilée pour Linux, puis runtime Aphrody.
# Contexte : racine du dépôt, après `bun run vendor` (clone partiel de la suite dans vendor/bun-distribution).

FROM rust:1.99 AS natif
WORKDIR /w
COPY Cargo.toml Cargo.lock rustfmt.toml ./
COPY crates crates
COPY vendor/bun-distribution vendor/bun-distribution
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/w/target,sharing=locked \
    cargo build --release --locked -p auto-ffi \
    && install -D target/release/libauto_ffi.so /out/libauto_ffi.so

FROM debian:trixie-slim AS runtime
# Runtime Aphrody : archive de la release GitHub, vérifiée par son SHA256SUMS.txt.
ARG BUN_TAG=bun-v1.4.6
RUN apt-get update -qq  && apt-get install -y -qq --no-install-recommends ca-certificates curl unzip  && cd /tmp  && curl -fsSLO "https://github.com/aphrody-labs/bun/releases/download/$BUN_TAG/bun-linux-x64.zip"  && curl -fsSL "https://github.com/aphrody-labs/bun/releases/download/$BUN_TAG/SHA256SUMS.txt" | grep " bun-linux-x64.zip$" | sha256sum -c -  && unzip -q bun-linux-x64.zip && install -m 0755 bun-linux-x64/bun /usr/local/bin/bun && ln -s bun /usr/local/bin/bunx  && rm -rf /tmp/bun-linux-x64*  && apt-get purge -y -qq curl unzip && apt-get autoremove -y -qq && rm -rf /var/lib/apt/lists/*  && useradd --system --uid 10001 --home /app auto  && bun --version
# Front sans Chromium, OCR ni bibliothèque Rust : `docker build --target web ...`.
FROM runtime AS web
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY apps apps
COPY packages packages
RUN bun install --frozen-lockfile --production && mkdir -p /home/auto && chown auto /home/auto
ENV HOME=/home/auto NODE_ENV=production PORT=3001
USER auto
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s CMD bun -e "fetch('http://127.0.0.1:'+(Bun.env.PORT??3001)+'/health',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["bun", "apps/web/src/index.ts"]

FROM runtime AS application-sources
# Chromium pour le nœud « Ouvrir dans un navigateur » (Bun.WebView, backend chrome) ; sans bac à sable de Chrome
# dans le conteneur (pas de namespaces utilisateur), l'isolation est celle du conteneur.
# OCR des scans français et extraction de la couche texte des PDF reçus.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends chromium fonts-dejavu-core poppler-utils tesseract-ocr tesseract-ocr-fra && rm -rf /var/lib/apt/lists/*
ENV AUTO_CHROME_ARGS="--no-sandbox --disable-dev-shm-usage"
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY apps apps
COPY packages packages
RUN bun install --frozen-lockfile --production
# Dossier personnel inscriptible (profil de Chromium, caches) : /app reste en lecture seule pour `auto`.
RUN mkdir -p /home/auto && chown auto /home/auto
ENV HOME=/home/auto
USER auto
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s CMD bun -e "fetch('http://127.0.0.1:'+(Bun.env.PORT??3000)+'/health',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["bun", "apps/api/src/index.ts"]

# Contexte de livraison préparé par scripts/deployer-vps.ts : bibliothèque Linux déjà qualifiée,
# sans envoyer l'image complète ni recompiler Rust sur le VPS.
FROM application-sources AS precompiled
COPY native/libauto_ffi.so dist/native/linux-x64/libauto_ffi.so

# Construction de référence, depuis les sources Rust épinglées.
FROM application-sources AS application
COPY --from=natif /out/libauto_ffi.so dist/native/linux-x64/libauto_ffi.so
