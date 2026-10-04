/**
 * Bloque N · Usuarios y roles. Comprobaciones de `pnpm recorrido N` (ver `_app.mjs`).
 *
 * ADR-0068 (el paso interior lo autoriza la operación que lo contiene):
 *   N-01: el cajero no podía vender mercancía (403 de `inventory.move`). Ya no debe reproducir.
 *   N-02: el Dueño invitado a E3 no veía a las personas (403 «a nivel de negocio») ni vendía.
 *   N-04: el administrativo no podía anular (422 con `accounting.entry.reverse` en pantalla).
 */
import { comprobaciones, pedir, afirmar, sql, EMPRESAS, PERSONAS } from "./_app.mjs";

const c = comprobaciones("N");

async function productoDe(empresa, nombre) {
  const [fila] = await sql`
    select id from public.products where company_id = ${EMPRESAS[empresa]} and name = ${nombre}`;
  afirmar(fila, `no existe el producto «${nombre}» en ${empresa}`);
  return fila.id;
}

async function depositoDe(empresa) {
  // El principal lo dice la API (`is_default`), leída por el dueño de E2 y E3.
  const r = await pedir(PERSONAS.duenoE2E3, empresa, "GET", "/v1/warehouses");
  const principal = Array.isArray(r.json) ? r.json.find((d) => d.is_default) : undefined;
  afirmar(principal, `${empresa} no tiene depósito principal (${r.status})`);
  return principal.id;
}

/** Venta de contado de UNA unidad, pagada exacta en Bs con el total que cotiza el servidor. */
async function venderUno(correo, empresa, nombre) {
  const producto = await productoDe(empresa, nombre);
  const deposito = await depositoDe(empresa);
  const cot = await pedir(correo, empresa, "POST", "/v1/pos/quote", {
    company_id: EMPRESAS[empresa],
    lines: [{ product_id: producto, quantity: "1" }],
  });
  afirmar(cot.status === 200, `la cotización dio ${cot.status}: ${cot.texto.slice(0, 200)}`);
  // La factura sobre forma libre identifica al adquirente (PA 00071 art. 13.7, ola 2): el
  // «Consumidor final» es solo para recibos. Un cliente del escenario con documento.
  const [cliente] = await sql`
    select id from public.customers
     where company_id = ${EMPRESAS[empresa]} and not is_system and tax_id is not null
       and upper(tax_id) not like 'PEND-%'
     order by created_at limit 1`;
  afirmar(cliente, `no hay cliente identificado en ${empresa}`);
  return pedir(correo, empresa, "POST", "/v1/pos/sales", {
    company_id: EMPRESAS[empresa],
    customer_id: cliente.id,
    warehouse_id: deposito,
    lines: [{ product_id: producto, quantity: "1" }],
    // En bolívares: el efectivo en divisa causa IGTF en E3 (contribuyente especial) y el total
    // en USD no alcanzaría.
    payments: [{ instrument: "efectivo_bs", currency: "VES", amount: cot.json.functional_total }],
  });
}

/** Lo que SOLO produce la venta de verdad: un movimiento de kardex con su documento. */
async function conKardex(r, empresa) {
  const [mov] = await sql`
    select count(*)::int as n from public.inventory_moves
     where company_id = ${EMPRESAS[empresa]} and source_document_id = ${r.json.document.id}`;
  afirmar(mov.n > 0, "la venta no dejó movimiento de inventario con su documento");
}

c.caso("N-01", "cajero@ vende de contado 1 «Pasta caja x20» en E2 → 201 y kardex", async () => {
  const r = await venderUno(PERSONAS.cajero, "E2", "Pasta caja x20");
  afirmar(r.status === 201, `esperaba 201, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
  await conKardex(r, "E2");
});

c.caso("N-02", "dueno.andina@ en E3 ve a las personas: GET /v1/members → 200", async () => {
  const r = await pedir(PERSONAS.duenoE2E3, "E3", "GET", "/v1/members");
  afirmar(r.status === 200, `esperaba 200, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
  const correos = (r.json?.members ?? []).map((m) => m.email);
  afirmar(correos.includes(PERSONAS.registraE3), "la lista no trae al Titular (tornillo@)");
});

c.caso("N-02", "dueno.andina@ vende de contado 1 «Cemento gris 42,5 kg» en E3 → 201", async () => {
  const r = await venderUno(PERSONAS.duenoE2E3, "E3", "Cemento gris 42,5 kg");
  afirmar(r.status === 201, `esperaba 201, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
  await conKardex(r, "E3");
});

c.caso(
  "N-04",
  "administrativo@ anula en E2 una factura sin cobro → 200 y asiento reversed",
  async () => {
    const producto = await productoDe("E2", "Pasta caja x20");
    const deposito = await depositoDe("E2");
    const [cliente] = await sql`
    select id from public.customers
     where company_id = ${EMPRESAS.E2} and legal_name ilike 'Abastos El Sol%' limit 1`;
    afirmar(cliente, "no existe el cliente Abastos El Sol en E2");
    const emitida = await pedir(PERSONAS.administrativo, "E2", "POST", "/v1/pos/sales", {
      company_id: EMPRESAS.E2,
      customer_id: cliente.id,
      warehouse_id: deposito,
      lines: [{ product_id: producto, quantity: "1" }],
    });
    afirmar(
      emitida.status === 201,
      `la emisión dio ${emitida.status}: ${emitida.texto.slice(0, 200)}`,
    );
    const anular = await pedir(
      PERSONAS.administrativo,
      "E2",
      "POST",
      `/v1/invoices/${emitida.json.document.id}/annul`,
      { company_id: EMPRESAS.E2, reason: "Verificación N-04 del recorrido" },
    );
    afirmar(
      anular.status === 200,
      `esperaba 200, llegó ${anular.status}: ${anular.texto.slice(0, 200)}`,
    );
    const [asiento] = await sql`
    select je.status from public.documents d
      join public.journal_entries je on je.id = d.journal_entry_id
     where d.id = ${emitida.json.document.id}`;
    afirmar(asiento?.status === "reversed", `el asiento quedó en ${asiento?.status}`);
  },
);

// N-07 (ola 3): las membresías y asignaciones se leen con membership.read. El REPRODUCIR: con el
// JWT del cajero, en una transacción de solo lectura, cuántas ve de E2.
async function vistasComo(correo) {
  const [u] = await sql`select id from auth.users where email = ${correo}`;
  return sql.begin("read only", async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: u.id, role: "authenticated" })}, true)`;
    await tx`set local role authenticated`;
    const [f] = await tx`
      select (select count(*)::int from public.memberships m
               where m.tenant_id = (select tenant_id from public.companies where id = ${EMPRESAS.E2})) as membresias,
             (select count(*)::int from public.user_role_assignments a
               where a.tenant_id = (select tenant_id from public.companies where id = ${EMPRESAS.E2})) as asignaciones`;
    return f;
  });
}
c.caso(
  "N-07",
  "el cajero de E2 ve por la base UNA membresía y UNA asignación (las suyas)",
  async () => {
    const v = await vistasComo(PERSONAS.cajero);
    afirmar(
      v.membresias === 1 && v.asignaciones === 1,
      `ve ${v.membresias} membresías y ${v.asignaciones} asignaciones`,
    );
  },
);
c.caso("N-07", "el dueño de E2 (membership.read) las sigue viendo todas", async () => {
  const v = await vistasComo(PERSONAS.duenoE2E3);
  afirmar(
    v.membresias > 1 && v.asignaciones > 1,
    `ve ${v.membresias} membresías y ${v.asignaciones} asignaciones`,
  );
});

// N-10 (ola 3): reactivar desde «Agregar persona» deja acta, y quitar un rol queda en el historial
// de la MEMBRESÍA. Un ciclo que deja al almacenista como estaba (activo, con warehouse_ops).
c.caso(
  "N-10",
  "apagar, volver a agregar y quitar el rol: las dos actas en la membresía",
  async () => {
    const [m] = await sql`
    select m.id from public.memberships m join auth.users u on u.id = m.user_id
     where u.email = ${PERSONAS.almacenista}
       and m.tenant_id = (select tenant_id from public.companies where id = ${EMPRESAS.E2})`;
    const apagar = await pedir(PERSONAS.duenoE2E3, "E2", "PUT", `/v1/members/${m.id}/status`, {
      company_id: EMPRESAS.E2,
      status: "inactive",
    });
    afirmar(apagar.status === 200, `apagar: ${apagar.status}`);
    const volver = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/members", {
      company_id: EMPRESAS.E2,
      email: PERSONAS.almacenista,
      role_key: "cashier",
    });
    afirmar(
      volver.status === 201,
      `volver a agregar: ${volver.status} ${volver.texto.slice(0, 160)}`,
    );
    const [asig] = await sql`
    select a.id from public.user_role_assignments a join public.roles r on r.id = a.role_id
     where a.membership_id = ${m.id} and r.key = 'cashier' and a.company_id = ${EMPRESAS.E2}`;
    const quitar = await pedir(
      PERSONAS.duenoE2E3,
      "E2",
      "DELETE",
      `/v1/members/assignments/${asig.id}`,
    );
    afirmar(quitar.status === 200, `quitar: ${quitar.status}`);
    const [actas] = await sql`
    select count(*) filter (where event_type = 'member.reactivated'
                              and payload ->> 'via' = 'add_member')::int as reactivado,
           count(*) filter (where event_type = 'member.role_revoked'
                              and payload ->> 'assignment_id' = ${asig.id})::int as revocado
      from public.audit_events
     where aggregate_type = 'membership' and aggregate_id = ${m.id}`;
    afirmar(actas.reactivado >= 1, "reactivar desde «Agregar persona» no dejó acta");
    afirmar(actas.revocado === 1, "la revocación no está en el historial de la membresía");
  },
);

// ── ADR-0077 §3 (N-08, N-03, N-06): invitación por enlace y el acceso perdido ───────────────────
c.caso(
  "N-08",
  "agregar a quien no tiene cuenta ya tiene camino: la invitación por enlace, de un solo uso",
  async () => {
    const inv = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/invitations", {
      company_id: EMPRESAS.E2,
      role_key: "cashier",
    });
    afirmar(inv.status === 201, `POST /v1/invitations dio ${inv.status}`);
    const [fila] = await sql`
      select token_hash, accepted_at from public.member_invitations where id = ${inv.json.id}`;
    afirmar(fila && fila.accepted_at === null, "la invitación no quedó pendiente");
    afirmar(!fila.token_hash.includes(inv.json.token), "la base guarda el token en claro");
    const falso = await pedir(PERSONAS.cajero, null, "POST", "/v1/invitations/preview", {
      token: "0".repeat(64),
    });
    afirmar(falso.status === 404, `un token inventado dio ${falso.status}`);
    // Sin permiso de personas (el cajero) no se invita.
    const cajero = await pedir(PERSONAS.cajero, "E2", "POST", "/v1/invitations", {
      company_id: EMPRESAS.E2,
      role_key: "owner",
    });
    afirmar(cajero.status === 403, `el cajero invitó: ${cajero.status}`);
  },
);

c.caso(
  "N-03/N-06",
  "el cajero desactivado ve «acceso perdido» con quien administra; nunca «monta tu negocio»",
  async () => {
    // En una transacción que se DESHACE: el escenario no cambia.
    const [cajero] = await sql`select id from auth.users where email = ${PERSONAS.cajero}`;
    let visto = null;
    await sql
      .begin(async (tx) => {
        await tx`update public.memberships m set status = 'inactive'
                  from public.companies c
                 where c.id = ${EMPRESAS.E2} and m.tenant_id = c.tenant_id
                   and m.user_id = ${cajero.id}`;
        await tx`select set_config('ladino.actor_id', ${cajero.id}, true)`;
        const [p] = await tx`select platform.lost_access_to_company(${EMPRESAS.E2}) as p`;
        const lista = await tx`select business_name, admin_name from platform.my_lost_access()`;
        visto = { perdido: p.p, lista };
        throw new Error("deshacer");
      })
      .catch((e) => {
        if (!(e instanceof Error && e.message === "deshacer")) throw e;
      });
    afirmar(visto.perdido === true, "E2 no le responde ACCESS_REVOKED al cajero desactivado");
    afirmar(visto.lista.length >= 1, "no aparece el negocio que perdió");
    const [activo] = await sql`
      select m.status from public.memberships m join public.companies c on c.tenant_id = m.tenant_id
       where c.id = ${EMPRESAS.E2} and m.user_id = ${cajero.id}`;
    afirmar(activo.status === "active", "la comprobación dejó al cajero desactivado");
  },
);

export default c.correr;
