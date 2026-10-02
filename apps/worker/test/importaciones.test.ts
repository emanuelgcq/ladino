import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { createClient } from "@ladino/db";
import { procesarImportaciones, MAX_INTENTOS_IMPORTACION } from "../src/index.js";

/**
 * El worker procesando trabajos de importación (ADR-0074, C-04), contra la base local y
 * conectado como `ladino_worker` — el rol de producción. Lo que demuestra:
 *
 *   1. el worker toma el trabajo, lo lleva a `done` con su informe, y los productos existen con
 *      su kardex: el paso del dominio corre de verdad bajo el rol del worker (que adopta
 *      `ladino_api` con el actor del trabajo);
 *   2. sin ese SET ROLE, el worker sigue sin poder leer productos (ADR-0031 intacto);
 *   3. un trabajo que no puede avanzar (su autor ya no es miembro) no se reintenta para siempre
 *      ni desaparece: suma intentos y termina en `failed` con el motivo.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_WORKER = "postgres://ladino_worker:ladino_worker@127.0.0.1:54322/postgres";
const TENANT = "abababab-abab-4bab-8bab-0000000000c1";
const COMPANY = "abababab-abab-4bab-8bab-0000000000c2";
const USUARIO = "abababab-abab-4bab-8bab-0000000000ca";
const EXTRAÑO = "abababab-abab-4bab-8bab-0000000000cb";
const RUN = Date.now().toString(36);

let sql: ReturnType<typeof createClient>;
let sqlWorker: ReturnType<typeof createClient>;

async function sembrarTrabajo(actor: string, filas: unknown[]): Promise<string> {
  return sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${actor}, true)`;
    const [t] = await tx<{ id: string }[]>`
      insert into public.product_import_jobs
        (tenant_id, company_id, file_name, file_hash, number_format, row_count, rows)
      values (${TENANT}, ${COMPANY}, 'worker.csv', ${randomBytes(32).toString("hex")},
              'comma_decimal', ${filas.length}, ${tx.json(filas as never)})
      returning id`;
    return t!.id;
  });
}

/**
 * El worker es GLOBAL, y el E2E de la API corre a la vez en turbo (H9): el test avanza SOLO su
 * trabajo, por su id, hasta que cierra.
 */
async function hastaQueTermine(id: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const [t] = await sql<{ status: string }[]>`
      select status from public.product_import_jobs where id = ${id}`;
    if (t!.status === "done" || t!.status === "failed") return;
    // A5: el backoff aplaza el reintento; el test adelanta el reloj en vez de esperarlo.
    await sql`update public.product_import_jobs set next_attempt_at = null where id = ${id}`;
    await procesarImportaciones(sqlWorker, { maxFilas: 10, trabajo: id });
  }
  throw new Error(`el trabajo ${id} no terminó`);
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlWorker = createClient(URL_WORKER);
  await sql`insert into auth.users (id) values (${USUARIO}), (${EXTRAÑO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${USUARIO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant worker importación')
             on conflict (id) do nothing`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name)
             values (${COMPANY}, ${TENANT}, 'J-WRKIMPORT', 'Empresa worker importación')
             on conflict (id) do nothing`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             ('abababab-abab-4bab-8bab-0000000000e1', null, 'wrk_import_gestor', 'Gestor', false)
             on conflict (id) do nothing`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             ('abababab-abab-4bab-8bab-0000000000e1', 'product.manage')
             on conflict do nothing`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values ('abababab-abab-4bab-8bab-0000000000f1', ${TENANT}, ${COMPANY},
                     'WRK-IW1', 'Principal')
             on conflict (id) do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             ('abababab-abab-4bab-8bab-0000000000a1', ${TENANT}, ${USUARIO})
             on conflict (id) do nothing`;
    await tx`insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
             ('abababab-abab-4bab-8bab-0000000000a2', ${TENANT},
              'abababab-abab-4bab-8bab-0000000000a1', 'abababab-abab-4bab-8bab-0000000000e1', null)
             on conflict (id) do nothing`;
  });
});

afterAll(async () => {
  // Las altas de producto dejan eventos en el outbox de ESTE tenant; si quedan pendientes, el
  // siguiente fichero del paquete (worker.test.ts) se los lleva en sus conteos.
  await sql`delete from public.outbox where tenant_id = ${TENANT}`;
  await sql.end();
  await sqlWorker.end();
});

describe("el worker procesa los trabajos de importación (ADR-0074)", { timeout: 60_000 }, () => {
  it("lleva el trabajo a done con su informe, y los productos quedan con su kardex", async () => {
    const id = await sembrarTrabajo(USUARIO, [
      {
        row: 2,
        status: "ready",
        warnings: [],
        name: `Martillo worker ${RUN}`,
        sku: `WRK-${RUN}`,
        is_service: false,
        price: { amount: "9.5", currency: "USD" },
        initial_stock: { quantity: "4", unit_cost: { amount: "100", currency: "VES" } },
        reference_cost: null,
      },
      {
        row: 3,
        status: "ready",
        warnings: [
          "Es un servicio: la existencia («10») se ignora — un servicio no lleva inventario.",
        ],
        name: `Instalación worker ${RUN}`,
        is_service: true,
        price: { amount: "20", currency: "USD" },
        initial_stock: null,
        reference_cost: null,
      },
      { row: 4, status: "rejected", warnings: [], message: "Falta el nombre del producto." },
    ]);

    await hastaQueTermine(id);

    const [t] = await sql<
      {
        status: string;
        processed_rows: number;
        created_count: number;
        rejected_count: number;
        report: { row: number; status: string; warnings: string[] }[];
      }[]
    >`select status, processed_rows, created_count, rejected_count, report
        from public.product_import_jobs where id = ${id}`;
    expect(t!.status).toBe("done");
    expect(t!.processed_rows).toBe(3);
    expect(t!.created_count).toBe(2);
    expect(t!.rejected_count).toBe(1);
    expect(t!.report.map((f) => [f.row, f.status])).toEqual([
      [2, "created"],
      [3, "created"],
      [4, "rejected"],
    ]);
    // El aviso de la vista previa llega al informe final: nada se pierde por el camino.
    expect(t!.report[1]!.warnings.join(" ")).toContain("servicio");

    const [kardex] = await sql<{ q: string }[]>`
      select coalesce(sum(b.quantity), 0)::text as q
        from public.stock_balances b join public.products p on p.id = b.product_id
       where p.company_id = ${COMPANY} and p.sku = ${`WRK-${RUN}`}`;
    expect(kardex!.q).toBe("4.00000000");

    // Otra vuelta no toca el trabajo terminado: ningún producto de más.
    await procesarImportaciones(sqlWorker, { maxFilas: 10, trabajo: id });
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.products
       where company_id = ${COMPANY}
         and name in (${`Martillo worker ${RUN}`}, ${`Instalación worker ${RUN}`})`;
    expect(n!.n).toBe(2);
  });

  it("sin adoptar ladino_api, el worker sigue sin poder leer productos (ADR-0031)", async () => {
    await expect(sqlWorker`select count(*) from public.products`).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("un trabajo que no puede avanzar suma intentos y termina en failed con su motivo", async () => {
    // Su autor no es miembro del tenant: la RLS de ladino_api no le deja ver el trabajo.
    const id = await sembrarTrabajo(EXTRAÑO, [
      {
        row: 2,
        status: "ready",
        warnings: [],
        name: `Huérfano worker ${RUN}`,
        is_service: false,
        price: { amount: "1", currency: "USD" },
        initial_stock: null,
        reference_cost: null,
      },
    ]);
    await hastaQueTermine(id);
    const [t] = await sql<{ status: string; attempts: number; last_error: string | null }[]>`
      select status, attempts, last_error from public.product_import_jobs where id = ${id}`;
    expect(t!.status).toBe("failed");
    expect(t!.attempts).toBe(MAX_INTENTOS_IMPORTACION);
    expect(t!.last_error).toContain("Recurso no encontrado");
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.products where name = ${`Huérfano worker ${RUN}`}`;
    expect(n!.n).toBe(0);
  });

  it("la profundidad de la cola (en_cola) cuenta los trabajos pendientes: la métrica del worker", async () => {
    const id = await sembrarTrabajo(USUARIO, [
      {
        row: 2,
        status: "ready",
        warnings: [],
        name: `En cola worker ${RUN}`,
        is_service: false,
        price: { amount: "1", currency: "USD" },
        initial_stock: null,
        reference_cost: null,
      },
    ]);
    const r = await procesarImportaciones(sqlWorker, { maxFilas: 0, trabajo: id });
    expect(r.en_cola).toBeGreaterThanOrEqual(1);
    expect(r.procesadas).toBe(0);
    await hastaQueTermine(id);
  });

  it("A5: un trabajo que falla espera su backoff — el worker no lo toma antes de next_attempt_at", async () => {
    const id = await sembrarTrabajo(EXTRAÑO, [
      {
        row: 2,
        status: "ready",
        warnings: [],
        name: `Con backoff ${RUN}`,
        is_service: false,
        price: { amount: "1", currency: "USD" },
        initial_stock: null,
        reference_cost: null,
      },
    ]);
    const primera = await procesarImportaciones(sqlWorker, { maxFilas: 10, trabajo: id });
    expect(primera.fallo).not.toBeNull();
    const [t1] = await sql<{ attempts: number; espera: boolean }[]>`
      select attempts, next_attempt_at > now() as espera
        from public.product_import_jobs where id = ${id}`;
    expect(t1!.attempts).toBe(1);
    expect(t1!.espera).toBe(true);
    // Otra vuelta inmediata no lo toca: el intento sigue siendo el primero.
    const segunda = await procesarImportaciones(sqlWorker, { maxFilas: 10, trabajo: id });
    expect(segunda.trabajo).toBeNull();
    const [t2] = await sql<{ attempts: number }[]>`
      select attempts from public.product_import_jobs where id = ${id}`;
    expect(t2!.attempts).toBe(1);
  });

  it("A2: un error que no es de los datos de la fila (23503 de otra tabla) suma intentos y NO rechaza la fila", async () => {
    // Un almacén de OTRA empresa en el stock inicial: la fila escrita a mano en el trabajo lo lleva
    // hasta el kardex, cuyo FK compuesto lo rechaza. No es un defecto del dato de producto: se
    // relanza, suma attempts y la fila no queda como rechazada.
    const AJENA = "abababab-abab-4bab-8bab-0000000000c3";
    const ALMACEN_AJENO = "abababab-abab-4bab-8bab-0000000000f3";
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${USUARIO}, true)`;
      await tx`insert into public.companies (id, tenant_id, tax_id, legal_name)
               values (${AJENA}, ${TENANT}, 'J-WRKAJENA', 'Empresa ajena worker')
               on conflict (id) do nothing`;
      await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
               values (${ALMACEN_AJENO}, ${TENANT}, ${AJENA}, 'WRK-AJ1', 'Ajeno')
               on conflict (id) do nothing`;
    });
    const id = await sembrarTrabajo(USUARIO, [
      {
        row: 2,
        status: "ready",
        warnings: [],
        name: `Almacén ajeno ${RUN}`,
        is_service: false,
        price: { amount: "1", currency: "USD" },
        initial_stock: {
          quantity: "1",
          unit_cost: { amount: "10", currency: "VES" },
          warehouse_id: ALMACEN_AJENO,
        },
        reference_cost: null,
      },
    ]);
    const r = await procesarImportaciones(sqlWorker, { maxFilas: 10, trabajo: id });
    expect(r.fallo).not.toBeNull();
    const [t] = await sql<{ attempts: number; processed_rows: number; rejected_count: number }[]>`
      select attempts, processed_rows, rejected_count from public.product_import_jobs
       where id = ${id}`;
    expect(t!.attempts).toBe(1);
    expect(t!.processed_rows).toBe(0);
    expect(t!.rejected_count).toBe(0);
  });
});
