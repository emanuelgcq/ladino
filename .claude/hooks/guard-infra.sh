#!/usr/bin/env bash
# PreToolUse sobre Bash. Protege la infraestructura compartida del VPS.
# Lee el JSON con lib-json.sh (Node), no con jq: sin jq, esto aprobaba todo (2026-09-24).
# SIN pipefail, a propósito: con él, `printf "$CONTENT" | grep -q` sobre un contenido de más de ~64 KB
# con la coincidencia al principio hacía que grep saliera antes, printf recibiera EPIPE, la tubería
# diera falso y el guardián APROBARA (revisor, 2026-09-24). Sin pipefail manda el estado de grep.
set -u
INPUT=$(cat)
if ! . "$(dirname "$0")/lib-json.sh"; then
  echo "BLOQUEADO POR HOOK: no se encuentra lib-json.sh junto a $0; un guardián que no puede leer no aprueba." >&2
  exit 2
fi

CMD=$(campo tool_input.command)
[ -z "$CMD" ] && exit 0

# n8n es infraestructura ajena a Ladino y no se toca nunca.
if echo "$CMD" | grep -qiE 'n8n'; then
  bloquear "El comando menciona n8n. n8n es infraestructura compartida del VPS y está fuera del alcance de Ladino. No se toca."
fi

# Traefik ya existe y da servicio a otros proyectos.
if echo "$CMD" | grep -qiE '(docker[[:space:]]+(rm|stop|restart)[[:space:]]+.*traefik|compose.*down.*traefik)'; then
  bloquear "Traefik ya está en producción sirviendo otros proyectos. Ladino solo agrega labels y redes, nunca reinicia el proxy."
fi

# Operaciones docker de alcance global.
if echo "$CMD" | grep -qE 'docker[[:space:]]+(system[[:space:]]+prune|volume[[:space:]]+prune|network[[:space:]]+prune)'; then
  bloquear "Operación docker de alcance global en un VPS compartido. Prohibida."
fi
if echo "$CMD" | grep -qE 'docker[[:space:]]+compose[[:space:]]+down' && ! echo "$CMD" | grep -q 'ladino'; then
  bloquear "'docker compose down' sin acotar al stack de Ladino. Usa '-p ladino' o el archivo compose de Ladino."
fi

# Producción.
if echo "$CMD" | grep -qE 'supabase[[:space:]]+db[[:space:]]+(reset|push).*--linked'; then
  bloquear "Operación destructiva o de push contra el proyecto Supabase remoto. Requiere aprobación humana fuera de la sesión."
fi

exit 0
