#!/usr/bin/env bash
# =============================================================================
# EL VEREDICTO DEL GATE — única fuente (CLAUDE.md §5).
#
# `pnpm run verify` tiene once pasos y tres maneras conocidas de dar un verde falso:
#   · leerlo a ojo por la cola del log (el módulo de clientes salió con lint en rojo, 2026-08-26);
#   · que Windows resuelva `verify` al builtin de cmd, que imprime «VERIFY is off.» y devuelve 0
#     (un log de dos líneas y un verde que no verificó nada — inventario, 2026-08-26);
#   · que un paso desaparezca y nadie cuente (un test menos no hace ruido).
# Este script es la única forma de leerlo. Lo usan el agente `validador`, la sesión principal y
# cualquier persona.
#
# USO
#   scripts/gate-verdict.sh run   [--base F] [--save-base F]    corre el gate y lo juzga
#   scripts/gate-verdict.sh judge LOG EXIT [--base F] [--save-base F]
#
#   --base F       compara con una línea base guardada: un test o un fichero menos es ROJO
#   --save-base F  guarda los conteos de esta corrida como línea base
#
# Sale 0 si el gate está VERDE y 1 si está ROJO. El informe va a la salida estándar.
# =============================================================================
set -uo pipefail

modo="${1:-}"
shift || true
LOG=""
EXIT=""
BASE=""
GUARDAR=""

if [ "$modo" = "run" ]; then
  LOG="$(mktemp -t ladino-verify.XXXXXX.log 2>/dev/null || echo "/tmp/ladino-verify.$$.log")"
  echo "corriendo: TURBO_CONCURRENCY=1 pnpm run verify  →  $LOG" >&2
  # `pnpm run verify`, NUNCA `pnpm verify`: el segundo puede caer en el builtin de cmd.
  TURBO_CONCURRENCY=1 pnpm run verify > "$LOG" 2>&1
  EXIT=$?
elif [ "$modo" = "judge" ]; then
  LOG="${1:-}"
  EXIT="${2:-}"
  shift 2 || true
else
  sed -n '2,24p' "$0" >&2
  exit 2
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --base|--save-base)
      # Sin valor, `shift 2` fallaba sin desplazar y el bucle no terminaba nunca.
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        echo "$1 necesita una ruta" >&2
        exit 2
      fi
      [ "$1" = "--base" ] && BASE="$2" || GUARDAR="$2"
      shift 2
      ;;
    *) echo "argumento desconocido: $1" >&2; exit 2 ;;
  esac
done

if [ ! -s "$LOG" ]; then
  echo "GATE rojo · el log «$LOG» no existe o está vacío"
  exit 1
fi

# Sin colores ANSI, que rompen los grep.
LIMPIO="$(sed 's/\x1b\[[0-9;]*m//g' "$LOG")"

pasos=$(printf '%s\n' "$LIMPIO" | grep -cE '^@ladino/[a-z-]+:(lint|typecheck|test|build)')
fallidos=$(printf '%s\n' "$LIMPIO" | grep -E '^ *Failed:' | head -5)
pgtap_ok=$(printf '%s\n' "$LIMPIO" | grep -c 'All tests successful')
pgtap_linea=$(printf '%s\n' "$LIMPIO" | grep -oE 'Files=[0-9]+, Tests=[0-9]+' | tail -1)
pgtap_ficheros=$(printf '%s' "$pgtap_linea" | sed -nE 's/Files=([0-9]+).*/\1/p')
pgtap_tests=$(printf '%s' "$pgtap_linea" | sed -nE 's/.*Tests=([0-9]+)/\1/p')
openapi_ok=$(printf '%s\n' "$LIMPIO" | grep -c 'openapi:check OK')
manifest_ok=$(printf '%s\n' "$LIMPIO" | grep -c 'release:manifest:check OK')

# vitest: una línea «Tests  N passed | M failed | K skipped (T)» por paquete.
vitest=$(printf '%s\n' "$LIMPIO" | grep -E '^@ladino/[a-z-]+:test: +Tests +' | awk '
  {
    n = 0; f = 0; s = 0
    if (match($0, /[0-9]+ passed/))  { n = substr($0, RSTART, RLENGTH) + 0 }
    if (match($0, /[0-9]+ failed/))  { f = substr($0, RSTART, RLENGTH) + 0 }
    if (match($0, /[0-9]+ skipped/)) { s = substr($0, RSTART, RLENGTH) + 0 }
    pas += n; fal += f; sal += s; paq++
  }
  END { printf "%d %d %d %d", pas + 0, fal + 0, sal + 0, paq + 0 }')
read -r vitest_pasan vitest_fallan vitest_saltan vitest_paquetes <<< "$vitest"

razones=()
[ "$EXIT" = "0" ] || razones+=("VERIFY EXIT=$EXIT")
# «Decenas» de líneas de paso: menos que eso es el builtin de cmd o un turbo que no corrió.
[ "${pasos:-0}" -ge 40 ] || razones+=("solo $pasos líneas de paso: el gate no corrió entero (¿builtin «verify» de cmd?)")
[ -z "$fallidos" ] || razones+=("turbo informa Failed: $(printf '%s' "$fallidos" | tr '\n' ' ')")
[ "$pgtap_ok" -ge 1 ] || razones+=("no aparece «All tests successful»: el pgTAP (paso 11) no pasó o no corrió")
[ "$openapi_ok" -ge 1 ] || razones+=("no aparece «openapi:check OK» (paso 8)")
[ "$manifest_ok" -ge 1 ] || razones+=("no aparece «release:manifest:check OK» (paso 9)")
[ "${vitest_fallan:-0}" -eq 0 ] || razones+=("vitest: $vitest_fallan tests fallan")

comparacion=""
if [ -n "$BASE" ]; then
  if [ ! -f "$BASE" ]; then
    razones+=("la línea base «$BASE» no existe")
  else
    # shellcheck disable=SC1090
    . "$BASE"
    # Las líneas de paso NO se comparan con la base: su número fluctúa entre corridas (736 y 743 con
    # más tests en la segunda). Para detectar el builtin de cmd basta el mínimo de 40 de arriba; lo que
    # se compara son los TESTS y los FICHEROS, que es donde un test menos tiene que doler.
    comparacion="vitest $vitest_pasan (base ${base_vitest:-?}) · pgTAP $pgtap_tests (base ${base_pgtap_tests:-?}) · ficheros pgTAP $pgtap_ficheros (base ${base_pgtap_ficheros:-?})"
    [ "${vitest_pasan:-0}" -ge "${base_vitest:-0}" ] || razones+=("vitest BAJÓ: $vitest_pasan < base $base_vitest — un test menos es rojo")
    [ "${pgtap_tests:-0}" -ge "${base_pgtap_tests:-0}" ] || razones+=("pgTAP BAJÓ: $pgtap_tests < base $base_pgtap_tests")
    [ "${pgtap_ficheros:-0}" -ge "${base_pgtap_ficheros:-0}" ] || razones+=("ficheros pgTAP BAJARON: $pgtap_ficheros < base $base_pgtap_ficheros")
  fi
fi

if [ ${#razones[@]} -eq 0 ]; then veredicto="verde"; else veredicto="rojo"; fi

echo "GATE $veredicto · pasos $pasos · vitest $vitest_pasan en $vitest_paquetes paquetes (saltados $vitest_saltan) · pgTAP $pgtap_tests en $pgtap_ficheros ficheros"
[ -n "$comparacion" ] && echo "  BASE: $comparacion"
echo "  VERIFY EXIT=$EXIT · openapi:check $([ "$openapi_ok" -ge 1 ] && echo OK || echo NO) · release:manifest:check $([ "$manifest_ok" -ge 1 ] && echo OK || echo NO) · All tests successful $([ "$pgtap_ok" -ge 1 ] && echo sí || echo NO)"
echo "  LOG: $LOG"
if [ ${#razones[@]} -gt 0 ]; then
  echo "  ROJO POR:"
  for r in "${razones[@]}"; do echo "   - $r"; done
fi

if [ -n "$GUARDAR" ] && [ "$veredicto" = "verde" ]; then
  mkdir -p "$(dirname "$GUARDAR")"
  {
    echo "# Línea base del gate — $(date -u +%Y-%m-%dT%H:%MZ). La escribe scripts/gate-verdict.sh."
    echo "base_vitest=$vitest_pasan"
    echo "base_pgtap_tests=$pgtap_tests"
    echo "base_pgtap_ficheros=$pgtap_ficheros"
  } > "$GUARDAR"
  echo "  línea base guardada en $GUARDAR"
fi

[ "$veredicto" = "verde" ]
