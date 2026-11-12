#!/usr/bin/env sh
# Compatibilité : implémentation unique et portable dans cargo.ts.
set -eu
exec bun "$(dirname "$0")/cargo.ts" "$@"
