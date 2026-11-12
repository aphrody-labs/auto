#!/bin/sh
# Installation de l'Aphrody Box (Linux, macOS) : récupère la boîte si besoin, prépare les secrets, détecte une
# carte graphique NVIDIA, puis démarre tout. Relancer le script met à jour sans toucher à vos données.
#   curl -fsSL https://raw.githubusercontent.com/aphrody-labs/auto/main/box/installer.sh | sh
# Options : BOX_DOSSIER (défaut ~/aphrody-box), BOX_EMAIL, BOX_DOMAINE (HTTPS sur sous-domaines).
set -eu

dire() { printf '\033[1m%s\033[0m\n' "$*"; }
echec() { printf 'Erreur : %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || echec "Docker est requis : https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || echec "le module « docker compose » est requis (Docker 24 ou plus récent)."
docker info >/dev/null 2>&1 || echec "Docker ne répond pas : démarrez-le, ou lancez ce script avec sudo."

DOSSIER=${BOX_DOSSIER:-"$HOME/aphrody-box"}
if [ -f "./compose.yaml" ] && grep -q "name: aphrody-box" ./compose.yaml; then DOSSIER=$(pwd); fi
mkdir -p "$DOSSIER"
cd "$DOSSIER"

# Fichiers de la boîte : téléchargés s'ils manquent, ou remplacés avec BOX_MAJ=1 (.env, donnees et coffre restent).
if [ ! -f compose.yaml ] || [ "${BOX_MAJ:-0}" = 1 ]; then
  dire "Téléchargement de la boîte dans $DOSSIER…"
  curl -fsSL https://codeload.github.com/aphrody-labs/auto/tar.gz/refs/heads/main \
    | tar -xz --strip-components=2 auto-main/box
fi

IMAGE=${BOX_IMAGE_CONSOLE:-ghcr.io/aphrody-labs/aphrody-box:latest}
if ! docker pull -q "$IMAGE" >/dev/null 2>&1; then
  dire "Image de la console introuvable en ligne : construction sur cette machine (quelques minutes)…"
  docker build -q -t "$IMAGE" console >/dev/null
fi

GPU=--sans-gpu
if command -v nvidia-smi >/dev/null 2>&1 && docker info 2>/dev/null | grep -qi nvidia; then GPU=--gpu; fi

HOTE=${BOX_HOTE:-}
if [ -z "$HOTE" ]; then
  HOTE=$( (hostname -I 2>/dev/null || true) | awk '{print $1}')
  [ -n "$HOTE" ] || HOTE=$(ipconfig getifaddr en0 2>/dev/null || true)
  [ -n "$HOTE" ] || HOTE=localhost
fi

set -- preparer /box "$GPU" --hote "$HOTE"
[ -n "${BOX_EMAIL:-}" ] && set -- "$@" --email "$BOX_EMAIL"
[ -n "${BOX_DOMAINE:-}" ] && set -- "$@" --domaine "$BOX_DOMAINE"
docker run --rm -v "$DOSSIER:/box" "$IMAGE" "$@"

dire "Démarrage des services (le premier lancement télécharge les images et un modèle d'IA de 2,5 Go)…"
docker compose up -d --remove-orphans

PORT_CONSOLE=8080
if [ -n "${BOX_DOMAINE:-}" ]; then URL="https://console.$BOX_DOMAINE"; else URL="http://$HOTE:$PORT_CONSOLE"; fi
MDP=$(sed -n "s/^BOX_ADMIN_MOT_DE_PASSE='\(.*\)'$/\1/p" .env)
dire ""
dire "L'Aphrody Box est lancée."
echo "  Console : $URL"
echo "  Identifiant : admin"
echo "  Mot de passe : $MDP"
echo "Les accès d'Auto, n8n, Hermes et Obsidian sont dans la console, section « Accès »."
