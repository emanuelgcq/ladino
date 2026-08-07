#!/usr/bin/env bash
# PostToolUse: feedback rápido sin bloquear.
set -uo pipefail
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0

case "$FILE" in
  *.ts|*.tsx)
    if command -v pnpm >/dev/null 2>&1 && [ -f package.json ]; then
      pnpm exec prettier --write "$FILE" >/dev/null 2>&1 || true
    fi
    ;;
  *.sql)
    echo "Recordatorio: migración tocada. Necesita test pgTAP de RLS y comprobar reversibilidad." >&2
    ;;
esac
exit 0
