#!/usr/bin/env sh
# Compatibilité : implémentation unique dans build-desktop.ts.
set -eu
exec bun "$(dirname "$0")/build-desktop.ts" "$@"
