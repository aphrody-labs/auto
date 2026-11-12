#!/usr/bin/env bash
# À installer dans ~/auto/sauvegarde.sh sur le VPS ; secrets chargés par Bun.
# La base de production est sur Neon : pg_dump par DATABASE_URL_DIRECT (prod.env), chiffré par la clé maître.
set -euo pipefail
cd "$HOME/auto/outils"
export AUTO_SAUVEGARDES="$HOME/auto/sauvegardes"
export AUTO_SAUVEGARDES_GARDER=14
"$HOME/.local/bin/bun" --env-file="$HOME/auto/prod.env" scripts/sauvegarde.ts
SSH_AUTH_SOCK= rsync -a --delete -e "ssh -o BatchMode=yes" "$HOME/auto/sauvegardes/" offsite:/srv/offsite/vps/auto-sauvegardes/
echo "copie hors site : $(find "$HOME/auto/sauvegardes" -maxdepth 1 -type f | wc -l) fichier(s) sur offsite (prod)"
