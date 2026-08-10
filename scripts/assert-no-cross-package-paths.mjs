#!/usr/bin/env node
/**
 * Señal temprana de ADR-0022.
 *
 * La salida barata de `apps/mobile` del workspace depende de que los paquetes se consuman
 * COMPILADOS (`dist/` + `exports`) y nunca por alias de `tsconfig.paths`. Metro no lee
 * `tsconfig.paths`; en cuanto un paquete introduce uno, ejectar deja de ser una tarde de
 * trabajo y la decisión de ADR-0022 se vuelve irreversible en la práctica.
 *
 * Falla si algún tsconfig de paquete declara `paths` que apunten fuera de su propio directorio.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import ts from "typescript";

const ROOTS = ["apps", "packages"];
const findings = [];

for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  for (const pkg of readdirSync(root)) {
    const dir = join(root, pkg);
    for (const name of ["tsconfig.json", "tsconfig.build.json"]) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;

      const parsed = ts.parseConfigFileTextToJson(file, readFileSync(file, "utf8"));
      const paths = parsed.config?.compilerOptions?.paths;
      if (!paths) continue;

      for (const [alias, targets] of Object.entries(paths)) {
        for (const target of targets) {
          // Un alias que sale del paquete: sube directorios o nombra otro workspace.
          if (target.includes("../") || target.includes("@ladino/")) {
            findings.push({ file, alias, target });
          }
        }
      }
    }
  }
}

if (findings.length > 0) {
  console.error("\n✗ boundaries: alias de tsconfig que cruzan la frontera de un paquete.\n");
  for (const f of findings) {
    console.error(`  ${f.file}`);
    console.error(`    "${f.alias}" -> "${f.target}"`);
  }
  console.error("\nADR-0022: los paquetes se consumen por `exports` + dist, nunca por `paths`.");
  console.error("Metro no lee tsconfig.paths; esto encarecería la salida de apps/mobile.\n");
  process.exit(1);
}

console.log("✓ boundaries: ningún tsconfig declara paths entre paquetes (ADR-0022).");
