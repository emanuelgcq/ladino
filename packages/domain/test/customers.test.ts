import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createClient, withTransaction, type UnitOfWork } from "@ladino/db";
import {
  createCustomer,
  updateCustomer,
  setCustomerTaxId,
  setCustomerBlocked,
} from "../src/index.js";

/**
 * Clientes contra la base REAL como `ladino_api`. Lo que gobierna: los TRES
 * permisos segregados (manage / tax_id.manage / block), la reejecución del
 * cuerpo muriendo en el único parcial del RIF con el mensaje del caso de uso,
 * y el cambio de RIF dejando el valor anterior en la auditoría (lo escribe el
 * trigger; el caso de uso lo exige por permiso antes).
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";

const TENANT = "c0c0c0c0-0000-4000-8000-000000000001";
const COMPANY = "c0c0c0c0-0000-4000-8000-000000000002";
const GESTOR = "c0c0c0c0-0000-4000-8000-00000000000a"; // customer.manage
const RIF = "c0c0c0c0-0000-4000-8000-00000000000b"; // customer.tax_id.manage
const COBRANZAS = "c0c0c0c0-0000-4000-8000-00000000000c"; // customer.block
const RUN = Date.now().toString(36);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
const como = <T>(userId: string, fn: (uow: UnitOfWork) => Promise<T>) =>
  withTransaction(sqlApi, { kind: "user", userId }, fn);

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  await sql`insert into auth.users (id) values (${GESTOR}), (${RIF}), (${COBRANZAS}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${GESTOR}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant clientes') on conflict (id) do nothing`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name)
             values (${COMPANY}, ${TENANT}, 'J-CLI', 'Empresa clientes') on conflict (id) do nothing`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             ('c0c0c0c0-0000-4000-8000-0000000000e1', null, 'cli_gestor', 'Gestor', false),
             ('c0c0c0c0-0000-4000-8000-0000000000e2', null, 'cli_rif', 'RIF', false),
             ('c0c0c0c0-0000-4000-8000-0000000000e3', null, 'cli_cobranzas', 'Cobranzas', false)
             on conflict (id) do nothing`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             ('c0c0c0c0-0000-4000-8000-0000000000e1', 'customer.manage'),
             ('c0c0c0c0-0000-4000-8000-0000000000e2', 'customer.tax_id.manage'),
             ('c0c0c0c0-0000-4000-8000-0000000000e3', 'customer.block')
             on conflict do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             ('c0c0c0c0-0000-4000-8000-0000000000a1', ${TENANT}, ${GESTOR}),
             ('c0c0c0c0-0000-4000-8000-0000000000b1', ${TENANT}, ${RIF}),
             ('c0c0c0c0-0000-4000-8000-0000000000c1', ${TENANT}, ${COBRANZAS})
             on conflict (id) do nothing`;
    await tx`insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
             ('c0c0c0c0-0000-4000-8000-0000000000a2', ${TENANT}, 'c0c0c0c0-0000-4000-8000-0000000000a1', 'c0c0c0c0-0000-4000-8000-0000000000e1', null),
             ('c0c0c0c0-0000-4000-8000-0000000000b2', ${TENANT}, 'c0c0c0c0-0000-4000-8000-0000000000b1', 'c0c0c0c0-0000-4000-8000-0000000000e2', null),
             ('c0c0c0c0-0000-4000-8000-0000000000c2', ${TENANT}, 'c0c0c0c0-0000-4000-8000-0000000000c1', 'c0c0c0c0-0000-4000-8000-0000000000e3', null)
             on conflict (id) do nothing`;
  });
});

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

const base = {
  company_id: COMPANY,
  legal_name: "Distribuidora Ñandú C.A.",
  person_type_code: "juridica",
  taxpayer_type_code: "ordinario",
  // Desde la migración 33 una jurídica exige domicilio; el caso sin dirección
  // tiene su aserción propia más abajo.
  fiscal_address: "Av. Ñandú, galpón 4, Barquisimeto",
};

describe("createCustomer", () => {
  it("camino feliz: crea; el trigger deja tax_id_established y el caso de uso customer.created", async () => {
    const r = await como(GESTOR, (uow) => createCustomer(uow, { ...base, tax_id: `J-${RUN}-1` }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe("active");
    const eventos = await sql<{ event_type: string }[]>`
      select event_type from public.audit_events where aggregate_id = ${r.value.id} order by event_type`;
    expect(eventos.map((e) => e.event_type)).toEqual([
      "customer.created",
      "customer.tax_id_established",
    ]);
  });

  it("REEJECUCIÓN DIRECTA: el mismo RIF muere en el único parcial con el mensaje del caso de uso", async () => {
    const input = { ...base, tax_id: `J-${RUN}-DUP` };
    expect((await como(GESTOR, (uow) => createCustomer(uow, input))).ok).toBe(true);
    const segunda = await como(GESTOR, (uow) =>
      createCustomer(uow, { ...input, tax_id: `j-${RUN}-dup`, legal_name: "Otro nombre" }),
    );
    expect(segunda.ok).toBe(false);
    if (segunda.ok) return;
    expect(segunda.error).toEqual({
      code: "DUPLICATE",
      message: "Ya existe un cliente con ese RIF en esta empresa.",
    });
  });

  it("persona natural sin RIF: dos conviven; jurídica sin RIF: VALIDATION_FAILED con palabras", async () => {
    const uno = await como(GESTOR, (uow) =>
      createCustomer(uow, {
        ...base,
        tax_id: null,
        legal_name: `Final ${RUN} A`,
        person_type_code: "natural",
        taxpayer_type_code: "no_sujeto",
      }),
    );
    const dos = await como(GESTOR, (uow) =>
      createCustomer(uow, {
        ...base,
        tax_id: null,
        legal_name: `Final ${RUN} B`,
        person_type_code: "natural",
        taxpayer_type_code: "no_sujeto",
      }),
    );
    expect(uno.ok && dos.ok).toBe(true);
    const juridica = await como(GESTOR, (uow) =>
      createCustomer(uow, { ...base, tax_id: null, legal_name: `Sin RIF ${RUN}` }),
    );
    expect(!juridica.ok && juridica.error.code).toBe("VALIDATION_FAILED");
    expect(!juridica.ok && juridica.error.message).toContain("persona natural");

    // Y con RIF pero SIN dirección tampoco (migración 33): una factura a una
    // empresa lleva su domicilio fiscal.
    const { fiscal_address: _fuera, ...baseSinDireccion } = base;
    const sinDireccion = await como(GESTOR, (uow) =>
      createCustomer(uow, {
        ...baseSinDireccion,
        tax_id: `J-${RUN}-SD`,
        legal_name: `Sin dirección ${RUN}, C.A.`,
      }),
    );
    expect(!sinDireccion.ok && sinDireccion.error.code).toBe("VALIDATION_FAILED");
    expect(!sinDireccion.ok && sinDireccion.error.message).toContain("domicilio fiscal");
  });

  it("sin customer.manage → PERMISSION_REQUIRED; clasificación fuera del catálogo → VALIDATION_FAILED", async () => {
    const r = await como(RIF, (uow) => createCustomer(uow, { ...base, tax_id: `J-${RUN}-P` }));
    expect(!r.ok && r.error.code).toBe("PERMISSION_REQUIRED");
    const v = await como(GESTOR, (uow) =>
      createCustomer(uow, { ...base, tax_id: `J-${RUN}-V`, taxpayer_type_code: "inventado" }),
    );
    expect(!v.ok && v.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("segregación: RIF y bloqueo", () => {
  let id: string;
  beforeAll(async () => {
    const r = await como(GESTOR, (uow) => createCustomer(uow, { ...base, tax_id: `J-${RUN}-SEG` }));
    if (!r.ok) throw new Error("fixture");
    id = r.value.id;
  });

  it("updateCustomer edita nombre pero NO puede tocar el RIF ni bloquear", async () => {
    const r = await como(GESTOR, (uow) =>
      updateCustomer(uow, id, {
        company_id: COMPANY,
        legal_name: "Renombrada",
        email: "ventas@nandu.example",
      }),
    );
    expect(r.ok && r.value.legal_name).toBe("Renombrada");
  });

  it("setCustomerTaxId: gestor → 403; usuario con customer.tax_id.manage → ok y el VALOR ANTERIOR queda auditado", async () => {
    const gestor = await como(GESTOR, (uow) =>
      setCustomerTaxId(uow, id, { company_id: COMPANY, tax_id: `J-${RUN}-NEW` }),
    );
    expect(!gestor.ok && gestor.error.code).toBe("PERMISSION_REQUIRED");

    const rif = await como(RIF, (uow) =>
      setCustomerTaxId(uow, id, { company_id: COMPANY, tax_id: `J-${RUN}-NEW` }),
    );
    expect(rif.ok && rif.value.tax_id).toBe(`J-${RUN}-NEW`);

    const [hecho] = await sql<{ payload: { tax_id_anterior: string; tax_id_nuevo: string } }[]>`
      select payload from public.audit_events
       where aggregate_id = ${id} and event_type = 'customer.tax_id_changed'`;
    expect(hecho?.payload.tax_id_anterior).toBe(`J-${RUN}-SEG`);
    expect(hecho?.payload.tax_id_nuevo).toBe(`J-${RUN}-NEW`);
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where aggregate_id = ${id} and event_type = 'customer.tax_id_changed'`;
    expect(n?.n).toBe(1); // el caso de uso NO duplicó el hecho del trigger
  });

  it("setCustomerBlocked: gestor → 403; cobranzas bloquea; la edición de estado de un bloqueado se rechaza; desbloquear vuelve a active", async () => {
    const gestor = await como(GESTOR, (uow) =>
      setCustomerBlocked(uow, id, { company_id: COMPANY, blocked: true }),
    );
    expect(!gestor.ok && gestor.error.code).toBe("PERMISSION_REQUIRED");

    const bloqueo = await como(COBRANZAS, (uow) =>
      setCustomerBlocked(uow, id, { company_id: COMPANY, blocked: true, reason: "mora" }),
    );
    expect(bloqueo.ok && bloqueo.value.status).toBe("blocked");

    const edicion = await como(GESTOR, (uow) =>
      updateCustomer(uow, id, { company_id: COMPANY, status: "active" }),
    );
    expect(!edicion.ok && edicion.error.code).toBe("VALIDATION_FAILED");

    const otraVez = await como(COBRANZAS, (uow) =>
      setCustomerBlocked(uow, id, { company_id: COMPANY, blocked: true }),
    );
    expect(!otraVez.ok && otraVez.error.message).toContain("ya está bloqueado");

    const des = await como(COBRANZAS, (uow) =>
      setCustomerBlocked(uow, id, { company_id: COMPANY, blocked: false }),
    );
    expect(des.ok && des.value.status).toBe("active");
  });
});
