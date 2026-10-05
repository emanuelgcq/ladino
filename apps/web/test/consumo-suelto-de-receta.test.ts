import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONSUMO_SUELTO_DE_RECETA } from "../src/components/capa-fiscal/textos.js";

/**
 * I-04 (ola 5, C7). El consumo suelto de receta descuenta los ingredientes OTRA VEZ sobre un
 * producto que ya los descuenta al venderse. No se quita (es una función desplegada): la
 * confirmación dice lo que hace. Test de fuente: el aviso está en el diálogo que confirma, no en
 * otra parte de la pantalla.
 */
const fuente = readFileSync(
  fileURLToPath(new URL("../src/pages/inventario/Inventario.tsx", import.meta.url)),
  "utf8",
);

describe("el consumo suelto de receta avisa de que la venta ya descuenta", () => {
  it("el texto dice las dos cosas: la venta ya descuenta, y para qué sirve esto", () => {
    expect(CONSUMO_SUELTO_DE_RECETA).toBe(
      "La venta de este producto ya descuenta sus ingredientes. Usa esto solo para registrar un consumo que NO se vendió (una prueba, una preparación que se perdió).",
    );
  });

  it("y va DENTRO de la confirmación de «Consumir la receta»", () => {
    const dialogo = /<ConfirmDialog[^>]*title="Consumir la receta"[\s\S]*?<\/ConfirmDialog>/.exec(
      fuente,
    );
    expect(dialogo).not.toBeNull();
    expect(dialogo![0]).toContain("{CONSUMO_SUELTO_DE_RECETA}");
  });
});
