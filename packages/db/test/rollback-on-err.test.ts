import { describe, expect, it, afterAll, beforeAll } from "vitest";
import postgres from "postgres";
import { withTransaction } from "../src/index.js";

/**
 * LA SEMÁNTICA QUE COSTÓ MÁS CARA DEL PROYECTO: un caso de uso que devuelve
 * `err` NO OCURRIÓ, y su transacción se revierte.
 *
 * Hasta 2026-08-28 no era así. `sql.begin()` commitea cuando la promesa
 * resuelve, y devolver `err` la resolvía: el caso de uso podía responder 409 y
 * dejar escrito lo que había hecho antes de fallar. Pasó de verdad en
 * `registerSupplierInvoice` —factura escrita tras un 409 por retención
 * rechazada— y una auditoría posterior encontró el mismo patrón en otras
 * treinta y cinco funciones.
 *
 * Ningún test de módulo lo veía: todos miraban la RESPUESTA, que era correcta.
 * Lo cazó una consulta cross-módulo sobre el catálogo entero. Este fichero
 * existe para que no haya que volver a cazarlo así.
 */

const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
// Tenant NUEVO por corrida: un id fijo choca con el seed y el borrado del
// afterAll revienta contra la FK de companies.
const TENANT = crypto.randomUUID();
const USUARIO = crypto.randomUUID();

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

const actor = { kind: "user", userId: USUARIO } as const;

describe("withTransaction — `err` revierte", () => {
  it("lo escrito ANTES de devolver `err` no queda en la base", async () => {
    const r = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await tx`insert into public.tenants (id, name) values (${TENANT}, 'Debe revertirse')`;
      // El caso de uso decide que la operación no es válida. Antes de este
      // cambio, la fila de arriba quedaba commiteada.
      return { ok: false as const, error: { code: "VALIDATION_FAILED", message: "no" } };
    });

    // El llamante recibe SU `err`, intacto: no se entera de que hubo rollback.
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("VALIDATION_FAILED");

    const filas = await sql`select id from public.tenants where id = ${TENANT}`;
    expect(filas).toHaveLength(0);
  });

  it("y con `ok` sí commitea: la reversión es por el FALLO, no por el envoltorio", async () => {
    const r = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await tx`insert into public.tenants (id, name) values (${TENANT}, 'Debe quedarse')`;
      return { ok: true as const, value: "hecho" };
    });
    expect(r.ok).toBe(true);
    const filas = await sql`select name from public.tenants where id = ${TENANT}`;
    expect(filas).toHaveLength(1);
    await sql`delete from public.tenants where id = ${TENANT}`;
  });

  it("una fila con columna `ok` NO se confunde con un Result en fallo", async () => {
    // La comprobación es estrecha a propósito: `ok === false` **y** propiedad
    // `error`. Sin las dos, una consulta de permisos —`… as ok`— que devolviera
    // false revertiría la transacción por parecerse a un error.
    const r = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await tx`insert into public.tenants (id, name) values (${TENANT}, 'Con columna ok')`;
      const filas = await tx<{ ok: boolean }[]>`select false as ok`;
      return filas[0]!;
    });
    expect(r.ok).toBe(false);
    const filas = await sql`select id from public.tenants where id = ${TENANT}`;
    expect(filas).toHaveLength(1);
    await sql`delete from public.tenants where id = ${TENANT}`;
  });

  it("un valor que no es Result se devuelve tal cual y commitea", async () => {
    const r = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await tx`insert into public.tenants (id, name) values (${TENANT}, 'Sin envoltorio')`;
      return [{ id: TENANT }];
    });
    expect(r).toHaveLength(1);
    const filas = await sql`select id from public.tenants where id = ${TENANT}`;
    expect(filas).toHaveLength(1);
    await sql`delete from public.tenants where id = ${TENANT}`;
  });

  it("una EXCEPCIÓN sigue reventando hacia fuera, no se convierte en `err`", async () => {
    await expect(
      withTransaction(sql, actor, async ({ sql: tx }) => {
        await tx`insert into public.tenants (id, name) values (${TENANT}, 'x')`;
        throw new Error("fallo de verdad");
      }),
    ).rejects.toThrow("fallo de verdad");
    const filas = await sql`select id from public.tenants where id = ${TENANT}`;
    expect(filas).toHaveLength(0);
  });
});
