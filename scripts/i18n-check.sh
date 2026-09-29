#!/usr/bin/env bash
# Chequeo de textos sin i18n, frontend y backend. Ver .claude/specs/i18n.md.
#   ./scripts/i18n-check.sh            falla si un archivo sumó texto a mano
#   ./scripts/i18n-check.sh --update   baja las líneas base tras migrar
#   ./scripts/i18n-check.sh --list components/Foo.tsx   pendientes del frontend
#   ./scripts/i18n-check.sh --list backend/git/ops.go   pendientes del backend
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if [ "${1:-}" = "--list" ]; then
    case "${2:-}" in
        *.go) exec python3 "$here/i18n-check-go.py" --list "$2" ;;
        *) cd "$here/../frontend" && exec node scripts-i18n-check.mjs --list "$2" ;;
    esac
fi
status=0
(cd "$here/../frontend" && node scripts-i18n-check.mjs "$@") || status=1
python3 "$here/i18n-check-go.py" "$@" || status=1
exit $status
