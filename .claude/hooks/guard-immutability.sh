#!/usr/bin/env bash
# PreToolUse sobre Edit/Write/MultiEdit Y sobre Bash.
# Bloquea (exit 2) violaciones estructurales que ninguna instrucción en prosa debe poder negociar.
# Lee el JSON con lib-json.sh (Node), no con jq: sin jq, esto aprobaba todo (2026-09-24). Y si no
# encuentra lib-json.sh, tampoco aprueba: sin él, `campo` no existe y el hook saldría con 0.
# SIN pipefail, a propósito: con él, `printf "$CONTENT" | grep -q` sobre un contenido de más de ~64 KB
# con la coincidencia al principio hacía que grep saliera antes, printf recibiera EPIPE, la tubería
# diera falso y el guardián APROBARA (revisor, 2026-09-24). Sin pipefail manda el estado de grep.
set -u

INPUT=$(cat)
if ! . "$(dirname "$0")/lib-json.sh"; then
  echo "BLOQUEADO POR HOOK: no se encuentra lib-json.sh junto a $0; un guardián que no puede leer no aprueba." >&2
  exit 2
fi

FILE=$(campo tool_input.file_path)
CONTENT=$(campo tool_input.content)
[ -z "$CONTENT" ] && CONTENT=$(campo tool_input.new_string)
# MultiEdit trae una lista de ediciones: se inspeccionan todas (antes se miraba solo new_string).
EDITS=$(campo tool_input.edits)
[ -n "$EDITS" ] && CONTENT="$CONTENT $EDITS"
CMD=$(campo tool_input.command)

APPEND_ONLY='(journal_lines|journal_entries|fiscal_events|fiscal_documents|inventory_moves|audit_events)'
# La MUTACIÓN de una tabla append-only, en todas las formas que se han visto: `update`, `delete from`,
# `truncate [table] [only]`, en lista (`truncate public.x, public.journal_lines`) y con el nombre entre
# comillas (`delete from "journal_lines"`, `public."audit_events"`). Con límite de palabra detrás:
# `journal_lines_archive` no es `journal_lines`.
MUTA_AO='(update[[:space:]]+(only[[:space:]]+)?|delete[[:space:]]+from[[:space:]]+(only[[:space:]]+)?|truncate[[:space:]]+(table[[:space:]]+)?(only[[:space:]]+)?([[:alnum:]_."]+[[:space:]]*,[[:space:]]*)*)("?public"?\.)?"?'"$APPEND_ONLY"'"?([^[:alnum:]_]|$)'

# ── Bash: SQL que rompe append-only, lanzado contra una base ────────────────────
# Solo cuando el comando invoca un cliente SQL o la API de Supabase: así un `grep` que BUSCA ese
# texto en el repo no se bloquea. El comando se aplana a una línea para que un heredoc que parte
# `delete` y `from` no lo esconda. Límite honesto: un script que arma el DELETE por dentro (el nombre
# de la tabla en una variable) no se ve desde el texto del comando.
if [ -n "$CMD" ]; then
  C=$(printf '%s' "$CMD" | tr '\n' ' ')
  if printf '%s' "$C" | grep -qiE '(psql|supabase[[:space:]]+db|execute_sql|api\.supabase\.com|pg_dump|postgres(ql)?://)' \
     && printf '%s' "$C" | grep -qiE "$MUTA_AO"; then
    bloquear "UPDATE/DELETE/TRUNCATE sobre una tabla append-only desde la terminal. Se corrige con reversión, no con mutación (AUDIT_TRAIL_AND_IMMUTABILITY.md)."
  fi
  exit 0
fi

[ -z "$FILE" ] && exit 0
FILE_N=$(printf '%s' "$FILE" | tr '\\' '/')

# 1. Migraciones ya aplicadas son inmutables.
case "$FILE_N" in
  *supabase/migrations/*)
    if [ -f "$FILE" ]; then
      bloquear "'$FILE' es una migración existente. Las migraciones aplicadas no se editan. Crea una nueva con 'pnpm db:new'."
    fi
    ;;
esac

# 2. service_role jamás en cliente.
case "$FILE_N" in
  *apps/web/*|*apps/mobile/*|*packages/ui/*)
    if printf '%s' "$CONTENT" | grep -qiE 'service_role|SUPABASE_SERVICE_ROLE|SERVICE_ROLE_KEY'; then
      bloquear "service_role en código de cliente ($FILE). Va contra SECURITY.md. Usa la API con el token del usuario."
    fi
    ;;
esac

# 3. Dinero en float dentro de dominio/contabilidad/fiscal.
case "$FILE_N" in
  *packages/accounting/*|*packages/money/*|*packages/fiscal/*|*packages/domain/*)
    if printf '%s' "$CONTENT" | grep -qE '(amount|total|price|balance|debit|credit|tax|rate)[a-zA-Z_]*\s*:\s*number'; then
      bloquear "Tipo 'number' para un campo monetario en $FILE. Usa Decimal (packages/money). Ver MONEY_AND_ROUNDING_SPEC.md."
    fi
    if printf '%s' "$CONTENT" | grep -qE '\b(parseFloat|Number\.parseFloat)\s*\(' ; then
      bloquear "parseFloat en $FILE. Prohibido en cálculo financiero. Usa Decimal."
    fi
    ;;
esac

# 4. SQL que rompe append-only.
#    La regla se enuncia entera: no se muta una tabla append-only FUERA de un pgTAP que prueba que el
#    trigger RECHAZA la mutación (ahí el DELETE es la variante rota, y siete tests lo necesitan).
case "$FILE_N" in
  *.sql)
    # La misma forma que la regla de Bash: también TRUNCATE, listas y comillas (revisor, 2026-09-24).
    if printf '%s' "$CONTENT" | grep -qiE "$MUTA_AO"; then
      case "$FILE_N" in
        *supabase/tests/*) ;;
        *) bloquear "UPDATE/DELETE/TRUNCATE sobre tabla append-only en $FILE. Usa reversión, no mutación. Ver AUDIT_TRAIL_AND_IMMUTABILITY.md." ;;
      esac
    fi
    if printf '%s' "$CONTENT" | grep -qiE '\b(float|real|double precision|money)\b' && printf '%s' "$CONTENT" | grep -qiE 'create table|add column'; then
      bloquear "Tipo de punto flotante en un DDL ($FILE). Usa numeric(24,8)."
    fi
    ;;
esac

# 5. Lógica tributaria en UI.
case "$FILE_N" in
  *apps/web/src/*|*apps/mobile/*)
    if printf '%s' "$CONTENT" | grep -qE '(0\.16|0,16|IVA_RATE|IGTF_RATE|ALICUOTA)' ; then
      bloquear "Alícuota o tasa tributaria hard-coded en la UI ($FILE). Las tasas vienen del motor tributario versionado."
    fi
    ;;
esac

# 6. HANDOFF.md es acumulativo: un Write entero no puede dejar MENOS entregas de las que había.
#    La skill `handoff` decía «sobrescribe el anterior»; ahora dice lo contrario, pero una skill es
#    prosa, y la prosa se negocia. Esto no.
case "$FILE_N" in
  *docs/00_GOVERNANCE/HANDOFF.md)
    if [ "$(campo tool_name)" = "Write" ] && [ -f "$FILE" ]; then
      antes=$(grep -c '^# Handoff' "$FILE" 2>/dev/null || echo 0)
      despues=$(printf '%s' "$CONTENT" | grep -c '^# Handoff' || true)
      if [ "${despues:-0}" -lt "${antes:-0}" ]; then
        bloquear "Escribir HANDOFF.md entero dejaría $despues entregas donde hay $antes. Es acumulativo: la entrada nueva se AÑADE arriba (skill handoff)."
      fi
    fi
    ;;
esac

exit 0
