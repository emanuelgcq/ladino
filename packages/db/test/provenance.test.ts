import { describe, expect, it, afterAll, beforeAll } from "vitest";
import postgres from "postgres";
import { withTransaction, SYSTEM_ACTOR_ID } from "../src/index.js";

/**
 * EL TEST QUE `API_SPEC.md` §Procedencia ESPECIFICA CON PRECISIÓN, y el único
 * de todo el repositorio que está descrito con ese detalle:
 *
 *   «un caso de uso ejecutado SIN GUC debe fallar el test, comprobando
 *    created_by is not null en la fila resultante»
 *   «es la única que se ejecuta por el mismo camino que producción. Un test que
 *    fije el GUC a mano prueba el trigger, no la API»
 *
 * De ahí la forma de este fichero: la escritura pasa por `withTransaction`, no
 * por un `set_config` escrito a mano. Si alguien reemplaza el helper por una
 * conexión directa, este test se pone rojo — que es el punto.
 */

const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";

const TENANT = "eeeeeeee-eeee-4eee-8eee-000000000001";
const USUARIO = "eeeeeeee-eeee-4eee-8eee-00000000000a";

let sql: postgres.Sql;

beforeAll(async () => {
  sql = postgres(URL_LOCAL, { prepare: false, types: {} });
  await sql`delete from public.tenants where id = ${TENANT}`;
  await sql`insert into auth.users (id) values (${USUARIO}) on conflict (id) do nothing`;
});

afterAll(async () => {
  await sql`delete from public.tenants where id = ${TENANT}`;
  await sql.end();
});

describe("procedencia: el GUC lo fija el helper, no el llamante", () => {
  it("escribiendo POR EL HELPER, created_by queda con el actor real", async () => {
    await withTransaction(sql, { kind: "user", userId: USUARIO }, async ({ sql: tx }) => {
      await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant de prueba')`;
    });

    const [fila] = await sql<{ created_by: string | null }[]>`
      select created_by from public.tenants where id = ${TENANT}`;

    expect(fila?.created_by).toBe(USUARIO);
  });

  it("SIN el helper —conexión directa— created_by queda NULL EN SILENCIO", async () => {
    // Esta es la VARIANTE ROTA, y es lo que da valor al test de arriba.
    //
    // No lanza. No avisa. Devuelve éxito. El vacío aparecería meses después en
    // una auditoría, sobre datos que ya no se pueden reconstruir. Por eso el
    // helper es el único punto de entrada y hay un gate de fronteras que lo
    // verifica: un contrato documentado no habría impedido esto.
    await sql.begin(async (tx) => {
      await tx`delete from public.tenants where id = ${TENANT}`;
      await tx`insert into public.tenants (id, name) values (${TENANT}, 'Sin GUC')`;
    });

    const [fila] = await sql<{ created_by: string | null }[]>`
      select created_by from public.tenants where id = ${TENANT}`;

    expect(fila?.created_by).toBeNull();
  });

  it("el GUC muere con la transacción: no se filtra a la siguiente", async () => {
    // La razón de que el pooling vaya en MODO TRANSACCIÓN. Con `set` de sesión
    // sobre un pool compartido, este valor sobreviviría a la conexión y
    // contaminaría la petición siguiente, que puede ser de otro tenant.
    await withTransaction(sql, { kind: "user", userId: USUARIO }, async ({ sql: tx }) => {
      const [r] = await tx<{ v: string }[]>`select current_setting('ladino.actor_id', true) as v`;
      expect(r?.v).toBe(USUARIO);
    });

    const [fuera] = await sql<{ v: string | null }[]>`
      select current_setting('ladino.actor_id', true) as v`;
    expect(fuera?.v === null || fuera?.v === "").toBe(true);
  });

  it("el actor de sistema NO sirve para crear una company: la FK lo impide", async () => {
    // Asimetría deliberada, documentada en API_SPEC.md §El centinela:
    //   · companies.created_by       -> FK a auth.users, exige usuario REAL
    //   · idempotency_keys.actor_id  -> sin FK, acepta el centinela
    // Alguien la va a "corregir"; este test dice por qué no debe.
    await withTransaction(sql, { kind: "user", userId: USUARIO }, async ({ sql: tx }) => {
      await tx`delete from public.tenants where id = ${TENANT}`;
      await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant de prueba')`;
    });

    await expect(
      withTransaction(sql, { kind: "system" }, async ({ sql: tx }) => {
        await tx`
          insert into public.companies (tenant_id, tax_id, legal_name)
          values (${TENANT}, 'J-TEST', 'Empresa de prueba')`;
      }),
    ).rejects.toThrow(/created_by_fkey/);

    expect(SYSTEM_ACTOR_ID).toBe("00000000-0000-4000-8000-000000000000");
  });
});
