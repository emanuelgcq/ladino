#!/usr/bin/env bash
# PreToolUse sobre Edit/Write/MultiEdit/NotebookEdit, Bash y las herramientas MCP — SOLO para
# subagentes.
#
# Claude Code añade `agent_type` a la entrada del hook cuando la llamada viene de un subagente.
# Sin ese campo es la sesión principal, y este hook no la toca: el dueño y la sesión principal
# siguen pudiendo hacer push, que es lo que manda CLAUDE.md §3.
#
# Hace cumplir, con exit 2 y no con prosa:
#   · el CONFINAMIENTO DE ESCRITURA de cada agente del equipo — por Edit/Write Y por Bash;
#   · R6: ningún agente hace push, despliega, entra al VPS ni toca la base remota — tampoco por MCP.
#
# Límite honesto: un agente decidido puede escribir con `node -e` o un script propio. Esto no es una
# jaula; es la barandilla que convierte un descuido en un error visible. La primera capa sigue
# siendo `tools`/`disallowedTools` en la definición de cada agente.
# SIN pipefail, a propósito: con él, `printf "$CONTENT" | grep -q` sobre un contenido de más de ~64 KB
# con la coincidencia al principio hacía que grep saliera antes, printf recibiera EPIPE, la tubería
# diera falso y el guardián APROBARA (revisor, 2026-09-24). Sin pipefail manda el estado de grep.
# Y sin globbing: los destinos se parten en palabras, y un `*` no puede expandirse a ficheros.
set -u
set -f
INPUT=$(cat)
if ! . "$(dirname "$0")/lib-json.sh"; then
  echo "BLOQUEADO POR HOOK: no se encuentra lib-json.sh junto a $0; un guardián que no puede leer no aprueba." >&2
  exit 2
fi

AGENTE=$(campo agent_type)
[ -z "$AGENTE" ] && exit 0

HERRAMIENTA=$(campo tool_name)
RUTA=$(campo tool_input.file_path)
[ -z "$RUTA" ] && RUTA=$(campo tool_input.notebook_path)
CMD=$(campo tool_input.command)
RAIZ_SESION=$(campo cwd)

# ── SUPLENTES ──────────────────────────────────────────────────────────────────
# Si el runtime congeló la lista de agentes al abrir la sesión, los papeles los hace
# `general-purpose` leyendo su definición. Mientras exista la marca `.recorrido/.suplentes-solo-lectura`
# (la pone quien conduce un recorrido, que solo usa papeles de lectura), un `general-purpose` se trata
# como un agente de SOLO LECTURA con memoria. Sin la marca, general-purpose sigue siendo genérico.
MARCA_SUPLENTES="${RAIZ_SESION:-.}/.recorrido/.suplentes-solo-lectura"
if [ "$AGENTE" = "general-purpose" ] && [ -f "$MARCA_SUPLENTES" ]; then
  AGENTE="suplente-lectura"
fi

# Ruta normalizada: '/', sin '//', y sin '..' (apps/web/test/../src NO es un test).
normalizar() {
  node -e 'const p=require("path").posix; process.stdout.write(p.normalize(process.argv[1].replace(/\\/g,"/")))' "$1"
}

LECTURA='^(validador|auditor-codigo|revisor|spec-explorer)$'

# ── MCP: GitHub y Supabase son el remoto (R6) ───────────────────────────────────
case "$HERRAMIENTA" in
  mcp__github__*)
    case "$HERRAMIENTA" in
      mcp__github__get_*|mcp__github__list_*|mcp__github__search_*) ;;
      *) bloquear "R6: $AGENTE no escribe en GitHub ($HERRAMIENTA). Push, PR y merge los hace la sesión principal." ;;
    esac
    ;;
  mcp__supabase__*|mcp__*supabase*)
    bloquear "R6: $AGENTE no usa el MCP de Supabase ($HERRAMIENTA): apunta al proyecto remoto. Usa la base LOCAL (127.0.0.1:54322)."
    ;;
esac

# ── Escritura por Edit/Write/MultiEdit/NotebookEdit ─────────────────────────────
if [ -n "$RUTA" ]; then
  RUTA_N=$(normalizar "$RUTA")
  permitido() { printf '%s' "$RUTA_N" | grep -qE "$1"; }
  if printf '%s' "$AGENTE" | grep -qE "$LECTURA"; then
    bloquear "$AGENTE es de SOLO LECTURA y ha intentado escribir en '$RUTA'. Encuentra y reporta; arreglar es del reparador."
  fi
  case "$AGENTE" in
    auditor-fiscal)
      permitido '(^|/)\.claude/agent-memory/auditor-fiscal/' \
        || bloquear "auditor-fiscal solo escribe en su memoria (.claude/agent-memory/auditor-fiscal/). Intentó '$RUTA'."
      ;;
    estratega-producto)
      permitido '(^|/)\.claude/agent-memory/estratega-producto/|(^|/)docs/08_UX/INFORMATION_ARCHITECTURE\.md$' \
        || bloquear "estratega-producto solo escribe en su memoria y en docs/08_UX/INFORMATION_ARCHITECTURE.md. Intentó '$RUTA'."
      ;;
    suplente-lectura)
      permitido '(^|/)\.claude/agent-memory/(auditor-fiscal|estratega-producto)/|(^|/)docs/08_UX/INFORMATION_ARCHITECTURE\.md$|(^|/)\.recorrido/' \
        || bloquear "Durante el recorrido, un suplente solo escribe en la memoria de su papel, en INFORMATION_ARCHITECTURE.md o en .recorrido/. Intentó '$RUTA'."
      ;;
    escritor-tests)
      # Ficheros de TEST, vivan donde vivan: también los *.test.ts que están junto a su código en src/.
      permitido '(^|/)apps/[^/]+/test/|(^|/)packages/[^/]+/test/|(^|/)supabase/tests/|\.(test|spec)\.(ts|tsx|js|mjs|cjs)$' \
        || bloquear "escritor-tests solo toca ficheros de test (apps/*/test, packages/*/test, supabase/tests, *.test.*). Intentó '$RUTA'. El código de producto es del reparador."
      ;;
  esac
fi

# ── Bash ─────────────────────────────────────────────────────────────────────────
if [ -n "$CMD" ]; then
  # Una sola línea: un heredoc no esconde nada partiendo el comando.
  C=$(printf '%s' "$CMD" | tr '\n' ' ')

  # R6 · push, en cualquiera de sus formas: `git push`, `git -C x push`, `bash -c 'git push'`, `$(git push)`.
  # Coste aceptado: un comando que solo CONTENGA el texto «git … push» también se bloquea.
  if printf '%s' "$C" | grep -qE '(^|[^[:alnum:]_-])git([[:space:]]+[^;&|[:space:]]+)*[[:space:]]+push([[:space:]]|$|["'\'';)&|])'; then
    bloquear "R6: $AGENTE no hace push. El push lo hace la sesión principal cuando el validador sale en verde."
  fi
  # R6 · la CLI de GitHub: la versión Bash del MCP de GitHub (`gh` está instalado y autenticado en la
  # máquina del dueño). Deja pasar solo los verbos de lectura (una lista negra de escritura se dejaba
  # `gh label create`, `gh run delete`, `gh pr -R o/r merge`). ES UNA BARANDILLA CONTRA DESCUIDOS,
  # NO UNA LISTA BLANCA ESTANCA (revisor, 2026-09-24; R-51): se evade con el valor pegado a la opción
  # (`-fclave=valor` en `gh api`), con un verbo de lectura como valor de una opción que el hook no
  # conoce, con `gh.exe`, una ruta absoluta o el nombre entre comillas, y no sabe qué hace un alias o
  # una extensión. Coste aceptado: `gh --version 2>&1` y un grep cuyo patrón contenga «gh » se bloquean.
  gh_de_lectura() {  # $1 = el tramo que empieza en `gh`
    local w salta=0 grupo="" verbo=""
    for w in $1; do
      if [ "$salta" = 1 ]; then salta=0; continue; fi
      case "$w" in
        gh) continue ;;
        -R|--repo|-X|--method|-H|--header|-q|--jq|-t|--template|--hostname|--json) salta=1; continue ;;
        -*) continue ;;
      esac
      if [ -z "$grupo" ]; then grupo="$w"; elif [ -z "$verbo" ]; then verbo="$w"; break; fi
    done
    case "$grupo" in
      ""|help|version|--version|status|search) return 0 ;;
      auth) [ "$verbo" = status ] ;;
      api) # GET sin cuerpo: ni método de escritura ni campos (-f/-F implican POST).
        ! printf '%s' "$1" | grep -qE '(-X|--method)[[:space:]=]*(POST|PUT|PATCH|DELETE)|[[:space:]](-f|-F|--field|--raw-field|--input)([[:space:]=]|$)' ;;
      *) case "$verbo" in view|list|ls|status|diff|checks|watch) return 0 ;; *) return 1 ;; esac ;;
    esac
  }
  while IFS= read -r tramo; do
    [ -z "$tramo" ] && continue
    tramo="gh${tramo#*gh}"
    gh_de_lectura "$tramo" || bloquear "R6: $AGENTE solo usa gh para LEER (view, list, status, diff, checks, api GET). Escribir en GitHub es de la sesión principal. Tramo: '$tramo'."
  done <<EOF_GH
$(printf '%s' "$C" | grep -oE '(^|[^[:alnum:]_./-])gh[[:space:]][^;&|]*')
EOF_GH
  # R6 · la CLI de Supabase contra el remoto.
  if printf '%s' "$C" | grep -qE 'supabase([[:space:]]+[^;&|[:space:]]+)*[[:space:]]+(db[[:space:]]+push|link|functions[[:space:]]+deploy|secrets[[:space:]]+set|projects)' \
     || printf '%s' "$C" | grep -qE 'supabase[^;&|]*(--linked|--project-ref|--db-url)'; then
    bloquear "R6: $AGENTE no toca el proyecto Supabase remoto (push, link, deploy, --linked, --project-ref, --db-url)."
  fi
  if printf '%s' "$C" | grep -qE '(^|[;&|[:space:]`$(])(ssh|scp|rsync|sftp)[[:space:]]'; then
    bloquear "R6: $AGENTE no entra al VPS. El despliegue es del dueño."
  fi
  if printf '%s' "$C" | grep -qiE 'api\.supabase\.com|supabase-token|SUPABASE_ACCESS_TOKEN|supabase\.co([^[:alnum:]]|$)|pooler\.supabase'; then
    bloquear "R6: $AGENTE no usa la Management API, credenciales de gestión ni hosts de Supabase Cloud."
  fi
  # R6 · Postgres: TODOS los hosts que aparezcan tienen que ser locales.
  hosts=$(printf '%s' "$C" | grep -oE 'postgres(ql)?://[^@[:space:]]*@[^:/[:space:]"'\'']+' | sed -E 's/.*@//')
  hosts="$hosts $(printf '%s' "$C" | grep -oE 'host=[^[:space:]"'\'']+' | sed 's/host=//')"
  # `-h` se mira en TODO el comando. Acotarlo al «tramo» de psql dejó pasar `psql -c "…;" -h remoto`,
  # `psql.exe -h` y `pg_basebackup -h` (revisor, 2026-09-24). Coste aceptado: `grep -h`, `du -h` y
  # `df -h` también se bloquean — usa la herramienta Grep, `du --human-readable`, `df --human-readable`.
  hosts="$hosts $(printf '%s' "$C" | grep -oE '(^|[[:space:]])(-h|--host)[[:space:]=]*[^[:space:]"'\'']+' | sed -E 's/.*(-h|--host)[[:space:]=]*//')"
  for h in $hosts; do
    case "$h" in
      127.0.0.1|localhost|::1|"") ;;
      *) bloquear "R6: $AGENTE solo habla con la base LOCAL (127.0.0.1). El comando apunta a '$h'." ;;
    esac
  done
  if printf '%s' "$C" | grep -qiE 'docker[[:space:]]+compose[[:space:]]+(up|down|restart|pull)|eas[[:space:]]+(build|submit)|vercel[[:space:]]+(deploy|--prod)'; then
    bloquear "R6: $AGENTE no despliega."
  fi

  # Confinamiento por Bash: los de SOLO LECTURA no escriben tampoco por la terminal.
  if printf '%s' "$AGENTE" | grep -qE "$LECTURA|^suplente-lectura$"; then
    # Órdenes que escriben. rm/mv/… en cualquier palabra (como siempre); cp/touch/install/ln/dd solo
    # en POSICIÓN DE ORDEN, para no confundir `pnpm install`, `docker cp` o `const cp = …` con ellas.
    POS='(^|[;&|(`'\''"]|xargs([[:space:]]+-[^[:space:]]+)*|-exec(dir)?)[[:space:]]*'
    if printf '%s' "$C" | grep -qE '(^|[;&|[:space:]])(sed|perl)[[:space:]]+(-[a-zA-Z]*i|--in-place)' \
       || printf '%s' "$C" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?(commit|add|rm|mv|checkout|restore|reset|stash|apply|am|cherry-pick|merge|rebase|revert|tag|clean)([[:space:]]|$)' \
       || printf '%s' "$C" | grep -qE '(^|[;&|[:space:]])(rm|rmdir|mv|truncate|shred)[[:space:]]' \
       || printf '%s' "$C" | grep -qE "${POS}(sudo[[:space:]]+)?(cp|touch|install|ln|dd)[[:space:]]"; then
      bloquear "$AGENTE es de SOLO LECTURA: tampoco modifica el repo desde la terminal (sed -i, git commit/add/checkout…, rm, mv, cp, touch)."
    fi

    # ¿Adónde puede ir la salida de un agente de solo lectura? A un temporal, a /dev/null, a
    # .recorrido/ o a su memoria local. TMPDIR solo cuenta si está definido: vacío, "$TMPDIR"* sería
    # * y aprobaría cualquier destino.
    destino_permitido() {
      local d="$1"
      d="${d#\"}"; d="${d%\"}"; d="${d#\'}"; d="${d%\'}"
      if [ -n "${TMPDIR:-}" ] && [ "${d#"$TMPDIR"}" != "$d" ]; then return 0; fi
      case "$d" in
        /dev/null|/dev/stdout|/dev/stderr|/tmp/*|/c/tmp/*|C:/tmp/*|*/Temp/*|*\\Temp\\*|*/AppData/Local/Temp/*) return 0 ;;
        .recorrido/*|*/.recorrido/*|.claude/agent-memory-local/*|*/.claude/agent-memory-local/*) return 0 ;;
        '$TMPDIR'/*|'${TMPDIR}'/*|'$TEMP'/*|'${TEMP}'/*|'$TMP'/*|'${TMP}'/*) return 0 ;;
      esac
      return 1
    }

    # Todo `>` del comando cuenta como redirección, esté donde esté: neutralizar los que van entre
    # comillas abrió once salidas (`echo "$(… > f)"`, `eval`, `bash -x -c`, un apóstrofo en un
    # comentario…; revisor, 2026-09-24). UNA sola excepción, estrecha a propósito: el SQL de
    # `psql -c '…'` entre comillas SIMPLES, que es el trabajo diario de un auditor
    # (`… where debit_amount > 0`). Solo se aplica si el comando es de una línea y no tiene comillas
    # dobles, barras invertidas (`\!` de psql ejecuta shell), comillas invertidas, `$'`, heredoc ni
    # apóstrofos sin pareja, y si la cadena es el argumento de `-c` de un psql que ABRE su tramo
    # (`psql …` o `docker exec … <contenedor> psql …`; no `watch psql`, que pasa por un shell).
    N="$C"
    if [ "$CMD" = "$C" ] && ! printf '%s' "$C" | grep -qE '["\\`]|\$'\''|<<' \
       && [ $(( $(printf '%s' "$C" | tr -cd "'" | wc -c) % 2 )) -eq 0 ] \
       && printf '%s' "$C" | grep -qE '(^|[[:space:]])psql([[:space:]]|$)'; then
      NEUTRO=$(printf '%s' "$C" | awk 'BEGIN { RS = "\001"; ORS = "" } {
        s = $0; n = length(s); q = 0; seg = ""; out = ""; neutro = 0
        for (i = 1; i <= n; i++) {
          c = substr(s, i, 1)
          if (!q) {
            if (c == "\047") {
              q = 1
              neutro = (seg ~ /^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*((docker|podman)[[:space:]]+exec([[:space:]]+-[A-Za-z]+)*[[:space:]]+[^[:space:]-][^[:space:]]*[[:space:]]+)?psql([[:space:]]|$)/ \
                        && seg ~ /(^|[[:space:]])(-c[[:space:]]*|--command[[:space:]]+|--command=)$/)
            } else if (c ~ /[;&|()]/) seg = ""
            else seg = seg c
          } else if (c == "\047") { q = 0; seg = seg "Q" }
          else if (neutro && (c == ">" || c == "<")) c = " "
          out = out c
        }
        print out
      }') && [ -n "$NEUTRO" ] && N="$NEUTRO"
      # Si awk falla, N se queda en C: sin excepción, que es el lado que bloquea (falla cerrado).
    fi

    # Toda redirección de salida: `>`, `>>`, `1>`, `2>`, `&>`, `>|`, `<>`. `2>&1` duplica un
    # descriptor: su destino empieza por `&` y esta búsqueda no lo recoge.
    for d in $(printf '%s' "$N" | grep -oE '(&|[0-9]*)>{1,2}\|?[[:space:]]*[^[:space:]|;<>&()]+' | sed -E 's/^[^>]*>+\|?[[:space:]]*//'); do
      destino_permitido "$d" || bloquear "$AGENTE es de SOLO LECTURA: no redirige salida a '$d'. Usa un temporal (/tmp, \$TMPDIR) o .recorrido/."
    done
    # `>&fichero` también escribe: solo `>&N` y `>&-` son descriptores.
    for d in $(printf '%s' "$N" | grep -oE '>&[[:space:]]*[^[:space:]|;<>&()]+' | sed -E 's/^>&[[:space:]]*//'); do
      # Sin la comilla de cierre que arrastra el tramo: `bash -c "… 2>&1"` deja `1"`, que es un descriptor.
      case "${d%[\"\']}" in *[!0-9-]*) destino_permitido "$d" || bloquear "$AGENTE es de SOLO LECTURA: no redirige salida a '$d' (>&)." ;; esac
    done
    # `tee` escribe en sus argumentos: se mira en posición de orden (tras `|`, `;`, `(`…).
    while IFS= read -r tramo; do
      [ -z "$tramo" ] && continue
      for d in ${tramo#*tee}; do   # lo que va DESPUÉS del primer «tee» del tramo
        case "$d" in -*) continue ;; esac
        destino_permitido "$d" || bloquear "$AGENTE es de SOLO LECTURA: no escribe con tee en '$d'. Usa un temporal o .recorrido/."
      done
    done <<EOF_TEE
$(printf '%s' "$N" | grep -oE "${POS}tee([[:space:]][^|;&<>]*)?")
EOF_TEE
  fi
fi

exit 0
