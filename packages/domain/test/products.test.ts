import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createClient, withTransaction, type UnitOfWork } from "@ladino/db";
import {
  createProduct,
  updateProduct,
  setProductTaxCategory,
  createPriceList,
  setPrice,
} from "../src/index.js";

/**
 * Los casos de uso de productos y precios contra la base REAL y como
 * `ladino_api` — el camino de producción. Dos cosas gobiernan el fichero:
 *
 *   · la REEJECUCIÓN DIRECTA del cuerpo muere en el único del ESQUEMA con el
 *    mensaje del caso de uso (H-1: se aserta el mensaje — la clave natural es
 *    lo que cierra el borde T1/T2 de la idempotencia);
 *   · la SEGREGACIÓN del mapeo tributario: product.manage NO basta para
 *     reclasificar impuestos.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";

const TENANT = "d0d0d0d0-0000-4000-8000-000000000001";
const COMPANY = "d0d0d0d0-0000-4000-8000-000000000002";
const AJENA = "d0d0d0d0-0000-4000-8000-000000000003"; // otro tenant
const GESTOR = "d0d0d0d0-0000-4000-8000-00000000000a"; // product.manage + price_list.manage
const CONTADOR = "d0d0d0d0-0000-4000-8000-00000000000b"; // + product.tax_category.set
const RUN = Date.now().toString(36);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;

function como<T>(userId: string, fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
  return withTransaction(sqlApi, { kind: "user", userId }, fn);
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  await sql`insert into auth.users (id) values (${GESTOR}), (${CONTADOR}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${GESTOR}, true)`;
    await tx`insert into public.tenants (id, name) values
             (${TENANT}, 'Tenant productos'), ('d0d0d0d0-0000-4000-8000-000000000009', 'Tenant ajeno')
             on conflict (id) do nothing`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name) values
             (${COMPANY}, ${TENANT}, 'J-PROD', 'Empresa productos'),
             (${AJENA}, 'd0d0d0d0-0000-4000-8000-000000000009', 'J-AJENA', 'Empresa ajena')
             on conflict (id) do nothing`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             ('d0d0d0d0-0000-4000-8000-0000000000e1', null, 'gestor_prod', 'Gestor', false),
             ('d0d0d0d0-0000-4000-8000-0000000000e2', null, 'contador_prod', 'Contador', false)
             on conflict (id) do nothing`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             ('d0d0d0d0-0000-4000-8000-0000000000e1', 'product.manage'),
             ('d0d0d0d0-0000-4000-8000-0000000000e1', 'price_list.manage'),
             ('d0d0d0d0-0000-4000-8000-0000000000e2', 'product.tax_category.set')
             on conflict do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             ('d0d0d0d0-0000-4000-8000-0000000000a1', ${TENANT}, ${GESTOR}),
             ('d0d0d0d0-0000-4000-8000-0000000000b1', ${TENANT}, ${CONTADOR})
             on conflict (id) do nothing`;
    await tx`insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
             ('d0d0d0d0-0000-4000-8000-0000000000a2', ${TENANT},
              'd0d0d0d0-0000-4000-8000-0000000000a1', 'd0d0d0d0-0000-4000-8000-0000000000e1', null),
             ('d0d0d0d0-0000-4000-8000-0000000000b2', ${TENANT},
              'd0d0d0d0-0000-4000-8000-0000000000b1', 'd0d0d0d0-0000-4000-8000-0000000000e2', null)
             on conflict (id) do nothing`;
  });
});

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

describe("createProduct", () => {
  const base = {
    company_id: COMPANY,
    name: "Café molido",
    kind: "good" as const,
    unit_code: "kg",
    tax_category_code: "gravado_general",
  };

  it("camino feliz: crea, y auditoría + outbox quedan en la MISMA transacción", async () => {
    const r = await como(GESTOR, (uow) => createProduct(uow, { ...base, sku: `CAFE-${RUN}` }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe("draft");
    const [audit] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where aggregate_id = ${r.value.id} and event_type = 'product.created'`;
    const [outbox] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.outbox
       where aggregate_id = ${r.value.id} and event_type = 'product.created'`;
    expect(audit?.n).toBe(1);
    expect(outbox?.n).toBe(1);
  });

  it("REEJECUCIÓN DIRECTA del cuerpo: muere en el único del esquema, con EL MENSAJE del caso de uso", async () => {
    const input = { ...base, sku: `DUP-${RUN}` };
    const primera = await como(GESTOR, (uow) => createProduct(uow, input));
    expect(primera.ok).toBe(true);
    // Sin middleware de idempotencia: el cuerpo directo, dos veces. La clave
    // natural (company, sku) es la que cierra el borde T1/T2.
    const segunda = await como(GESTOR, (uow) =>
      createProduct(uow, { ...input, name: "Otro nombre" }),
    );
    expect(segunda.ok).toBe(false);
    if (segunda.ok) return;
    expect(segunda.error).toEqual({
      code: "DUPLICATE",
      message: "Ya existe un producto con ese SKU en esta empresa.",
    });
  });

  it("el duplicado de BARCODE se distingue por el mensaje (el 23505 dice qué único violó)", async () => {
    const bc = `759${RUN}`;
    await como(GESTOR, (uow) => createProduct(uow, { ...base, sku: `BC1-${RUN}`, barcode: bc }));
    const r = await como(GESTOR, (uow) =>
      createProduct(uow, { ...base, sku: `BC2-${RUN}`, barcode: bc }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("código de barras");
  });

  it("company invisible → NOT_FOUND; sin product.manage → PERMISSION_REQUIRED (la regla 404/403)", async () => {
    const invisible = await como(GESTOR, (uow) =>
      createProduct(uow, { ...base, company_id: AJENA, sku: `X-${RUN}` }),
    );
    expect(!invisible.ok && invisible.error.code).toBe("NOT_FOUND");
    // CONTADOR ve la company (membership) pero no tiene product.manage.
    const sinPermiso = await como(CONTADOR, (uow) =>
      createProduct(uow, { ...base, sku: `Y-${RUN}` }),
    );
    expect(!sinPermiso.ok && sinPermiso.error.code).toBe("PERMISSION_REQUIRED");
  });

  it("clasificación tributaria inactiva o inexistente → VALIDATION_FAILED, no un 23503 crudo", async () => {
    const r = await como(GESTOR, (uow) =>
      createProduct(uow, { ...base, sku: `Z-${RUN}`, tax_category_code: "no_existe" }),
    );
    expect(!r.ok && r.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("updateProduct y la segregación del mapeo tributario", () => {
  it("actualiza nombre y estado; el id inexistente en company visible → NOT_FOUND", async () => {
    const creado = await como(GESTOR, (uow) =>
      createProduct(uow, {
        company_id: COMPANY,
        sku: `UPD-${RUN}`,
        name: "Original",
        kind: "good",
        unit_code: "unidad",
        tax_category_code: "exento",
      }),
    );
    if (!creado.ok) throw new Error("fixture");
    const r = await como(GESTOR, (uow) =>
      updateProduct(uow, creado.value.id, {
        company_id: COMPANY,
        name: "Renombrado",
        status: "active",
      }),
    );
    expect(r.ok && r.value.name).toBe("Renombrado");
    expect(r.ok && r.value.status).toBe("active");

    const fantasma = await como(GESTOR, (uow) =>
      updateProduct(uow, "d0d0d0d0-0000-4000-8000-00000000dead", {
        company_id: COMPANY,
        name: "Nada",
      }),
    );
    expect(!fantasma.ok && fantasma.error.code).toBe("NOT_FOUND");
  });

  it("product.manage NO reclasifica impuestos; product.tax_category.set SÍ — y el hecho lleva from/to", async () => {
    const creado = await como(GESTOR, (uow) =>
      createProduct(uow, {
        company_id: COMPANY,
        sku: `TAX-${RUN}`,
        name: "Reclasificable",
        kind: "good",
        unit_code: "unidad",
        tax_category_code: "gravado_general",
      }),
    );
    if (!creado.ok) throw new Error("fixture");

    const gestor = await como(GESTOR, (uow) =>
      setProductTaxCategory(uow, creado.value.id, {
        company_id: COMPANY,
        tax_category_code: "exento",
      }),
    );
    expect(!gestor.ok && gestor.error.code).toBe("PERMISSION_REQUIRED");

    const contador = await como(CONTADOR, (uow) =>
      setProductTaxCategory(uow, creado.value.id, {
        company_id: COMPANY,
        tax_category_code: "exento",
      }),
    );
    expect(contador.ok && contador.value.tax_category_code).toBe("exento");

    const [hecho] = await sql<{ payload: { from: string; to: string } }[]>`
      select payload from public.audit_events
       where aggregate_id = ${creado.value.id} and event_type = 'product.tax_category_set'`;
    expect(hecho?.payload).toEqual({ from: "gravado_general", to: "exento" });
  });
});

describe("precios (rigor máximo)", () => {
  let listaId: string;
  let productoId: string;

  it("createPriceList: moneda del catálogo; el nombre duplicado muere con el mensaje propio", async () => {
    const r = await como(GESTOR, (uow) =>
      createPriceList(uow, { company_id: COMPANY, name: `PVP-${RUN}`, currency_code: "VES" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    listaId = r.value.id;
    expect(r.value.currency_code).toBe("VES");

    const euros = await como(GESTOR, (uow) =>
      createPriceList(uow, { company_id: COMPANY, name: `EUR-${RUN}`, currency_code: "EUR" }),
    );
    expect(!euros.ok && euros.error.code).toBe("VALIDATION_FAILED");

    const dup = await como(GESTOR, (uow) =>
      createPriceList(uow, { company_id: COMPANY, name: `PVP-${RUN}`, currency_code: "USD" }),
    );
    expect(!dup.ok && dup.error.code).toBe("DUPLICATE");
  });

  it("setPrice: el importe entra y sale como STRING idéntico, con la moneda de la lista", async () => {
    const p = await como(GESTOR, (uow) =>
      createProduct(uow, {
        company_id: COMPANY,
        sku: `PRICE-${RUN}`,
        name: "Con precio",
        kind: "good",
        unit_code: "unidad",
        tax_category_code: "gravado_general",
      }),
    );
    if (!p.ok) throw new Error("fixture");
    productoId = p.value.id;

    const r = await como(GESTOR, (uow) =>
      setPrice(uow, listaId, {
        company_id: COMPANY,
        product_id: productoId,
        amount: "1234567890123456.12345678",
        effective_from: "2026-01-01T00:00:00Z",
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amount).toBe("1234567890123456.12345678");
    expect(r.value.currency).toBe("VES");
    expect(r.value.effective_to).toBeNull();
  });

  it("el precio nuevo AUTOCIERRA al anterior; la reejecución con la misma fecha → DUPLICATE; el solape cerrado → PRICE_OVERLAP", async () => {
    const nuevo = await como(GESTOR, (uow) =>
      setPrice(uow, listaId, {
        company_id: COMPANY,
        product_id: productoId,
        amount: "200.00000000",
        effective_from: "2026-06-01T00:00:00Z",
      }),
    );
    expect(nuevo.ok).toBe(true);
    const [anterior] = await sql<{ effective_to: Date | null }[]>`
      select effective_to from public.price_list_items
       where price_list_id = ${listaId} and product_id = ${productoId}
         and effective_from = '2026-01-01T00:00:00Z'`;
    expect(anterior?.effective_to?.toISOString()).toBe("2026-06-01T00:00:00.000Z");

    const misma = await como(GESTOR, (uow) =>
      setPrice(uow, listaId, {
        company_id: COMPANY,
        product_id: productoId,
        amount: "300",
        effective_from: "2026-06-01T00:00:00Z",
      }),
    );
    expect(!misma.ok && misma.error.code).toBe("DUPLICATE");

    const solape = await como(GESTOR, (uow) =>
      setPrice(uow, listaId, {
        company_id: COMPANY,
        product_id: productoId,
        amount: "10",
        effective_from: "2026-02-01T00:00:00Z",
        effective_to: "2026-03-01T00:00:00Z",
      }),
    );
    expect(!solape.ok && solape.error.code).toBe("PRICE_OVERLAP");
  });

  it("un producto de OTRA empresa no entra en la lista (FK compuesto → VALIDATION_FAILED)", async () => {
    // El producto ajeno se siembra como postgres (el caso de uso jamás podría crearlo).
    const ajenoId = "d0d0d0d0-0000-4000-8000-0000000000f9";
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${GESTOR}, true)`;
      await tx`insert into public.products (id, tenant_id, company_id, sku, name, kind, unit_code, tax_category_code)
               values (${ajenoId}, 'd0d0d0d0-0000-4000-8000-000000000009', ${AJENA},
                       'AJENO-1', 'Ajeno', 'good', 'unidad', 'gravado_general')
               on conflict (id) do nothing`;
    });
    const r = await como(GESTOR, (uow) =>
      setPrice(uow, listaId, {
        company_id: COMPANY,
        product_id: ajenoId,
        amount: "1",
        effective_from: "2027-01-01T00:00:00Z",
      }),
    );
    expect(!r.ok && r.error.code).toBe("VALIDATION_FAILED");
  });
});
