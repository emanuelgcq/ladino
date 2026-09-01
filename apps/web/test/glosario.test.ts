import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { violaciones, TERMINOS_PROHIBIDOS } from "../src/i18n/glosario.js";

/**
 * EL GATE DEL GLOSARIO (Fase C): ninguna pantalla de negocio habla en jerga.
 *
 * Corre dentro de `pnpm verify` (paso de test de @ladino/web) y recorre el
 * FUENTE de `src/pages/negocio/**`: si una pantalla dice SKU, kardex, asiento
 * o Bs.S, esto se pone rojo con el archivo, el término y qué decir en su
 * lugar. No es una guía de estilo: es un gate.
 *
 * Y como todo gate compuesto, primero se prueba a SÍ MISMO con la variante
 * rota (CLAUDE.md §3: la ausencia de fallo no se lee como éxito sin haber
 * visto el fallo al menos una vez): un texto envenenado con TODOS los
 * términos tiene que disparar todos, y uno limpio, ninguno.
 */
const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const NEGOCIO = join(RAIZ, "src", "pages", "negocio");

function archivosDe(dir: string): string[] {
  let entradas: string[];
  try {
    entradas = readdirSync(dir);
  } catch {
    return []; // el directorio aún no existe: el gate queda armado para cuando exista
  }
  const archivos: string[] = [];
  for (const e of entradas) {
    const ruta = join(dir, e);
    if (statSync(ruta).isDirectory()) archivos.push(...archivosDe(ruta));
    else if (/\.(tsx?|css)$/.test(e)) archivos.push(ruta);
  }
  return archivos;
}

describe("el glosario de persona (gate de Fase C)", () => {
  it("VARIANTE ROTA: el detector dispara con TODOS los términos prohibidos", () => {
    const envenenado = [
      "el SKU del almacén",
      "kardex y CxC y CxP",
      "aging del instrumento",
      "fx_rate del asiento contable",
      "draft con número de control",
      "el régimen y su rules_version",
      "LAD50 SQLSTATE Bs.S",
    ].join("\n");
    const halladas = violaciones(envenenado);
    // TODOS los términos del glosario tienen que dispararse: si uno no
    // dispara con su propio ejemplo, el gate está tapando esa regla.
    expect(halladas.length).toBe(TERMINOS_PROHIBIDOS.length);
  });

  it("y NO dispara con la voz de persona", () => {
    const limpio = [
      "Código, Movimientos, Lo que me deben, Lo que debo",
      "Desde hace cuánto, Forma de pago, Tasa del día",
      "Entró mercancía al Depósito principal por Bs. 1.183,20",
      "Consumidor final pagó USD 9,86 y su vuelto fue exacto",
      "regímenes no — pero un regimiento de arepas sí se puede decir", // /\brégimen\b/ no debe pisar otras palabras
    ].join("\n");
    // «regímenes» SÍ es del glosario; se quita de la muestra limpia y se
    // comprueba aparte que la palabra vecina no dispara por accidente.
    expect(violaciones("un regimiento de arepas")).toEqual([]);
    expect(violaciones(limpio.split("\n").slice(0, 4).join("\n"))).toEqual([]);
  });

  it("ninguna pantalla de negocio usa un término prohibido", () => {
    const archivos = archivosDe(NEGOCIO);
    const problemas: string[] = [];
    for (const a of archivos) {
      const fuente = readFileSync(a, "utf8");
      for (const v of violaciones(fuente)) {
        problemas.push(`${relative(RAIZ, a)}: «${v.termino}» → usa ${v.usa}`);
      }
    }
    expect(problemas, problemas.join("\n")).toEqual([]);
  });
});
