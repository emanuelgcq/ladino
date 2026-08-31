import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createClient, withTransaction } from "../src/index.js";
import { Money } from "@ladino/money";

/**
 * EL VIAJE COMPLETO DEL DINERO, dígito a dígito. Primera vez que un módulo
 * real persiste importes (migración 17), así que se prueba la cadena entera:
 *
 *   numeric(24,8) en Postgres → postgres.js → Money.of() → {amount, currency}
 *
 * La propiedad que protege: EN NINGÚN PUNTO el importe pasa por un `number`
 * de JS. postgres.js entrega `numeric` como STRING (por eso `createClient`
 * no registra parsers de tipos); `Money` lo representa exacto y `toJSON()`
 * devuelve el mismo string. Si algún día alguien registra un parser de
 * numeric→number «por comodidad», este test pierde dígitos y se pone rojo.
 *
 * El importe elegido es el LÍMITE de numeric(24,8): 16 enteros + 8 decimales,
 * imposible de representar en un double (que pierde precisión pasados 15-16
 * dígitos significativos).
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";

// IDs NUEVOS por corrida. Con ids fijos, la segunda ejecución sobre la misma
// base chocaba contra el append-only de precios (ADR-0032): el fixture borraba
// el precio anterior para volver a insertarlo, y `price_list_items` no se
// borra. Es la cuarta vez que el estado compartido muerde en este repo, y el
// modo de fallo es siempre el mismo — verde en limpio, rojo en la segunda.
const TENANT = crypto.randomUUID();
const COMPANY = crypto.randomUUID();
const USUARIO = crypto.randomUUID();
const LISTA = crypto.randomUUID();
const PRODUCTO = crypto.randomUUID();
const SUFIJO = TENANT.slice(0, 8);
const LIMITE = "1234567890123456.12345678";

let sql: ReturnType<typeof createClient>;

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  await sql`insert into auth.users (id) values (${USUARIO}) on conflict (id) do nothing`;
  await withTransaction(sql, { kind: "user", userId: USUARIO }, async ({ sql: tx }) => {
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant roundtrip')
             on conflict (id) do nothing`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name)
             values (${COMPANY}, ${TENANT}, ${"J-ROUND-" + SUFIJO}, 'Empresa roundtrip')
             on conflict (id) do nothing`;
    await tx`insert into public.products (id, tenant_id, company_id, sku, name, kind, unit_code, tax_category_code)
             values (${PRODUCTO}, ${TENANT}, ${COMPANY}, ${"ROUND-" + SUFIJO}, 'Producto roundtrip',
                     'good', 'unidad', 'gravado_general')
             on conflict (id) do nothing`;
    await tx`insert into public.price_lists (id, tenant_id, company_id, name, currency_code)
             values (${LISTA}, ${TENANT}, ${COMPANY}, 'Lista roundtrip', 'VES')
             on conflict (id) do nothing`;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${LISTA}, ${PRODUCTO}, ${LIMITE}, '2026-01-01T00:00:00Z')`;
  });
});

afterAll(async () => {
  await sql.end();
});

describe("numeric(24,8) → postgres.js → Money → {amount, currency}", () => {
  it("el importe límite sobrevive el viaje completo sin perder un dígito", async () => {
    const [fila] = await sql<{ amount: unknown; currency_code: string }[]>`
      select i.amount, l.currency_code
        from public.price_list_items i
        join public.price_lists l on l.id = i.price_list_id
       where i.price_list_id = ${LISTA} and i.product_id = ${PRODUCTO}`;

    // 1. postgres.js entrega numeric como STRING: jamás un number.
    expect(typeof fila!.amount).toBe("string");
    expect(fila!.amount).toBe(LIMITE);

    // 2. Money lo representa exacto y su ÚNICA serialización lo devuelve igual.
    const money = Money.of(fila!.amount as string, fila!.currency_code);
    if (!money.ok) throw new Error(`Money.of rechazó el importe: ${money.error.code}`);
    expect(money.value.toJSON()).toEqual({ amount: LIMITE, currency: "VES" });
  });

  it("la variante que se querría escribir: por un double, el mismo importe PIERDE dígitos", () => {
    // No es un test de Money: es la demostración de por qué la cadena entera
    // evita `number`. El mismo string, pasado por Number(), ya no es él.
    expect(String(Number(LIMITE))).not.toBe(LIMITE);
  });

  it("price_at devuelve el mismo string exacto (la función tampoco redondea)", async () => {
    const [r] = await sql<{ vigente: unknown }[]>`
      select platform.price_at(${LISTA}, ${PRODUCTO}, '2026-06-01T00:00:00Z') as vigente`;
    expect(typeof r!.vigente).toBe("string");
    expect(r!.vigente).toBe(LIMITE);
  });
});
