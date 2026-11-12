# Mise à jour rapide de l'image de production, construite sur le serveur (scripts/prod.ts, voie rapide) : la base
# `auto-app:base` contient déjà le runtime et la bibliothèque native ; seules les sources TypeScript changent.
FROM auto-app:base
USER root
WORKDIR /app
RUN rm -rf apps packages
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY apps apps
COPY packages packages
RUN bun install --frozen-lockfile --production
# hadolint ignore=DL3018
RUN apk add --no-cache poppler-utils tesseract-ocr tesseract-ocr-data-fra
# Dossier personnel inscriptible (profil de Chromium, caches) : /app reste en lecture seule pour `auto`.
RUN mkdir -p /home/auto && chown auto /home/auto
ENV HOME=/home/auto
USER 10001
