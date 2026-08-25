import { describe, expect, it, afterAll } from "vitest";
import { createClient, assertServiceRole, PrivilegedRoleError } from "../src/index.js";

/**
 * El guardián de arranque de ADR-0031, ejercido contra la base local con las
 * DOS clases de conexión reales — no con un mock del catálogo:
 *
 *   · `postgres` (BYPASSRLS) tiene que ser RECHAZADO. Es la variante rota del
 *     propio guardián: si esto pasara, el guardián no mide nada.
 *   · `ladino_api` y `ladino_worker` tienen que pasar: son el camino de
 *     producción, y un guardián que rechaza lo legítimo es una avería.
 */
const clientes: ReturnType<typeof createClient>[] = [];
function cliente(url: string) {
  const c = createClient(url);
  clientes.push(c);
  return c;
}

afterAll(async () => {
  await Promise.all(clientes.map((c) => c.end()));
});

describe("assertServiceRole (ADR-0031)", () => {
  it("rechaza una conexión como postgres: BYPASSRLS no arranca", async () => {
    const sql = cliente("postgres://postgres:postgres@127.0.0.1:54322/postgres");
    await expect(assertServiceRole(sql)).rejects.toThrow(PrivilegedRoleError);
    // El mensaje nombra el rol y el porqué: es lo que verá el operador en el log.
    await expect(assertServiceRole(sql)).rejects.toThrow(/postgres.*BYPASSRLS/s);
  });

  it("acepta ladino_api y ladino_worker: el camino de producción arranca", async () => {
    await expect(
      assertServiceRole(cliente("postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres")),
    ).resolves.toBeUndefined();
    await expect(
      assertServiceRole(cliente("postgres://ladino_worker:ladino_worker@127.0.0.1:54322/postgres")),
    ).resolves.toBeUndefined();
  });
});
