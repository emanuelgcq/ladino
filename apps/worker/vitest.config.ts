import { defineConfig } from "vitest/config";

/**
 * Los tests del worker comparten UNA base real y el worker es GLOBAL por diseño: toma lo
 * `pending` de todos los tenants. En paralelo, `importaciones.test.ts` deja eventos de outbox
 * (las altas de producto) que `worker.test.ts` recoge en medio de su variante rota F-9, y el
 * conteo de reservas perdidas sale 5 en vez de 1 (gate de la ola 2, 2026-10-02). Los ficheros
 * corren en serie, como en apps/api: unos segundos más a cambio de que un rojo sea un defecto.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
