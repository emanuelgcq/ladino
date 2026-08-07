#!/usr/bin/env bash
# PreToolUse sobre Edit/Write/MultiEdit.
# Bloquea (exit 2) violaciones estructurales que ninguna instrucción en prosa debe poder negociar.
set -uo pipefail

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // empty')

block() { echo "BLOQUEADO POR HOOK: $1" >&2; exit 2; }

[ -z "$FILE" ] && exit 0

# 1. Migraciones ya aplicadas son inmutables.
case "$FILE" in
  *supabase/migrations/*)
    if [ -f "$FILE" ]; then
      block "'$FILE' es una migración existente. Las migraciones aplicadas no se editan. Crea una nueva con 'pnpm db:new'."
    fi
    ;;
esac

# 2. service_role jamás en cliente.
case "$FILE" in
  *apps/web/*|*apps/mobile/*|*packages/ui/*)
    if echo "$CONTENT" | grep -qiE 'service_role|SUPABASE_SERVICE_ROLE|SERVICE_ROLE_KEY'; then
      block "service_role en código de cliente ($FILE). Va contra SECURITY.md. Usa la API con el token del usuario."
    fi
    ;;
esac

# 3. Dinero en float dentro de dominio/contabilidad/fiscal.
case "$FILE" in
  *packages/accounting/*|*packages/money/*|*packages/fiscal/*|*packages/domain/*)
    if echo "$CONTENT" | grep -qE '(amount|total|price|balance|debit|credit|tax|rate)[a-zA-Z_]*\s*:\s*number'; then
      block "Tipo 'number' para un campo monetario en $FILE. Usa Decimal (packages/money). Ver MONEY_AND_ROUNDING_SPEC.md."
    fi
    if echo "$CONTENT" | grep -qE '\b(parseFloat|Number\.parseFloat)\s*\(' ; then
      block "parseFloat en $FILE. Prohibido en cálculo financiero. Usa Decimal."
    fi
    ;;
esac

# 4. SQL que rompe append-only.
case "$FILE" in
  *.sql)
    if echo "$CONTENT" | grep -qiE '(update|delete[[:space:]]+from)[[:space:]]+(public\.)?(journal_lines|journal_entries|fiscal_events|fiscal_documents|inventory_moves|audit_events)'; then
      block "UPDATE/DELETE sobre tabla append-only en $FILE. Usa reversión, no mutación. Ver AUDIT_TRAIL_AND_IMMUTABILITY.md."
    fi
    if echo "$CONTENT" | grep -qiE '\b(float|real|double precision|money)\b' && echo "$CONTENT" | grep -qiE 'create table|add column'; then
      block "Tipo de punto flotante en un DDL ($FILE). Usa numeric(24,8)."
    fi
    ;;
esac

# 5. Lógica tributaria en UI.
case "$FILE" in
  *apps/web/src/*|*apps/mobile/*)
    if echo "$CONTENT" | grep -qE '(0\.16|0,16|IVA_RATE|IGTF_RATE|ALICUOTA)' ; then
      block "Alícuota o tasa tributaria hard-coded en la UI ($FILE). Las tasas vienen del motor tributario versionado."
    fi
    ;;
esac

exit 0
