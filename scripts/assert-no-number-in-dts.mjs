#!/usr/bin/env node
/**
 * Gate del "hecho cuando" de S0.2:
 *
 *   > ningún `number` aparece en una firma pública del paquete
 *
 * Recorre los .d.ts emitidos y falla si el tipo `number` aparece en una posición de tipo.
 * Es un gate absoluto, sin excepciones, y por eso `Scale` es una unión literal (0|2|4|6|8)
 * en vez de `number`: para no tener que abrirle un agujero.
 *
 * No usa grep: descartar comentarios y strings a ojo es exactamente donde estos scripts
 * se vuelven mentira. Tokeniza con el compilador de TypeScript.
 *
 * Uso: node scripts/assert-no-number-in-dts.mjs <dir-o-fichero> [...]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";
import ts from "typescript";

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("uso: assert-no-number-in-dts.mjs <dir-o-fichero.d.ts> [...]");
  process.exit(2);
}

function collect(target) {
  const st = statSync(target, { throwIfNoEntry: false });
  if (!st) return [];
  if (st.isFile()) return target.endsWith(".d.ts") ? [target] : [];
  return readdirSync(target).flatMap((entry) => collect(join(target, entry)));
}

const files = targets.flatMap(collect);
if (files.length === 0) {
  console.error(`ERROR: no se encontró ningún .d.ts en ${targets.join(", ")}.`);
  console.error(
    "¿Corriste `turbo run build` antes? Un gate que no encuentra nada y pasa es peor que no tenerlo.",
  );
  process.exit(2);
}

const findings = [];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);

  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.NumberKeyword) {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      findings.push({
        file: relative(process.cwd(), file),
        line: line + 1,
        column: character + 1,
        text: sf.text.split("\n")[line]?.trim() ?? "",
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
}

if (findings.length > 0) {
  console.error(
    `\n✗ api-surface: ${findings.length} aparición(es) de \`number\` en la API pública.\n`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}:${f.column}`);
    console.error(`    ${f.text}`);
  }
  console.error("\nADR-0013: el tipo `number` no aparece en ninguna firma monetaria.");
  console.error(
    "Si necesitas un entero acotado, usa una unión literal (como `Scale`), no `number`.\n",
  );
  process.exit(1);
}

console.log(`✓ api-surface: ${files.length} fichero(s) .d.ts, cero \`number\` en la API pública.`);
