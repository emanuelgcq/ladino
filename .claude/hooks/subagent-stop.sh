#!/usr/bin/env bash
# SubagentStop — R8: el informe de cada agente del equipo trae los campos de su definición, o no
# vale. Si falta alguno, el agente NO termina: se le devuelve la lista (exit 2) y lo rehace UNA
# vez. A la segunda se le deja salir y se avisa con `systemMessage`: la sesión principal trata ese
# informe como inválido.
#
# ESTE HOOK FALLA ABIERTO, A PROPÓSITO. En SubagentStop, exit 2 no significa «bloqueado», significa
# «no puedes terminar»: si este hook fallara cerrado al no poder leer su entrada, ningún subagente
# terminaría nunca. Es un control de formato, no un guardián de seguridad; cuando no puede leer,
# deja pasar y lo dice.
#
# El reintento único se lleva con `stop_hook_active` si Claude Code lo manda, y si no, con una marca
# por `agent_id` en $TMPDIR/ladino-subagentstop/ (o, si no hay id, una por papel y por hora: nunca
# una marca compartida entre agentes distintos).
# Sin pipefail, como los guardianes: con él, un informe largo (más de ~64 KB) hacía que `grep -q`
# saliera antes, printf recibiera EPIPE y el campo pareciera AUSENTE — un rechazo falso (revisor).
set -u
INPUT=$(cat)

avisar() {  # sale 0 con un mensaje visible
  node -e 'process.stdout.write(JSON.stringify({systemMessage: process.argv[1]}))' "$1" 2>/dev/null || echo "$1"
  exit 0
}

command -v node >/dev/null 2>&1 || avisar "R8: no se pudo comprobar el formato del informe (no hay node). Revísalo a mano."

leer() {
  printf '%s' "$INPUT" | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      let v; try { v = JSON.parse(s); } catch { process.exit(3); }
      for (const k of process.argv[1].split(".")) { if (v == null) break; v = v[k]; }
      if (v != null) process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
    });' "$1"
}
leer agent_type >/dev/null 2>&1 || avisar "R8: no se pudo leer la entrada del hook; el formato del informe no se comprobó."

AGENTE=$(leer agent_type)
ID=$(leer agent_id)
INFORME=$(leer last_assistant_message)
YA_REINTENTADO=$(leer stop_hook_active)
RAIZ=$(leer cwd)
[ -z "$AGENTE" ] && exit 0

DIR="${TMPDIR:-/tmp}/ladino-subagentstop"
mkdir -p "$DIR" 2>/dev/null
# Qué campos manda DE VERDAD el runtime: la última entrada REAL se deja anotada para comprobarlo sin
# adivinar. Solo si trae `session_id` o `hook_event_name`, que la autoprueba no manda: si no, cada
# corrida de la autoprueba sobrescribiría la evidencia con sus propios campos simulados.
if [ -n "$(leer session_id)$(leer hook_event_name)" ]; then
  printf '%s' "$INPUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(Object.keys(JSON.parse(s)).join(" ")+"\n")}catch{}})' \
    > "$DIR/ultima-entrada-campos.txt" 2>/dev/null
fi

# Si el runtime no trae `last_assistant_message`, el informe se saca del transcript del agente: el
# último mensaje suyo con texto. Sin informe no se inventa un rechazo — se avisa.
if [ -z "$INFORME" ]; then
  TRANSCRIPT=$(leer agent_transcript_path)
  if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
    INFORME=$(node -e '
      const ls = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
      for (let i = ls.length - 1; i >= 0; i--) {
        let o; try { o = JSON.parse(ls[i]); } catch { continue; }
        const m = o.message ?? o;
        if ((o.type ?? m.role) !== "assistant") continue;
        const c = m.content;
        const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter(x => x.type === "text").map(x => x.text).join("\n") : "";
        if (t.trim()) { process.stdout.write(t); break; }
      }' "$TRANSCRIPT" 2>/dev/null)
  fi
fi

# SUPLENTES: si el runtime congeló la lista de agentes al abrir la sesión, cada papel lo hace un
# `general-purpose` que abre su informe con «ROL: <agente>». Durante un recorrido (marca en
# .recorrido/.suplentes-solo-lectura), un suplente SIN esa línea también se rechaza.
EQUIPO='^(validador|auditor-codigo|auditor-fiscal|estratega-producto|escritor-tests|reparador|revisor|spec-explorer)$'
faltan=()
if ! printf '%s' "$AGENTE" | grep -qE "$EQUIPO"; then
  ROL=$(printf '%s' "$INFORME" | sed -nE 's/^[[:space:]]*ROL:[[:space:]]*([a-z-]+).*/\1/p' | head -1)
  if [ -n "$ROL" ]; then
    AGENTE="$ROL"
  elif [ "$AGENTE" = "general-purpose" ] && [ -f "${RAIZ:-.}/.recorrido/.suplentes-solo-lectura" ]; then
    faltan+=("la primera línea «ROL: <agente>» (eres un suplente del equipo durante un recorrido)")
    AGENTE="suplente-sin-rol"
  else
    exit 0
  fi
fi

[ -z "$INFORME" ] && avisar "R8: no llegó el informe de $AGENTE (ni last_assistant_message ni transcript legible); su formato NO se comprobó."

# Un campo existe si su ETIQUETA abre una línea, en mayúsculas como en la definición: «TEST» dentro de
# una frase no cuenta.
tiene() { printf '%s' "$INFORME" | grep -qE "^[[:space:]]*($1)[[:space:]]*([:·=]|—)"; }
linea() { printf '%s' "$INFORME" | grep -E "^[[:space:]]*($1)[[:space:]]*([:·=]|—)" ; }
CITA='[A-Za-z0-9_./\\-]+\.(ts|tsx|sql|md|sh|json|mjs|cjs|js|yml|yaml):[0-9]+'

case "$AGENTE" in
  validador)
    # «GATE verde · pasos N …»: la etiqueta va seguida del veredicto, no de dos puntos.
    printf '%s' "$INFORME" | grep -qE '^[[:space:]]*GATE[[:space:]:]+(verde|rojo)' || faltan+=("GATE verde|rojo")
    for c in 'INVARIANTES' 'TIEMPOS' 'REGRESIONES'; do tiene "$c" || faltan+=("$c"); done
    ;;
  auditor-codigo)
    for c in 'HALLAZGOS' 'NO MIRADO'; do tiene "$c" || faltan+=("$c"); done
    if ! linea 'HALLAZGOS' | grep -qiE ':[[:space:]]*(ninguno|0)([[:space:]]|$)'; then
      for c in 'ID' 'DÓNDE|DONDE' 'QUÉ PASA|QUE PASA' 'CÓMO REPRODUCIRLO|COMO REPRODUCIRLO' '¿SE NOTA O TERMINA EN VERDE\?|SE NOTA'; do
        tiene "$c" || faltan+=("$c")
      done
      linea 'DÓNDE|DONDE' | grep -qE "$CITA" || faltan+=("R1: archivo:línea en DÓNDE")
    fi
    ;;
  auditor-fiscal)
    for c in 'HOMOLOGATION_IMPACT' 'VEREDICTO'; do tiene "$c" || faltan+=("$c"); done
    if tiene 'NORMA'; then
      for c in 'QUÉ HACE LADINO|QUE HACE LADINO' 'BRECHA' 'FUENTE'; do tiene "$c" || faltan+=("$c"); done
    else
      faltan+=("al menos un punto con NORMA")
    fi
    ;;
  estratega-producto)
    tiene 'PRIORIDAD' || faltan+=("PRIORIDAD")
    if tiene 'PRODUCTO'; then
      for c in 'PANTALLA' 'PROMETE' 'HACE' 'IMPACTO'; do tiene "$c" || faltan+=("$c"); done
    elif ! tiene 'MERCADO'; then
      faltan+=("PRODUCTO o MERCADO")
    fi
    ;;
  escritor-tests)
    for c in 'HALLAZGO' 'TEST' 'ESTADO'; do tiene "$c" || faltan+=("$c"); done
    linea 'ESTADO' | grep -qiE 'rojo|no reproducible' || faltan+=("ESTADO rojo|no reproducible")
    if ! linea 'ESTADO' | grep -qi 'no reproducible'; then
      linea 'TEST' | grep -qE "$CITA" || faltan+=("R1: archivo:línea en TEST")
    fi
    ;;
  reparador)
    for c in 'HALLAZGO' 'CAMBIO' 'MIGRACIÓN|MIGRACION' 'TEST' 'DOCS' 'PARÉ POR|PARE POR'; do tiene "$c" || faltan+=("$c"); done
    # Si paró por una decisión que no le toca, puede no haber cambio; si no, el cambio se cita.
    if ! linea 'PARÉ POR|PARE POR' | grep -qvE ':[[:space:]]*(—|-|ninguna|nada)?[[:space:]]*$'; then
      linea 'CAMBIO' | grep -qE "$CITA" || faltan+=("R1: archivo:línea en CAMBIO")
    fi
    ;;
  revisor)
    for c in 'VEREDICTO' 'RAZONES' 'ASERCIONES MODIFICADAS' 'DOCS' 'DEFINITION OF DONE'; do tiene "$c" || faltan+=("$c"); done
    linea 'VEREDICTO' | grep -qE 'aprobado|cambios|bloqueado' || faltan+=("VEREDICTO aprobado|cambios|bloqueado")
    # R1 en las razones — salvo un aprobado sin razones que dar.
    if ! { linea 'VEREDICTO' | grep -q 'aprobado' && linea 'RAZONES' | grep -qiE ':[[:space:]]*(ninguna|—|-)[[:space:]]*$'; }; then
      printf '%s' "$INFORME" | grep -qE "$CITA" || faltan+=("R1: archivo:línea en RAZONES")
    fi
    ;;
  spec-explorer)
    for c in 'ALCANCE' 'INVARIANTES' 'HUECOS' 'ARCHIVOS LEÍDOS|ARCHIVOS LEIDOS'; do tiene "$c" || faltan+=("$c"); done
    ;;
  suplente-sin-rol) ;;  # ya anotado arriba: le falta decir qué papel hace
  *) exit 0 ;;
esac

[ ${#faltan[@]} -eq 0 ] && exit 0

# ¿Ya se reintentó? Primero lo que diga Claude Code; si no lo dice, la marca propia.
if [ -n "$ID" ]; then
  MARCA="$DIR/$ID"
else
  # Sin id: una marca por PAPEL y por hora. No por hash del informe — cada informe rehecho tendría
  # otro hash y ganaría otro reintento, sin fin — ni compartida entre papeles distintos.
  MARCA="$DIR/sin-id-$AGENTE-$(date +%Y%m%d%H)"
fi
if [ "$YA_REINTENTADO" = "true" ] || [ -f "$MARCA" ]; then
  avisar "R8: el informe de $AGENTE sigue sin: ${faltan[*]}. Se entrega INVÁLIDO; trátalo como tal."
fi
touch "$MARCA" 2>/dev/null
{
  echo "R8 · Tu informe no tiene el formato de $AGENTE. Faltan estos campos obligatorios (cada ETIQUETA al principio de una línea, en mayúsculas):"
  for f in "${faltan[@]}"; do echo "  - $f"; done
  echo "Rehazlo en el formato EXACTO de tu definición (.claude/agents/$AGENTE.md). Es tu único reintento."
} >&2
exit 2
