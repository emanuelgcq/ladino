#!/usr/bin/env bash
# =============================================================================
# AUTOPRUEBA DE LOS HOOKS — cada guardián tiene que VERSE fallar (familia F4).
#
# El 2026-09-24 se descubrió que los tres guardianes aprobaban TODO en la máquina del dueño: leían
# el JSON con `jq`, `jq` no estaba instalado, el campo salía vacío y el hook salía con exit 0.
# CLAUDE.md §2 decía «hay hooks que las bloquean». No bloqueaban. Nadie lo vio porque un guardián
# que no dispara es indistinguible de uno que no tiene nada que disparar.
#
# Esto le da a cada guardián entradas que TIENE que bloquear y entradas que TIENE que dejar pasar,
# igual que `pnpm boundaries:selftest` hace con las fronteras.
#   uso: bash scripts/hooks-selftest.sh      (sale 1 si alguna expectativa falla)
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
H=.claude/hooks
fallos=0
casos=0

espera() {  # espera <exit esperado> <hook> <descripción> <json>
  local esperado="$1" hook="$2" desc="$3" json="$4" real
  casos=$((casos + 1))
  # Un fixture que no es JSON hace que los guardianes bloqueen (fallan cerrados) y que subagent-stop
  # deje pasar (falla abierto): cualquier `espera` pasaría POR ESA RAZÓN, con el arreglo y sin él.
  # Solo los casos que dicen probar la entrada ilegible pueden traer un fixture inválido.
  if ! printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{JSON.parse(s)}catch{process.exit(1)}})'; then
    case "$desc" in
      *"no es JSON"*|*ilegible*) ;;
      *) printf '  ✗ %-24s %s  (FIXTURE INVÁLIDO: no es JSON)\n' "$hook" "$desc"; fallos=$((fallos + 1)); return ;;
    esac
  fi
  printf '%s' "$json" | bash "$H/$hook" >/dev/null 2>&1
  real=$?
  if [ "$real" = "$esperado" ]; then
    printf '  ✓ %-24s %s\n' "$hook" "$desc"
  else
    printf '  ✗ %-24s %s  (esperado exit %s, salió %s)\n' "$hook" "$desc" "$esperado" "$real"
    fallos=$((fallos + 1))
  fi
}

echo "── Ninguno depende de jq (la causa del apagón) ──"
casos=$((casos + 1))
# Solo líneas de CÓDIGO: los comentarios que cuentan por qué se quitó jq no cuentan.
usan_jq=$(grep -lE '^[^#]*(^|[^-[:alnum:]_])jq\b' $H/*.sh)   # `--jq` es una opción de gh, no jq
if [ -n "$usan_jq" ]; then
  echo "  ✗ algún hook vuelve a usar jq: $(printf '%s' "$usan_jq" | tr '\n' ' ')"
  fallos=$((fallos + 1))
else
  echo "  ✓ ningún hook usa jq"
fi

echo "── guard-immutability: tiene que BLOQUEAR ──"
espera 2 guard-immutability.sh "editar una migración ya aplicada" \
  '{"tool_input":{"file_path":"supabase/migrations/20260918150000_two_controls_that_nobody_had.sql","new_string":"x"}}'
espera 2 guard-immutability.sh "service_role en la web" \
  '{"tool_input":{"file_path":"apps/web/src/x.ts","content":"const k = SUPABASE_SERVICE_ROLE_KEY"}}'
espera 2 guard-immutability.sh "number para un importe en domain" \
  '{"tool_input":{"file_path":"packages/domain/src/x.ts","content":"interface A { amount: number }"}}'
espera 2 guard-immutability.sh "parseFloat en money" \
  '{"tool_input":{"file_path":"packages/money/src/x.ts","content":"const a = parseFloat(b)"}}'
espera 2 guard-immutability.sh "DELETE de journal_lines en una migración nueva" \
  '{"tool_input":{"file_path":"supabase/migrations/29990101000000_nueva.sql","content":"delete from public.journal_lines where true;"}}'
espera 2 guard-immutability.sh "alícuota fija en la web" \
  '{"tool_input":{"file_path":"apps/web/src/x.tsx","content":"const iva = 0.16"}}'
espera 2 guard-immutability.sh "DELETE de inventory_moves por psql" \
  '{"tool_input":{"command":"psql -c \"delete from inventory_moves where id = 1\""}}'
espera 2 guard-immutability.sh "entrada que no es JSON (falla CERRADO)" 'esto no es json'
echo "── guard-immutability: tiene que DEJAR PASAR ──"
espera 0 guard-immutability.sh "migración NUEVA" \
  '{"tool_input":{"file_path":"supabase/migrations/29990101000000_nueva.sql","content":"create table public.x (id uuid);"}}'
espera 0 guard-immutability.sh "pgTAP que prueba el rechazo del DELETE" \
  '{"tool_input":{"file_path":"supabase/tests/999_x_test.sql","content":"select throws_ok($$delete from journal_lines$$);"}}'
espera 0 guard-immutability.sh "un grep que BUSCA el texto" \
  '{"tool_input":{"command":"grep -rn \"delete from journal_lines\" supabase/"}}'

espera 2 guard-immutability.sh "service_role en un MultiEdit (edits[])" \
  '{"tool_name":"MultiEdit","tool_input":{"file_path":"apps/web/src/x.ts","edits":[{"old_string":"a","new_string":"const k = SERVICE_ROLE_KEY"}]}}'
espera 2 guard-immutability.sh "DELETE partido en dos líneas (heredoc)" \
  '{"tool_input":{"command":"psql <<SQL\ndelete\nfrom journal_lines;\nSQL"}}'
espera 2 guard-immutability.sh "Write que deja HANDOFF.md con menos entregas" \
  '{"tool_name":"Write","tool_input":{"file_path":"docs/00_GOVERNANCE/HANDOFF.md","content":"# Handoff — una sola\n"}}'

echo "── guard-immutability: contenido grande (N1) y todas las formas de mutar (N6) ──"
# N1: con pipefail, más de ~64 KB con la coincidencia al PRINCIPIO → grep -q sale antes, printf da
# EPIPE, la tubería da falso y el guardián aprobaba.
RELLENO=$(head -c 300000 /dev/zero | tr '\0' 'x')
espera 2 guard-immutability.sh "service_role en la 1.ª línea de un Write de 300 KB" \
  "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"apps/web/src/x.ts\",\"content\":\"const k = SERVICE_ROLE_KEY\\n$RELLENO\"}}"
espera 0 guard-immutability.sh "Write de 300 KB limpio en la web" \
  "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"apps/web/src/x.ts\",\"content\":\"const k = 1\\n$RELLENO\"}}"
espera 2 guard-immutability.sh "TRUNCATE de journal_lines en una migración nueva" \
  '{"tool_input":{"file_path":"supabase/migrations/29990101000000_nueva.sql","content":"truncate public.journal_lines;"}}'
espera 2 guard-immutability.sh "DELETE FROM ONLY audit_events en una migración nueva" \
  '{"tool_input":{"file_path":"supabase/migrations/29990101000000_nueva.sql","content":"delete from only public.audit_events;"}}'
espera 0 guard-immutability.sh "trigger «before truncate on» (lo que protege, no lo que muta)" \
  '{"tool_input":{"file_path":"supabase/migrations/29990101000000_nueva.sql","content":"create trigger t before truncate on public.journal_lines for each statement execute function f();"}}'
espera 2 guard-immutability.sh "TRUNCATE en lista (public.x, public.journal_lines)" \
  '{"tool_input":{"file_path":"supabase/migrations/29990101000000_nueva.sql","content":"truncate public.x, public.journal_lines;"}}'
espera 2 guard-immutability.sh "DELETE con el nombre entre comillas" \
  '{"tool_input":{"file_path":"supabase/migrations/29990101000000_nueva.sql","content":"delete from public.\"audit_events\" where true;"}}'
espera 0 guard-immutability.sh "journal_lines_archive no es journal_lines" \
  '{"tool_input":{"file_path":"supabase/migrations/29990101000000_nueva.sql","content":"delete from public.journal_lines_archive;"}}'
espera 0 guard-immutability.sh "revoke update, delete, truncate on … (quitar permisos no es mutar)" \
  '{"tool_input":{"file_path":"supabase/migrations/29990101000000_nueva.sql","content":"revoke update, delete, truncate on public.journal_lines from anon;"}}'
espera 2 guard-immutability.sh "TRUNCATE en lista por psql" \
  '{"tool_input":{"command":"psql -c \"truncate public.x, public.inventory_moves\""}}'

echo "── los guardianes FALLAN CERRADOS si no encuentran su librería ──"
TMPH=$(mktemp -d)
for g in guard-immutability.sh guard-infra.sh guard-agentes.sh; do
  cp "$H/$g" "$TMPH/$g"   # copia SIN lib-json.sh al lado
  casos=$((casos + 1))
  printf '%s' '{"agent_type":"reparador","tool_input":{"command":"docker restart n8n"}}' | bash "$TMPH/$g" >/dev/null 2>&1
  r=$?
  if [ "$r" = "2" ]; then printf '  ✓ %-24s %s\n' "$g" "sin lib-json.sh, bloquea"; else printf '  ✗ %-24s %s (salió %s)\n' "$g" "sin lib-json.sh APRUEBA" "$r"; fallos=$((fallos + 1)); fi
done
rm -rf "$TMPH"

echo "── guard-infra: tiene que BLOQUEAR ──"
espera 2 guard-infra.sh "reiniciar n8n" '{"tool_input":{"command":"docker restart n8n"}}'
espera 2 guard-infra.sh "prune global de docker" '{"tool_input":{"command":"docker system prune -af"}}'
espera 2 guard-infra.sh "compose down sin acotar" '{"tool_input":{"command":"docker compose down"}}'
espera 2 guard-infra.sh "db push al remoto" '{"tool_input":{"command":"supabase db push --linked"}}'
# N1 en guard-infra: `echo "$CMD" | grep -q` lee por LÍNEAS; n8n en la primera y 300 KB detrás hacían
# salir a grep antes, echo recibía EPIPE y, con pipefail, el guardián aprobaba.
espera 2 guard-infra.sh "n8n en la 1.ª línea de un comando de 300 KB" \
  "{\"tool_input\":{\"command\":\"docker restart n8n\\necho $RELLENO\"}}"
echo "── guard-infra: tiene que DEJAR PASAR ──"
espera 0 guard-infra.sh "pnpm run verify" '{"tool_input":{"command":"pnpm run verify"}}'

echo "── guard-agentes: la sesión principal NO se toca ──"
espera 0 guard-agentes.sh "push desde la sesión principal" '{"tool_input":{"command":"git push"}}'
echo "── guard-agentes: tiene que BLOQUEAR a los agentes ──"
espera 2 guard-agentes.sh "push de un agente (R6)" '{"agent_type":"reparador","tool_input":{"command":"git push"}}'
espera 2 guard-agentes.sh "Management API desde un agente" '{"agent_type":"validador","tool_input":{"command":"curl https://api.supabase.com/v1/projects"}}'
espera 2 guard-agentes.sh "ssh al VPS desde un agente" '{"agent_type":"reparador","tool_input":{"command":"ssh root@vps"}}'
espera 2 guard-agentes.sh "psql a una base remota" '{"agent_type":"auditor-codigo","tool_input":{"command":"psql postgres://u:p@db.example.com:5432/x"}}'
espera 2 guard-agentes.sh "validador escribiendo" '{"agent_type":"validador","tool_name":"Write","tool_input":{"file_path":"apps/web/src/x.ts"}}'
espera 2 guard-agentes.sh "escritor-tests tocando producto" '{"agent_type":"escritor-tests","tool_name":"Edit","tool_input":{"file_path":"packages/domain/src/x.ts"}}'
espera 2 guard-agentes.sh "auditor-fiscal fuera de su memoria" '{"agent_type":"auditor-fiscal","tool_name":"Write","tool_input":{"file_path":"docs/02_COMPLIANCE/X.md"}}'
echo "── guard-agentes: los huecos que encontró el revisor, cerrados ──"
espera 2 guard-agentes.sh "git -C <dir> push" '{"agent_type":"reparador","tool_input":{"command":"git -C C:/repo push origin main"}}'
espera 2 guard-agentes.sh "bash -c git push" "{\"agent_type\":\"reparador\",\"tool_input\":{\"command\":\"bash -c 'git push'\"}}"
espera 2 guard-agentes.sh "\$(git push)" '{"agent_type":"reparador","tool_input":{"command":"echo $(git push)"}}'
espera 2 guard-agentes.sh "psql -h a Supabase Cloud" '{"agent_type":"auditor-codigo","tool_input":{"command":"psql -h db.xyz.supabase.co -U postgres"}}'
espera 2 guard-agentes.sh "psql host= remoto" "{\"agent_type\":\"auditor-codigo\",\"tool_input\":{\"command\":\"psql 'host=aws-0.pooler.supabase.com dbname=postgres'\"}}"
espera 2 guard-agentes.sh "remota y local en el mismo comando" '{"agent_type":"auditor-codigo","tool_input":{"command":"pg_dump postgres://u:p@db.example.com:5432/x | psql postgres://postgres:postgres@127.0.0.1:54322/postgres"}}'
espera 2 guard-agentes.sh "supabase functions deploy" '{"agent_type":"reparador","tool_input":{"command":"supabase functions deploy x"}}'
espera 2 guard-agentes.sh "supabase --workdir . db push" '{"agent_type":"reparador","tool_input":{"command":"supabase --workdir . db push"}}'
espera 2 guard-agentes.sh "MCP de GitHub: push_files" '{"agent_type":"migration-author","tool_name":"mcp__github__push_files","tool_input":{}}'
espera 2 guard-agentes.sh "MCP de GitHub: merge_pull_request" '{"agent_type":"mobile-expo","tool_name":"mcp__github__merge_pull_request","tool_input":{}}'
espera 2 guard-agentes.sh "MCP de Supabase: execute_sql" '{"agent_type":"migration-author","tool_name":"mcp__supabase__execute_sql","tool_input":{"query":"select 1"}}'
espera 2 guard-agentes.sh "revisor con sed -i" '{"agent_type":"revisor","tool_input":{"command":"sed -i s/a/b/ packages/x.ts"}}'
espera 2 guard-agentes.sh "revisor con git commit -am" '{"agent_type":"revisor","tool_input":{"command":"git commit -am x"}}'
espera 2 guard-agentes.sh "revisor redirigiendo a un fichero del repo" '{"agent_type":"revisor","tool_input":{"command":"echo x > packages/x.ts"}}'
casos=$((casos + 1))   # lo mismo SIN TMPDIR: así salía 1 (error no bloqueante) y la escritura pasaba
printf '%s' '{"agent_type":"revisor","tool_input":{"command":"echo x > packages/x.ts"}}' | env -u TMPDIR bash "$H/guard-agentes.sh" >/dev/null 2>&1
r=$?
if [ "$r" = "2" ]; then printf '  ✓ %-24s %s\n' "guard-agentes.sh" "sin TMPDIR también bloquea"; else printf '  ✗ %-24s %s (salió %s)\n' "guard-agentes.sh" "sin TMPDIR NO bloquea" "$r"; fallos=$((fallos + 1)); fi
espera 2 guard-agentes.sh "escritor-tests con ../ hacia src" '{"agent_type":"escritor-tests","tool_name":"Write","tool_input":{"file_path":"apps/web/test/../src/main.tsx"}}'
echo "── guard-agentes: revisiones 2 y 3 — tiene que BLOQUEAR ──"
# R6 · `-h` en TODO el comando (acotarlo al tramo de psql dejó pasar estos tres).
espera 2 guard-agentes.sh "psql -c \"…;\" -h remoto" '{"agent_type":"auditor-codigo","tool_input":{"command":"psql -U postgres -c \"select 1;\" -h evil.example.com"}}'
espera 2 guard-agentes.sh "pg_basebackup -h remoto" '{"agent_type":"auditor-codigo","tool_input":{"command":"pg_basebackup -h evil.example.com -D x"}}'
espera 2 guard-agentes.sh "psql.exe -h remoto" '{"agent_type":"auditor-codigo","tool_input":{"command":"psql.exe -h evil.example.com -c \"select 1\""}}'
# Redirecciones: todas las formas, y las once salidas que abrió neutralizar comillas.
espera 2 guard-agentes.sh "revisor: 1>fichero" '{"agent_type":"revisor","tool_input":{"command":"echo x 1>packages/x.ts"}}'
espera 2 guard-agentes.sh "revisor: 2>fichero" '{"agent_type":"revisor","tool_input":{"command":"cmd 2>packages/x.log"}}'
espera 2 guard-agentes.sh "revisor: &>fichero" '{"agent_type":"revisor","tool_input":{"command":"cmd &>packages/x.log"}}'
espera 2 guard-agentes.sh "revisor: >|fichero" '{"agent_type":"revisor","tool_input":{"command":"echo x >|packages/x.ts"}}'
espera 2 guard-agentes.sh "revisor: >&fichero" '{"agent_type":"revisor","tool_input":{"command":"echo x >&packages/x.ts"}}'
espera 2 guard-agentes.sh "revisor: >& fichero" '{"agent_type":"revisor","tool_input":{"command":"echo x >& packages/x.ts"}}'
espera 2 guard-agentes.sh "revisor: <>fichero (lectura-escritura)" '{"agent_type":"revisor","tool_input":{"command":"cat <>packages/x.ts"}}'
espera 2 guard-agentes.sh "revisor: >\$PWD/f" '{"agent_type":"revisor","tool_input":{"command":"echo x >$PWD/f"}}'
espera 2 guard-agentes.sh "revisor: > \"fichero entre comillas\"" '{"agent_type":"revisor","tool_input":{"command":"echo x > \"packages/x.ts\""}}'
espera 2 guard-agentes.sh "revisor: \"\$(… > f)\"" '{"agent_type":"revisor","tool_input":{"command":"echo \"$(echo x > packages/x.ts)\""}}'
espera 2 guard-agentes.sh "revisor: comillas invertidas" '{"agent_type":"revisor","tool_input":{"command":"echo \"`echo x > packages/x.ts`\""}}'
espera 2 guard-agentes.sh "revisor: eval \"… > f\"" '{"agent_type":"revisor","tool_input":{"command":"eval \"echo x > packages/x.ts\""}}'
espera 2 guard-agentes.sh "revisor: bash -x -c" '{"agent_type":"revisor","tool_input":{"command":"bash -x -c \"echo x > packages/x.ts\""}}'
espera 2 guard-agentes.sh "revisor: bash --norc -c" '{"agent_type":"revisor","tool_input":{"command":"bash --norc -c \"echo x > packages/x.ts\""}}'
espera 2 guard-agentes.sh "revisor: dash -c" '{"agent_type":"revisor","tool_input":{"command":"dash -c \"echo x > packages/x.ts\""}}'
espera 2 guard-agentes.sh "revisor: \\\" fuera de comillas" '{"agent_type":"revisor","tool_input":{"command":"echo \\\" > packages/x.ts"}}'
espera 2 guard-agentes.sh "revisor: apóstrofo en un comentario" '{"agent_type":"revisor","tool_input":{"command":"ls # don'\''t\necho x > packages/x.ts"}}'
espera 2 guard-agentes.sh "revisor: apóstrofo en un heredoc" '{"agent_type":"revisor","tool_input":{"command":"cat <<E\nit'\''s\nE\necho x > packages/x.ts"}}'
espera 2 guard-agentes.sh "revisor: cadena \$'…'" '{"agent_type":"revisor","tool_input":{"command":"echo $'\''a'\'' > packages/x.ts"}}'
espera 2 guard-agentes.sh "revisor: > >(tee f)" '{"agent_type":"revisor","tool_input":{"command":"echo x > >(tee packages/x.ts)"}}'
espera 2 guard-agentes.sh "revisor: | tee fichero" '{"agent_type":"revisor","tool_input":{"command":"echo x | tee packages/x.ts"}}'
espera 2 guard-agentes.sh "revisor: tee -a fichero" '{"agent_type":"revisor","tool_input":{"command":"echo x | tee -a packages/x.ts"}}'
espera 2 guard-agentes.sh "revisor: cp" '{"agent_type":"revisor","tool_input":{"command":"cp a.ts packages/b.ts"}}'
espera 2 guard-agentes.sh "revisor: touch tras ;" '{"agent_type":"revisor","tool_input":{"command":"ls; touch packages/b.ts"}}'
espera 2 guard-agentes.sh "revisor: xargs cp" '{"agent_type":"revisor","tool_input":{"command":"ls | xargs cp -t packages"}}'
# La excepción de psql NO se aplica fuera de su forma estrecha.
espera 2 guard-agentes.sh "psql con SQL entre comillas DOBLES y >" '{"agent_type":"auditor-codigo","tool_input":{"command":"psql -c \"select 1 where 2 > 1\""}}'
espera 2 guard-agentes.sh "la comilla de cierre tomada por apertura" "{\"agent_type\":\"revisor\",\"tool_input\":{\"command\":\"psql -V; echo 'a -c ' > packages/x.ts ' b'\"}}"
espera 2 guard-agentes.sh "bash -c '…' en un comando con psql" "{\"agent_type\":\"revisor\",\"tool_input\":{\"command\":\"psql -V; bash -c 'echo x > packages/x.ts'\"}}"
espera 2 guard-agentes.sh "watch psql -c (pasa por un shell)" "{\"agent_type\":\"auditor-codigo\",\"tool_input\":{\"command\":\"watch psql -c 'select 1 > 0'\"}}"
espera 2 guard-agentes.sh "psql -c con \\\\! (psql ejecuta shell)" "{\"agent_type\":\"auditor-codigo\",\"tool_input\":{\"command\":\"psql -c '\\\\! echo x > packages/x.ts'\"}}"
espera 2 guard-agentes.sh "psql -c '…' y una redirección fuera" "{\"agent_type\":\"auditor-codigo\",\"tool_input\":{\"command\":\"psql -c 'select 1 > 0' > packages/x.ts\"}}"
# gh: lista blanca de lectura.
espera 2 guard-agentes.sh "gh pr merge" '{"agent_type":"reparador","tool_input":{"command":"gh pr merge 12 --merge"}}'
espera 2 guard-agentes.sh "gh pr -R o/r merge" '{"agent_type":"reparador","tool_input":{"command":"gh pr -R o/r merge 1"}}'
espera 2 guard-agentes.sh "gh pr create" '{"agent_type":"reparador","tool_input":{"command":"gh pr create --fill"}}'
espera 2 guard-agentes.sh "gh label create" '{"agent_type":"reparador","tool_input":{"command":"gh label create bug"}}'
espera 2 guard-agentes.sh "gh run delete" '{"agent_type":"reparador","tool_input":{"command":"gh run delete 5"}}'
espera 2 guard-agentes.sh "gh alias set" '{"agent_type":"reparador","tool_input":{"command":"gh alias set x y"}}'
espera 2 guard-agentes.sh "gh api -X PUT" '{"agent_type":"reparador","tool_input":{"command":"gh api -X PUT repos/o/r/contents/x"}}'
espera 2 guard-agentes.sh "gh api con -f (POST implícito)" '{"agent_type":"reparador","tool_input":{"command":"gh api repos/o/r/issues -f title=x"}}'
espera 2 guard-agentes.sh "gh release create" '{"agent_type":"reparador","tool_input":{"command":"gh release create v1"}}'
# Falsos positivos DECLARADOS (CLAUDE.md §8 y definiciones de los agentes de lectura): se bloquean a
# sabiendas. Si un día pasan, es que alguien reabrió el hueco que los hacía necesarios.
espera 2 guard-agentes.sh "declarado: grep -h (el -h se lee como host)" '{"agent_type":"auditor-codigo","tool_input":{"command":"grep -h x apps/web/src/a.ts"}}'
espera 2 guard-agentes.sh "declarado: grep \"=> {\" (usa la herramienta Grep)" '{"agent_type":"auditor-codigo","tool_input":{"command":"grep -rn \"=> {\" apps/web/src"}}'
espera 2 guard-agentes.sh "declarado: awk 'NR>1' (usa tail -n +2)" "{\"agent_type\":\"auditor-codigo\",\"tool_input\":{\"command\":\"awk 'NR>1' f.txt\"}}"

echo "── guard-agentes: revisiones 2 y 3 — tiene que DEJAR PASAR ──"
espera 0 guard-agentes.sh "psql -c '… > 0' (comillas simples)" "{\"agent_type\":\"auditor-codigo\",\"tool_input\":{\"command\":\"docker exec supabase_db_ladino psql -U postgres -c 'select count(*) from journal_lines where debit_amount > 0'\"}}"
espera 0 guard-agentes.sh "psql -c '… ->> \$\$x\$\$ …' (jsonb)" "{\"agent_type\":\"auditor-codigo\",\"tool_input\":{\"command\":\"psql -h 127.0.0.1 -p 54322 -U postgres -c 'select payload->>\$\$x\$\$ from outbox where 2 >= 1 and 1 <> 2'\"}}"
espera 0 guard-agentes.sh "PGPASSWORD=… psql -c '… <= …'" "{\"agent_type\":\"validador\",\"tool_input\":{\"command\":\"PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -c 'select 1 where 1 <= 2' | head\"}}"
espera 0 guard-agentes.sh "cmd 2>&1 | head (duplicar, no escribir)" '{"agent_type":"validador","tool_input":{"command":"pnpm run verify 2>&1 | head"}}'
espera 0 guard-agentes.sh "bash -c \"… 2>&1\"" '{"agent_type":"validador","tool_input":{"command":"bash -c \"pnpm run verify 2>&1\""}}'
espera 0 guard-agentes.sh "bash -c \"… > /tmp/…\"" '{"agent_type":"revisor","tool_input":{"command":"bash -c \"git diff > /tmp/d.txt\""}}'
espera 0 guard-agentes.sh "git diff | tee /tmp/teeth.txt" '{"agent_type":"revisor","tool_input":{"command":"git diff | tee /tmp/teeth.txt"}}'
espera 0 guard-agentes.sh "> \"\$TMPDIR/x\" entre comillas" '{"agent_type":"revisor","tool_input":{"command":"git diff > \"$TMPDIR/x\""}}'
espera 0 guard-agentes.sh "pnpm install --frozen-lockfile" '{"agent_type":"validador","tool_input":{"command":"pnpm install --frozen-lockfile"}}'
espera 0 guard-agentes.sh "docker cp a un temporal" '{"agent_type":"validador","tool_input":{"command":"docker cp supabase_db_ladino:/tmp/a /tmp/a"}}'
espera 0 guard-agentes.sh "grep \"npm install foo\"" '{"agent_type":"auditor-codigo","tool_input":{"command":"grep -rn \"npm install foo\" docs"}}'
espera 0 guard-agentes.sh "node -e 'const cp = …'" "{\"agent_type\":\"auditor-codigo\",\"tool_input\":{\"command\":\"node -e 'const cp = require(1)'\"}}"
espera 0 guard-agentes.sh "grep -rnw tee" '{"agent_type":"auditor-codigo","tool_input":{"command":"grep -rnw tee .claude/hooks"}}'
espera 0 guard-agentes.sh "grep \"pipe to tee and\"" '{"agent_type":"auditor-codigo","tool_input":{"command":"grep -rn \"pipe to tee and\" docs"}}'
espera 0 guard-agentes.sh "du --human-readable" '{"agent_type":"validador","tool_input":{"command":"du --human-readable apps"}}'
espera 0 guard-agentes.sh "gh pr view" '{"agent_type":"revisor","tool_input":{"command":"gh pr view 12"}}'
espera 0 guard-agentes.sh "gh pr list --json title" '{"agent_type":"revisor","tool_input":{"command":"gh pr list --json title"}}'
espera 0 guard-agentes.sh "gh run view --log" '{"agent_type":"revisor","tool_input":{"command":"gh run view 5 --log"}}'
espera 0 guard-agentes.sh "gh auth status" '{"agent_type":"revisor","tool_input":{"command":"gh auth status"}}'
espera 0 guard-agentes.sh "gh api GET" '{"agent_type":"revisor","tool_input":{"command":"gh api repos/o/r/pulls"}}'
espera 0 guard-agentes.sh "validador con gate-verdict" '{"agent_type":"validador","tool_input":{"command":"bash scripts/gate-verdict.sh run --base .recorrido/base-gate.txt"}}'

echo "── guard-agentes: con un awk ROTO en el PATH sigue bloqueando (falla cerrado) ──"
AWKROTO=$(mktemp -d)
printf '#!/bin/sh\nexit 1\n' > "$AWKROTO/awk"
chmod +x "$AWKROTO/awk"
for c in 'echo x > packages/x.ts' "psql -c 'select 1 > 0' > packages/x.ts"; do
  casos=$((casos + 1))
  printf '%s' "{\"agent_type\":\"revisor\",\"tool_input\":{\"command\":$(printf '%s' "$c" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')}}" \
    | PATH="$AWKROTO:$PATH" bash "$H/guard-agentes.sh" >/dev/null 2>&1
  r=$?
  if [ "$r" = "2" ]; then printf '  ✓ %-24s %s\n' "guard-agentes.sh" "awk roto: bloquea «$c»"; else printf '  ✗ %-24s %s (salió %s)\n' "guard-agentes.sh" "awk roto: APRUEBA «$c»" "$r"; fallos=$((fallos + 1)); fi
done
rm -rf "$AWKROTO"
echo "── guard-agentes: tiene que DEJAR PASAR ──"
espera 0 guard-agentes.sh "MCP de GitHub de solo lectura" '{"agent_type":"auditor-codigo","tool_name":"mcp__github__get_file_contents","tool_input":{}}'
espera 0 guard-agentes.sh "docker exec … psql local" '{"agent_type":"auditor-codigo","tool_input":{"command":"docker exec supabase_db_ladino psql -U postgres -c \"select 1\""}}'
espera 0 guard-agentes.sh "psql -h 127.0.0.1" '{"agent_type":"auditor-codigo","tool_input":{"command":"psql -h 127.0.0.1 -p 54322 -U postgres"}}'
espera 0 guard-agentes.sh "supabase migration up LOCAL" '{"agent_type":"reparador","tool_input":{"command":"supabase migration up"}}'
espera 0 guard-agentes.sh "revisor redirigiendo a un temporal" '{"agent_type":"revisor","tool_input":{"command":"git diff > /tmp/diff.txt"}}'
espera 0 guard-agentes.sh "escritor-tests en un *.test.ts de src/" '{"agent_type":"escritor-tests","tool_name":"Edit","tool_input":{"file_path":"packages/fiscal/src/print-shop.test.ts"}}'
espera 0 guard-agentes.sh "psql a la base LOCAL" '{"agent_type":"auditor-codigo","tool_input":{"command":"psql postgres://postgres:postgres@127.0.0.1:54322/postgres -c \"select 1\""}}'
espera 0 guard-agentes.sh "escritor-tests en un test" '{"agent_type":"escritor-tests","tool_name":"Write","tool_input":{"file_path":"apps/api/test/e2e-x.test.ts"}}'
espera 0 guard-agentes.sh "escritor-tests en pgTAP (ruta Windows)" '{"agent_type":"escritor-tests","tool_name":"Write","tool_input":{"file_path":"C:\\repo\\supabase\\tests\\999_x_test.sql"}}'
espera 0 guard-agentes.sh "auditor-fiscal en su memoria" '{"agent_type":"auditor-fiscal","tool_name":"Write","tool_input":{"file_path":".claude/agent-memory/auditor-fiscal/MEMORY.md"}}'
espera 0 guard-agentes.sh "estratega en la arquitectura de información" '{"agent_type":"estratega-producto","tool_name":"Edit","tool_input":{"file_path":"docs/08_UX/INFORMATION_ARCHITECTURE.md"}}'
espera 0 guard-agentes.sh "reparador editando producto" '{"agent_type":"reparador","tool_name":"Edit","tool_input":{"file_path":"packages/domain/src/x.ts"}}'

echo "── subagent-stop: informe sin formato → REHACER, y solo una vez ──"
ID="selftest-$$-$RANDOM"
espera 2 subagent-stop.sh "revisor sin VEREDICTO (primer intento)" \
  "{\"agent_type\":\"revisor\",\"agent_id\":\"$ID\",\"last_assistant_message\":\"todo bien\"}"
espera 0 subagent-stop.sh "el mismo, segundo intento: sale (INVÁLIDO)" \
  "{\"agent_type\":\"revisor\",\"agent_id\":\"$ID\",\"last_assistant_message\":\"todo bien\"}"
espera 0 subagent-stop.sh "revisor con su formato" \
  '{"agent_type":"revisor","agent_id":"ok-1","last_assistant_message":"VEREDICTO: cambios\nRAZONES:\n  - packages/domain/src/x.ts:12 — falta el savepoint\nASERCIONES MODIFICADAS: ninguna\nDOCS: coherentes\nDEFINITION OF DONE: ✅"}'
ID3="selftest-r1-$$-$RANDOM"
espera 2 subagent-stop.sh "revisor SIN cita archivo:línea aunque diga «ninguna» en otra parte (F4)" \
  "{\"agent_type\":\"revisor\",\"agent_id\":\"$ID3\",\"last_assistant_message\":\"VEREDICTO: cambios\\nRAZONES: está mal\\nASERCIONES MODIFICADAS: ninguna\\nDOCS: coherentes\\nDEFINITION OF DONE: ✅\"}"
espera 0 subagent-stop.sh "stop_hook_active=true deja terminar (ya se reintentó)" \
  '{"agent_type":"revisor","agent_id":"x-activo","stop_hook_active":true,"last_assistant_message":"nada"}'
espera 0 subagent-stop.sh "validador con «GATE verde · …»" \
  '{"agent_type":"validador","agent_id":"ok-v","last_assistant_message":"GATE verde · pasos 736 · vitest 805 (base 805) · pgTAP 1264 (base 1264)\nINVARIANTES:\n  x → 0 / 0 / verde\nTIEMPOS: no medidos\nREGRESIONES: ninguna"}'
espera 0 subagent-stop.sh "entrada ilegible: falla ABIERTO (no atrapa al agente)" 'esto no es json'
rm -f "${TMPDIR:-/tmp}/ladino-subagentstop/$ID3"
espera 0 subagent-stop.sh "un agente fuera del equipo" \
  '{"agent_type":"Explore","agent_id":"x","last_assistant_message":"lo que sea"}'
ID2="selftest-suplente-$$-$RANDOM"
espera 2 subagent-stop.sh "SUPLENTE (general-purpose) con ROL: revisor y sin formato" \
  "{\"agent_type\":\"general-purpose\",\"agent_id\":\"$ID2\",\"last_assistant_message\":\"ROL: revisor\\ntodo bien\"}"
espera 0 subagent-stop.sh "SUPLENTE con ROL: revisor y su formato" \
  '{"agent_type":"general-purpose","agent_id":"ok-2","last_assistant_message":"ROL: revisor\nVEREDICTO: aprobado\nRAZONES: scripts/x.sh:3 bien\nASERCIONES MODIFICADAS: ninguna\nDOCS: coherentes\nDEFINITION OF DONE: ✅"}'
rm -f "${TMPDIR:-/tmp}/ladino-subagentstop/$ID" "${TMPDIR:-/tmp}/ladino-subagentstop/$ID2"

echo "── subagent-stop: sin last_assistant_message, el informe sale del transcript (N7) ──"
TR=$(mktemp)
printf '%s\n' '{"type":"user","message":{"role":"user","content":"hazlo"}}' \
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"GATE verde · pasos 736\nINVARIANTES:\n  x → 0\nTIEMPOS: no medidos\nREGRESIONES: ninguna"}]}}' > "$TR"
espera 0 subagent-stop.sh "validador bien formado, leído del transcript" \
  "{\"agent_type\":\"validador\",\"agent_id\":\"tr-ok\",\"agent_transcript_path\":\"$TR\"}"
ID4="selftest-tr-$$-$RANDOM"
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"todo bien"}]}}' > "$TR"
espera 2 subagent-stop.sh "validador SIN formato, leído del transcript" \
  "{\"agent_type\":\"validador\",\"agent_id\":\"$ID4\",\"agent_transcript_path\":\"$TR\"}"
espera 0 subagent-stop.sh "sin informe por ninguna vía: avisa y deja salir (falla abierto)" \
  '{"agent_type":"validador","agent_id":"sin-informe"}'
# N1 en subagent-stop: un informe VÁLIDO de más de ~64 KB se rechazaba con pipefail (rechazo falso).
ID5="selftest-grande-$$-$RANDOM"
# El JSON lo arma Node: armado a mano salió INVÁLIDO, el hook falló abierto («no se pudo leer») y el
# caso pasaba por la razón equivocada — con el arreglo y sin él.
GRANDE=$(node -e 'process.stdout.write(JSON.stringify({agent_type: "revisor", agent_id: process.argv[1],
  last_assistant_message: "VEREDICTO: cambios\nRAZONES:\n  - packages/domain/src/x.ts:12 — falta\nASERCIONES MODIFICADAS: ninguna\nDOCS: coherentes\nDEFINITION OF DONE: ✅\n" + "relleno del informe para pasar de 64 KB\n".repeat(6000)}))' "$ID5")
casos=$((casos + 1))
salida=$(printf '%s' "$GRANDE" | bash "$H/subagent-stop.sh" 2>&1)
r=$?
# Tiene que salir 0 SIN aviso: un aviso («no se pudo leer», «INVÁLIDO») sería pasar por otra puerta.
if [ "$r" = "0" ] && [ -z "$salida" ]; then printf '  ✓ %-24s %s\n' "subagent-stop.sh" "informe válido de 250 KB: aceptado, sin aviso"; else printf '  ✗ %-24s %s (exit %s, salida «%s»)\n' "subagent-stop.sh" "informe válido de 250 KB NO aceptado limpio" "$r" "${salida:0:120}"; fallos=$((fallos + 1)); fi
rm -f "${TMPDIR:-/tmp}/ladino-subagentstop/$ID5"
rm -f "$TR" "${TMPDIR:-/tmp}/ladino-subagentstop/$ID4"

echo
if [ "$fallos" -eq 0 ]; then
  echo "HOOKS OK · $casos casos, todos como se esperaba."
  exit 0
fi
echo "HOOKS ROJO · $fallos de $casos casos fallaron."
exit 1
