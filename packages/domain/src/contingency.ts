import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork } from "@ladino/db";
import type {
  RegisterContingencyRangeRequest,
  RegisterContingencyInvoiceRequest,
  CloseContingencyRequest,
  ContingencyRangeResponse,
  DocumentResponse,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";
import { createInvoice, type SalesError } from "./sales.js";

/**
 * CONTINGENCIA (PA 102, migración 35): el talonario físico y el registro
 * a posteriori de lo emitido en papel durante una falla.
 *
 * La decisión que sostiene todo: el talonario ES un `fiscal_number_range`
 * (serie «contingencia…»), así que la factura registrada pasa por
 * `createInvoice` ENTERA — kardex, impuestos, numeración atómica, asiento por
 * ADR-0042, libros. Nada de un camino paralelo «de emergencia» que luego no
 * cuadra con nada.
 *
 * Y el invariante del papel: las facturas se registran EN EL ORDEN del
 * talonario, y los números que el claim asigna TIENEN que ser los impresos.
 * Si no coinciden, el caso de uso devuelve `err` DESPUÉS de crear la factura
 * — y `withTransaction` revierte todo (RollbackPorError): registrar con el
 * número equivocado no deja rastro, solo el mensaje de cuál se esperaba.
 */
export type ContingencyError =
  | CompanyScopeError
  | SalesError
  | { code: "VALIDATION_FAILED"; message: string }
  | { code: "NOT_FOUND"; message: string };

const RANGO_COLUMNS = `cr.id, cr.fiscal_number_range_id, r.series,
  r.range_from::int as range_from, r.range_to::int as range_to,
  r.next_available::int as next_available,
  (r.range_to - r.next_available + 1)::int as remaining, r.status, cr.reason,
  to_char(cr.failure_started_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    as failure_started_at,
  to_char(cr.failure_ended_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    as failure_ended_at`;

export async function registerContingencyRange(
  uow: UnitOfWork,
  input: RegisterContingencyRangeRequest,
): Promise<Result<ContingencyRangeResponse, ContingencyError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "La contingencia exige un usuario real." });
  }
  const scope = await companyScope(
    sql,
    actor.userId,
    input.company_id,
    "fiscal.contingency.manage",
  );
  if (!scope.ok) return scope;

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const [rango] = await sql<{ id: string }[]>`
    insert into public.fiscal_number_ranges
      (tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source)
    values (${scope.value.tenantId}, ${input.company_id}, 'invoice', ${input.series},
            ${input.range_from}, ${input.range_to}, ${input.range_from}, ${input.printer_source})
    returning id`;
  const [fila] = await sql<ContingencyRangeResponse[]>`
    with creada as (
      insert into public.contingency_ranges
        (tenant_id, company_id, fiscal_number_range_id, reason, failure_started_at)
      values (${scope.value.tenantId}, ${input.company_id}, ${rango!.id}, ${input.reason},
              ${input.failure_started_at})
      returning *
    )
    select ${sql.unsafe(RANGO_COLUMNS)}
      from creada cr join public.fiscal_number_ranges r on r.id = cr.fiscal_number_range_id`;
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${scope.value.tenantId}, ${input.company_id}, 'contingency_range', ${fila!.id},
            'fiscal.contingency.range_registered', 'user', now(), ${RULES_VERSION},
            ${sql.json({
              series: input.series,
              range_from: input.range_from,
              range_to: input.range_to,
              reason: input.reason,
            })})`;
  return ok(fila!);
}

export async function registerContingencyInvoice(
  uow: UnitOfWork,
  input: RegisterContingencyInvoiceRequest,
): Promise<Result<{ document: DocumentResponse }, ContingencyError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "La contingencia exige un usuario real." });
  }
  const scope = await companyScope(
    sql,
    actor.userId,
    input.company_id,
    "fiscal.contingency.manage",
  );
  if (!scope.ok) return scope;

  const [rango] = await sql<{ series: string; status: string }[]>`
    select r.series, r.status
      from public.contingency_ranges cr
      join public.fiscal_number_ranges r on r.id = cr.fiscal_number_range_id
     where cr.id = ${input.contingency_range_id} and cr.company_id = ${input.company_id}`;
  if (!rango) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });

  // La factura de papel tiene que caer DENTRO del período de la falla: una
  // emitida fuera no es contingencia, es otra cosa que hay que mirar.
  const [dentro] = await sql<{ ok: boolean }[]>`
    select ${input.issued_at}::timestamptz >= cr.failure_started_at
       and (cr.failure_ended_at is null or ${input.issued_at}::timestamptz <= cr.failure_ended_at)
       as ok
      from public.contingency_ranges cr where cr.id = ${input.contingency_range_id}`;
  if (!dentro?.ok) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "La fecha de la factura cae fuera del período de la falla registrado para ese talonario.",
    });
  }

  // La emisión COMPLETA: kardex, impuestos, numeración, contabilidad, libros.
  const emitida = await createInvoice(uow, {
    company_id: input.company_id,
    customer_id: input.customer_id,
    warehouse_id: input.warehouse_id,
    series: rango.series,
    issued_at: input.issued_at,
    lines: input.lines,
    ...(input.price_list_id === undefined ? {} : { price_list_id: input.price_list_id }),
  });
  if (!emitida.ok) return emitida;
  const doc = emitida.value;

  // El invariante del papel: los números asignados == los impresos. Devolver
  // `err` aquí revierte la factura entera (withTransaction, RollbackPorError).
  const documentoEsperado = String(doc.document_number ?? "");
  const controlEsperado = String(doc.control_number ?? "");
  const papelDocumento = String(BigInt(input.paper_document_number));
  const papelControl = String(BigInt(input.paper_control_number));
  if (documentoEsperado !== papelDocumento || controlEsperado !== papelControl) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        `Los números no cuadran con el talonario: el siguiente por registrar es el ` +
        `${documentoEsperado} (control ${controlEsperado}) y el papel dice ` +
        `${papelDocumento} (control ${papelControl}). Las facturas de contingencia se ` +
        `registran en el orden del talonario, sin saltarse ninguna.`,
    });
  }

  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${scope.value.tenantId}, ${input.company_id}, 'document', ${doc.id},
            'fiscal.contingency.invoice_registered', 'user', now(), ${RULES_VERSION},
            ${sql.json({
              contingency_range_id: input.contingency_range_id,
              document_number: doc.document_number,
              control_number: doc.control_number,
              issued_at: input.issued_at,
            })})`;
  return ok({ document: doc });
}

/** Cerrar el período de la falla — una vez; el trigger LAD06 vigila el resto. */
export async function closeContingency(
  uow: UnitOfWork,
  contingencyRangeId: string,
  input: CloseContingencyRequest,
): Promise<Result<ContingencyRangeResponse, ContingencyError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "La contingencia exige un usuario real." });
  }
  const scope = await companyScope(
    sql,
    actor.userId,
    input.company_id,
    "fiscal.contingency.manage",
  );
  if (!scope.ok) return scope;

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const [fila] = await sql<ContingencyRangeResponse[]>`
    with cerrada as (
      update public.contingency_ranges
         set failure_ended_at = ${input.failure_ended_at}
       where id = ${contingencyRangeId} and company_id = ${input.company_id}
         and failure_ended_at is null
      returning *
    )
    select ${sql.unsafe(RANGO_COLUMNS)}
      from cerrada cr join public.fiscal_number_ranges r on r.id = cr.fiscal_number_range_id`;
  if (!fila) {
    const [existe] = await sql<{ n: number }[]>`
      select 1 as n from public.contingency_ranges
       where id = ${contingencyRangeId} and company_id = ${input.company_id}`;
    if (!existe) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    return err({
      code: "VALIDATION_FAILED",
      message: "Ese período de contingencia ya está cerrado.",
    });
  }
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${scope.value.tenantId}, ${input.company_id}, 'contingency_range',
            ${contingencyRangeId}, 'fiscal.contingency.closed', 'user', now(), ${RULES_VERSION},
            ${sql.json({ failure_ended_at: input.failure_ended_at })})`;
  return ok(fila);
}
