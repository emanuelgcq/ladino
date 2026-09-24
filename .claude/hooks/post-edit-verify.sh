#!/usr/bin/env bash
# PostToolUse: feedback rápido sin bloquear.
# Con jq ausente, este hook tampoco hacía nada (el FILE salía vacío). Ahora lee con Node; y como
# no bloquea, si no puede leer la entrada simplemente no da el aviso.
set -uo pipefail
INPUT=$(cat)
command -v node >/dev/null 2>&1 || exit 0
FILE=$(printf '%s' "$INPUT" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    try { const v = JSON.parse(s); process.stdout.write((v.tool_input && v.tool_input.file_path) || ""); }
    catch { }
  });' 2>/dev/null)
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
