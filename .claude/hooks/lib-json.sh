#!/usr/bin/env bash
# Lectura del JSON que Claude Code pasa a los hooks, SIN jq.
#
# Los guardianes usaban `jq`, y en la máquina del dueño `jq` no estaba instalado: cada campo salía
# vacío, el hook llegaba a `[ -z "$FILE" ] && exit 0` y APROBABA todo. Editar una migración
# aplicada, `service_role` en la web o reiniciar n8n pasaban con exit 0 (2026-09-24). Una
# prohibición que depende de que exista una herramienta opcional no es una prohibición
# (CLAUDE.md §2).
#
# Node sí está garantizado: el repo lo exige. Y si NI ASÍ se puede leer la entrada, el hook no
# aprueba por defecto: BLOQUEA con el motivo. Fallar cerrado es el único fallo aceptable en un
# guardián.
#
# Uso:  . "$(dirname "$0")/lib-json.sh"   (con la entrada ya en $INPUT)
#       FILE=$(campo tool_input.file_path)

bloquear() { echo "BLOQUEADO POR HOOK: $1" >&2; exit 2; }

# Un guardián que REVIENTA tampoco aprueba. Para Claude Code, solo exit 2 bloquea: un exit 1 —una
# variable sin definir bajo `set -u`, un comando que falla— es un «error no bloqueante» y la
# herramienta SE EJECUTA. Pasó el 2026-09-24: con TMPDIR sin definir, guard-agentes salía 1 y un
# agente de solo lectura redirigía a un fichero del repo. Cualquier salida que no sea 0 o 2 se
# convierte aquí en 2.
trap 'rc=$?; if [ "$rc" -ne 0 ] && [ "$rc" -ne 2 ]; then echo "BLOQUEADO POR HOOK: $(basename "$0") falló de forma inesperada (exit $rc); un guardián roto no aprueba." >&2; exit 2; fi' EXIT

if ! command -v node >/dev/null 2>&1; then
  bloquear "no hay 'node' en el PATH: el guardián no puede leer qué se va a hacer, y un guardián que no lee no aprueba. Arregla el PATH del entorno de Claude Code."
fi

# Valida una vez que la entrada es JSON; si no lo es, se bloquea — no se adivina.
if ! printf '%s' "${INPUT:-}" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    try { JSON.parse(s); } catch { process.exit(3); }
  });' 2>/dev/null; then
  bloquear "la entrada del hook no es JSON válido; no se aprueba lo que no se puede leer."
fi

# campo <ruta.con.puntos> → el valor como texto ("" si no existe).
campo() {
  printf '%s' "${INPUT:-}" | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      let v = JSON.parse(s);
      for (const k of process.argv[1].split(".")) { if (v == null) break; v = v[k]; }
      if (v != null) process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
    });' "$1"
}
