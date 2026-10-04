import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createClient } from "@ladino/db";
import { purgarCarritosPos } from "../src/reapers.js";

/**
 * ADR-0076 (M-01): la purga de cuentas abandonadas corre COMO `ladino_worker` y no toca las
 * cuentas VENDIDAS. Una lápida purgada dejaría que una subida vieja la resucitara, y se llevaría
 * la constancia de quién armó esa venta (O-02). La abierta y vieja sí se purga, como siempre.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_WORKER = "postgres://ladino_worker:ladino_worker@127.0.0.1:54322/postgres";

const TENANT = crypto.randomUUID();
const COMPANY = crypto.randomUUID();
const CLIENTE = crypto.randomUUID();
const VENTA = crypto.randomUUID();
const ABIERTA = crypto.randomUUID();
const VENDIDA = crypto.randomUUID();

let sql: ReturnType<typeof createClient>;
let sqlWorker: ReturnType<typeof createClient>;

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlWorker = createClient(URL_WORKER);
  await sql`insert into public.tenants (id, name) values (${TENANT}, 'Tenant purga 0076')`;
  await sql`insert into public.companies (id, tenant_id, tax_id, legal_name)
            values (${COMPANY}, ${TENANT}, ${`J-0076-${COMPANY.slice(0, 8)}`}, 'Purga 0076')`;
  await sql`insert into public.customers (id, tenant_id, company_id, legal_name, person_type_code,
                                          taxpayer_type_code)
            values (${CLIENTE}, ${TENANT}, ${COMPANY}, 'Cliente purga', 'natural', 'consumidor_final')`;
  await sql`insert into public.documents
              (id, tenant_id, company_id, kind, customer_id, transaction_currency,
               functional_currency, fx_rate, rate_source, amount_transaction_currency,
               functional_amount, subtotal_amount, tax_amount, total_amount)
            values (${VENTA}, ${TENANT}, ${COMPANY}, 'quote', ${CLIENTE}, 'VES', 'VES', 1,
                    'identidad', 0, 0, 0, 0, 0)`;
  // Las dos llevan 40 días sin tocar: la única diferencia es que una se cobró.
  await sql`insert into public.pos_carts (id, tenant_id, company_id, label, lines, updated_at)
            values (${ABIERTA}, ${TENANT}, ${COMPANY}, 'Olvidada', '[]', now() - interval '40 days')`;
  await sql`insert into public.pos_carts
              (id, tenant_id, company_id, label, lines, updated_at, sold_at, sale_id)
            values (${VENDIDA}, ${TENANT}, ${COMPANY}, 'Cobrada', '[]', now() - interval '40 days',
                    now() - interval '40 days', ${VENTA})`;
});

afterAll(async () => {
  await sqlWorker.end();
  await sql.end();
});

describe("la purga de cuentas del POS (ADR-0076)", () => {
  it("como ladino_worker: la abierta y vieja se purga; la vendida y vieja sobrevive", async () => {
    await purgarCarritosPos(sqlWorker, { lote: 100000 });
    const quedan = await sql<{ id: string }[]>`
      select id from public.pos_carts where id in (${ABIERTA}, ${VENDIDA})`;
    expect(quedan.map((f) => f.id)).toEqual([VENDIDA]);
  });
});
