import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * C-06 · CON «VENDO AL MAYOR» APAGADO LA CAJA NO PIDE NI PINTA NADA NUEVO.
 *
 * Test de FUENTE (no monta la caja): lo que se asevera es que todo lo que C-06 añadió a
 * `Vender.tsx` cuelga del ajuste. Si alguien quita una de estas guardas, quien no vende al mayor
 * pagaría una petición más al abrir la caja o vería un control que no pidió.
 */
const fuente = readFileSync(
  new URL("../src/pages/negocio/Vender.tsx", import.meta.url),
  "utf8",
).replace(/\s+/g, " ");

describe("la caja con «Vendo al mayor» apagado", () => {
  it("«al mayor» sale SOLO del ajuste del negocio que la caja ya leía", () => {
    expect(fuente).toContain("const alMayor = ajustes.data?.sells_wholesale === true;");
  });

  it("la única petición nueva (las listas de precio) está apagada sin el ajuste, y es una sola", () => {
    expect(fuente.split('"/v1/price-lists"')).toHaveLength(2);
    const consulta = fuente.slice(
      fuente.indexOf("const listasDePrecio = useQuery({"),
      fuente.indexOf('"/v1/price-lists"'),
    );
    expect(consulta).toContain("enabled: alMayor,");
  });

  it("el nombre de la lista y el selector solo se pintan con el ajuste; el selector, además, con el permiso", () => {
    expect(fuente).toContain("{alMayor && nombreDeLista !== null ?");
    expect(fuente).toContain("{alMayor && puedeCambiarLista && listasActivas.length > 1 && (");
    // El selector es el ÚNICO sitio que elige una lista para la venta.
    expect(fuente.split("setListaPorCuenta(").length - 1).toBe(2);
    const selector = fuente.slice(fuente.indexOf('data-testid="pos-lista"'));
    expect(selector.indexOf("setListaPorCuenta(")).toBeGreaterThan(0);
    expect(fuente.indexOf("setListaPorCuenta(")).toBeGreaterThan(
      fuente.indexOf("{alMayor && puedeCambiarLista && listasActivas.length > 1 && ("),
    );
  });

  it("sin lista elegida, ni la cuadrícula ni la cotización ni el cobro mandan `price_list_id`", () => {
    expect(fuente).toContain('(listaElegida === null ? "" : `&price_list_id=${listaElegida}`)');
    expect(fuente).toContain("...(listaElegida === null ? {} : { price_list_id: listaElegida }),");
    expect(fuente).toContain("...(listaId === null ? {} : { price_list_id: listaId }),");
  });
});
