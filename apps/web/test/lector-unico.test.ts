import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * F-06 · UN SOLO LECTOR DE NÚMEROS TECLEADOS EN TODA LA WEB (gate de fuente).
 *
 * Había 48 sitios con su `replace(",", ".")` propio: «1.500» se volvía 1,5 —quien quiso decir mil
 * quinientos pagaba mil veces menos— y «1.234,56» viajaba como «1.234.56». Ahora el dinero lo lee
 * `leerImporte` y las cantidades, tasas y porcentajes `leerCantidad`, los dos en
 * `components/forms.tsx` sobre `readAmountText` de `@ladino/money/format`.
 *
 * Esto recorre el FUENTE de `src/` y se pone rojo si reaparece el cambio de coma por punto fuera
 * de `forms.tsx`. La respuesta útil es un cero, sin lista de perdones.
 */
const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(RAIZ, "src");
const UNICO_PERMITIDO = join("src", "components", "forms.tsx");

/** Las formas de cambiar la coma decimal por un punto «a mano». */
const PATRONES: readonly RegExp[] = [
  /\.replace(?:All)?\(\s*(["'`]),\1\s*,\s*(["'`])\.\2\s*\)/,
  /\.replace(?:All)?\(\s*\/,\/g?\s*,\s*(["'`])\.\1\s*\)/,
  /\.split\(\s*(["'`]),\1\s*\)\s*\.join\(\s*(["'`])\.\2\s*\)/,
];

function hallazgos(texto: string): number[] {
  const lineas: number[] = [];
  texto.split("\n").forEach((linea, i) => {
    if (PATRONES.some((p) => p.test(linea))) lineas.push(i + 1);
  });
  return lineas;
}

function archivosDe(dir: string): string[] {
  const archivos: string[] = [];
  for (const e of readdirSync(dir)) {
    const ruta = join(dir, e);
    if (statSync(ruta).isDirectory()) archivos.push(...archivosDe(ruta));
    else if (/\.tsx?$/.test(e)) archivos.push(ruta);
  }
  return archivos;
}

describe("un solo lector de números tecleados (F-06)", () => {
  it("VARIANTE ROTA: el detector dispara con cada forma del atajo", () => {
    expect(hallazgos('const t = texto.trim().replace(",", ".");')).toEqual([1]);
    expect(hallazgos("const t = texto.replace(',', '.');")).toEqual([1]);
    expect(hallazgos('const t = texto.replaceAll(",", ".");')).toEqual([1]);
    expect(hallazgos('const t = texto.replace(/,/g, ".");')).toEqual([1]);
    expect(hallazgos('const t = texto.replace(/,/, ".");')).toEqual([1]);
    expect(hallazgos('const t = texto.split(",").join(".");')).toEqual([1]);
    expect(hallazgos('limpio\nx\nquantity: l.cantidad.trim().replace(",", "."),')).toEqual([3]);
  });

  it("y NO dispara con lo legítimo: enseñar con coma, o leer con el lector", () => {
    expect(hallazgos('const visto = cantidadTexto(n).replace(".", ",");')).toEqual([]);
    expect(hallazgos("const limpio = importeLimpio(monto);")).toEqual([]);
    expect(hallazgos('const sinCeros = v.replace(/0+$/, "");')).toEqual([]);
  });

  it("el recorrido ve ficheros de verdad, y entre ellos el lector", () => {
    const archivos = archivosDe(SRC).map((a) => relative(RAIZ, a));
    expect(archivos.length).toBeGreaterThan(50);
    expect(archivos).toContain(UNICO_PERMITIDO);
    // El lector SÍ contiene el atajo (es donde vive): si el detector no lo viera ahí, estaría
    // ciego, y el cero de abajo no valdría nada.
    expect(hallazgos(readFileSync(join(RAIZ, UNICO_PERMITIDO), "utf8")).length).toBeGreaterThan(0);
  });

  it("ningún fichero de src cambia la coma por el punto fuera de forms.tsx", () => {
    const fallos: string[] = [];
    for (const archivo of archivosDe(SRC)) {
      const rel = relative(RAIZ, archivo);
      if (rel === UNICO_PERMITIDO) continue;
      for (const linea of hallazgos(readFileSync(archivo, "utf8"))) {
        fallos.push(
          `${rel}:${String(linea)} — usa leerImporte / importeLimpio (dinero) o leerCantidad / cantidadLimpia (cantidad, tasa, porcentaje) de components/forms.tsx`,
        );
      }
    }
    expect(fallos).toEqual([]);
  });
});
