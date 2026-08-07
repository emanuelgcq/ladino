#!/usr/bin/env bash
# PreToolUse sobre Bash. Protege la infraestructura compartida del VPS.
set -uo pipefail
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
block() { echo "BLOQUEADO POR HOOK: $1" >&2; exit 2; }

[ -z "$CMD" ] && exit 0

# n8n es infraestructura ajena a Ladino y no se toca nunca.
if echo "$CMD" | grep -qiE 'n8n'; then
  block "El comando menciona n8n. n8n es infraestructura compartida del VPS y está fuera del alcance de Ladino. No se toca."
fi

# Traefik ya existe y da servicio a otros proyectos.
if echo "$CMD" | grep -qiE '(docker[[:space:]]+(rm|stop|restart)[[:space:]]+.*traefik|compose.*down.*traefik)'; then
  block "Traefik ya está en producción sirviendo otros proyectos. Ladino solo agrega labels y redes, nunca reinicia el proxy."
fi

# Operaciones docker de alcance global.
if echo "$CMD" | grep -qE 'docker[[:space:]]+(system[[:space:]]+prune|volume[[:space:]]+prune|network[[:space:]]+prune)'; then
  block "Operación docker de alcance global en un VPS compartido. Prohibida."
fi
if echo "$CMD" | grep -qE 'docker[[:space:]]+compose[[:space:]]+down' && ! echo "$CMD" | grep -q 'ladino'; then
  block "'docker compose down' sin acotar al stack de Ladino. Usa '-p ladino' o el archivo compose de Ladino."
fi

# Producción.
if echo "$CMD" | grep -qE 'supabase[[:space:]]+db[[:space:]]+(reset|push).*--linked'; then
  block "Operación destructiva o de push contra el proyecto Supabase remoto. Requiere aprobación humana fuera de la sesión."
fi

exit 0
