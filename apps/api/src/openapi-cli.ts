import { readFileSync, writeFileSync } from "node:fs";
import { buildOpenApiDocument } from "./openapi.js";

/**
 * CLI del contrato: `write` regenera openapi.json; `check` falla si el
 * commiteado difiere del generado. `check` es paso de `pnpm verify`: el
 * contrato no puede divergir de los Zod sin que el gate lo diga.
 */
const [modo, ruta = "openapi.json"] = process.argv.slice(2);
const generado = JSON.stringify(buildOpenApiDocument(), null, 2) + "\n";

if (modo === "write") {
  writeFileSync(ruta, generado);
  console.log(`openapi: escrito ${ruta}`);
} else if (modo === "check") {
  let actual = "";
  try {
    actual = readFileSync(ruta, "utf8");
  } catch {
    console.error(`openapi:check FALLA — no existe ${ruta}. Corre \`pnpm openapi\`.`);
    process.exit(1);
  }
  if (actual !== generado) {
    console.error(
      `openapi:check FALLA — ${ruta} difiere de lo que generan los Zod de @ladino/schemas.\n` +
        `El contrato commiteado y los esquemas no pueden divergir: corre \`pnpm openapi\` y commitea.`,
    );
    process.exit(1);
  }
  console.log("openapi:check OK — el contrato commiteado coincide con los Zod.");
} else {
  console.error("uso: openapi-cli <write|check> [ruta]");
  process.exit(2);
}
