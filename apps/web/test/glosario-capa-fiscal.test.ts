import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { violacionesCapaFiscal, TERMINOS_CAPA_FISCAL } from "../src/i18n/glosario.js";

/**
 * EL GATE DE LA CAPA FISCAL (plan «Ladino sin RIF», A15): las pantallas de la
 * persona y el registro no nombran IVA, IGTF, SENIAT, alícuotas, lotes ni
 * códigos «409 CÓDIGO». Lo fiscal que una empresa que factura sí ve vive en
 * `src/components/capa-fiscal/**` y se pinta según el modo de venta.
 *
 * Primero se prueba a sí mismo con la variante rota, como el gate original.
 */
const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const CARPETAS = [join(RAIZ, "src", "pages", "negocio"), join(RAIZ, "src", "pages", "registro")];

function archivosDe(dir: string): string[] {
  let entradas: string[];
  try {
    entradas = readdirSync(dir);
  } catch {
    return [];
  }
  const archivos: string[] = [];
  for (const e of entradas) {
    const ruta = join(dir, e);
    if (statSync(ruta).isDirectory()) archivos.push(...archivosDe(ruta));
    else if (/\.(tsx?|css)$/.test(e)) archivos.push(ruta);
  }
  return archivos;
}

describe("el glosario de la capa fiscal (gate del modo recibos)", () => {
  it("VARIANTE ROTA: el detector dispara con TODOS los términos de la capa fiscal", () => {
    const envenenado = [
      "el IVA y el IGTF",
      "trámite ante el SENIAT con su alícuota",
      "el lote vence",
      "409 TAX_RULE_MISSING",
      "pon tu RIF",
    ].join("\n");
    expect(violacionesCapaFiscal(envenenado, "src/pages/negocio/Vender.tsx").length).toBe(
      TERMINOS_CAPA_FISCAL.length,
    );
  });

  it("y respeta sus excepciones explícitas, nada más", () => {
    // El documento de un cliente no es la capa fiscal del negocio.
    expect(
      violacionesCapaFiscal("Cédula o RIF del cliente · RIF o cédula", "x/Clientes.tsx"),
    ).toEqual([]);
    // El RIF del negocio se nombra en el registro y en Empezar.
    expect(violacionesCapaFiscal("¿Ya tienes RIF?", "src/pages/negocio/Empezar.tsx")).toEqual([]);
    expect(violacionesCapaFiscal("Pon tu RIF", "src/pages/registro/Registro.tsx")).toEqual([]);
    // Pero ni el registro ni Empezar pueden nombrar el IVA.
    expect(violacionesCapaFiscal("el IVA", "src/pages/negocio/Empezar.tsx")).toHaveLength(1);
    // Un código HTTP en el código fuente no es «409 CÓDIGO» en pantalla.
    expect(violacionesCapaFiscal("if (r.status === 409) {", "x/Registro.tsx")).toEqual([]);
  });

  it("ninguna pantalla de la persona ni el registro nombran la capa fiscal", () => {
    const problemas: string[] = [];
    for (const a of CARPETAS.flatMap((c) => archivosDe(c))) {
      const rel = relative(RAIZ, a).split("\\").join("/");
      for (const v of violacionesCapaFiscal(readFileSync(a, "utf8"), rel)) {
        problemas.push(`${rel}: «${v.termino}» → usa ${v.usa}`);
      }
    }
    expect(problemas, problemas.join("\n")).toEqual([]);
  });
});
