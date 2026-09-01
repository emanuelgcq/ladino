import { defineConfig } from "vitest/config";

/**
 * Los E2E de este paquete comparten UNA base de datos real (ADR-0016) y tocan
 * estado GLOBAL sin tenant: `exchange_rates` y `tax_rules`. En paralelo, el
 * test «sin tasa no se cotiza» de ventas puede encontrarse la tasa que compras
 * insertó hace un milisegundo — el mismo género de carrera que ya obligó al
 * advisory lock de las reglas de IVA. Los ficheros corren en serie: unos
 * segundos más de pared a cambio de que un rojo signifique un defecto y no una
 * moneda al aire.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
