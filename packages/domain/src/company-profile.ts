import { err, ok, type Result } from "@ladino/core";
import type { TransactionSql, UnitOfWork } from "@ladino/db";
import type {
  UpdateCompanyProfileRequest,
  SetCompanyTaxIdRequest,
  CorrectCompanyTaxIdRequest,
  MyProfileResponse,
  SetMyProfileRequest,
} from "@ladino/schemas";
import { companyScope, type CompanyScopeError } from "./company-scope.js";
import { normalizarDocumento } from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { registrarDigitoDudoso, validarRif } from "./documento-identidad.js";

/**
 * MI EMPRESA y la POLÍTICA DE RIF EN TRES NIVELES (registro premium, PARTE 4).
 *
 * El número de RIF es identificador PERMANENTE del contribuyente (PA 00080 /
 * 00084: ya ni caduca). Cambiarlo = otro contribuyente. Los datos asociados
 * (razón social, domicilio) sí cambian legítimamente y el SENIAT obliga a
 * notificarlos — por eso se editan CON acta cuando ya hay documentos.
 *
 *   1. SIN documentos emitidos: RIF editable con confirmación simple
 *      (`setCompanyTaxId`); razón social y dirección libres.
 *   2. CON documentos emitidos: RIF BLOQUEADO (422 aquí, no solo en la UI);
 *      razón social/dirección editables con MOTIVO obligatorio + acta.
 *   3. «Corregir RIF» (dedazo tardío): `correctCompanyTaxId`, acción aparte
 *      con permiso propio + motivo + acta — funciona AUNQUE haya documentos,
 *      porque corregir un error de tipeo no es cambiar de contribuyente.
 *
 * «Tiene documentos» lo responde platform.company_has_fiscal_documents
 * (migración 43), que EXCLUYE los recibos: pasar de PEND-* al RIF real ES la
 * transición del modo recibos a facturación y jamás se bloquea.
 *
 * Quién escribe cada acta: para el RIF, el TRIGGER de la migración 20 ya
 * registra company.tax_id_changed con el valor anterior — el caso de uso solo
 * aporta permiso segregado + outbox (espejo de setCustomerTaxId). Para los
 * campos de perfil, el patrón simple de setCompanyFiscalAddress: leer
 * anterior → UPDATE → audit_event con {from, to}.
 */

interface PerfilRow {
  legal_name: string;
  trade_name: string | null;
  tax_id: string;
  fiscal_address: string | null;
  business_type: string | null;
  phone: string | null;
  whatsapp: string | null;
  city: string | null;
  state: string | null;
  activity_start_date: string | null;
}

// A-10/E-15 (RESPUESTA §3 A-10, ADR-0077 §2): con documentos emitidos el camino es la corrección
// con motivo; la «otra empresa» ya existe en el selector (A-13). El aviso es el texto del dueño.
const COPY_RIF_BLOQUEADO =
  "Ya emitiste documentos con este RIF, así que no se cambia directo. Si estaba mal tecleado, " +
  "usa «Corregir RIF» con el motivo: los documentos ya emitidos no se reemiten; si el RIF " +
  "anterior era erróneo, esas facturas no cumplen el art. 13.5 de la PA 00071: consulta con tu " +
  "asesor si procede anular y reemitir. Si tu negocio ahora opera con otro RIF, eso es una " +
  "entidad nueva: créala con «Crear otra empresa» en el selector de empresas y mantén esta con " +
  "su historia.";

export type CompanyProfileError =
  | CompanyScopeError
  | { code: "COMPANY_SUSPENDED"; message: string }
  | { code: "VALIDATION_FAILED"; message: string }
  | { code: "DUPLICATE"; message: string };

async function tieneDocumentos(sql: TransactionSql, companyId: string): Promise<boolean> {
  const [r] = await sql<{ tiene: boolean }[]>`
    select platform.company_has_fiscal_documents(${companyId}) as tiene`;
  return r?.tiene === true;
}

async function perfilActual(sql: TransactionSql, companyId: string): Promise<PerfilRow> {
  const [fila] = await sql<PerfilRow[]>`
    select legal_name, trade_name, tax_id, fiscal_address,
           business_type, phone, whatsapp, city, state,
           activity_start_date::text as activity_start_date
      from public.companies where id = ${companyId}`;
  return fila!;
}

/** Editar el perfil de «Mi empresa». El RIF tiene su puerta aparte. */
export async function updateCompanyProfile(
  uow: UnitOfWork,
  companyId: string,
  input: UpdateCompanyProfileRequest,
): Promise<Result<PerfilRow, CompanyProfileError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Editar la empresa exige un usuario real.",
    });
  }
  const scope = await companyScope(sql, actor.userId, companyId, "company.settings.manage");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }

  const actual = await perfilActual(sql, companyId);

  // Qué cambia de verdad (lo no enviado se conserva; null explícito borra).
  const destino: PerfilRow = {
    ...actual,
    ...(input.legal_name === undefined ? {} : { legal_name: input.legal_name }),
    ...(input.trade_name === undefined ? {} : { trade_name: input.trade_name }),
    ...(input.fiscal_address === undefined ? {} : { fiscal_address: input.fiscal_address }),
    ...(input.business_type === undefined ? {} : { business_type: input.business_type }),
    ...(input.phone === undefined ? {} : { phone: input.phone }),
    ...(input.whatsapp === undefined ? {} : { whatsapp: input.whatsapp }),
    ...(input.city === undefined ? {} : { city: input.city }),
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.activity_start_date === undefined
      ? {}
      : { activity_start_date: input.activity_start_date }),
  };
  const cambios: Record<string, { from: string | null; to: string | null }> = {};
  for (const campo of [
    "legal_name",
    "trade_name",
    "fiscal_address",
    "business_type",
    "phone",
    "whatsapp",
    "city",
    "state",
    "activity_start_date",
  ] as const) {
    if (destino[campo] !== actual[campo]) {
      cambios[campo] = { from: actual[campo], to: destino[campo] };
    }
  }
  if (Object.keys(cambios).length === 0) return ok(actual);

  // Nivel 2: la IDENTIDAD del emisor (razón social, domicilio) con documentos
  // emitidos exige MOTIVO. Las facturas ya emitidas conservan su snapshot
  // (migración 34); el papel preimpreso con datos viejos queda inválido — la
  // UI lo advierte, el acta lo registra.
  const identidad = "legal_name" in cambios || "fiscal_address" in cambios;
  if (identidad && input.reason === undefined && (await tieneDocumentos(sql, companyId))) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Ya emitiste documentos con estos datos: cambiar la razón social o la dirección fiscal exige un motivo, que queda en la auditoría.",
    });
  }

  // ADR-0069 §3 (K-05): el inicio de actividades no es futuro ni posterior al primer hecho
  // contable (el asiento no descartado más antiguo): moverlo por encima dejaría asientos antes
  // del inicio. `date` contra `date` (fechas ISO; hoy EN CARACAS).
  if ("activity_start_date" in cambios && destino.activity_start_date !== null) {
    const [lim] = await sql<{ hoy: string; primero: string | null }[]>`
      select (now() at time zone 'America/Caracas')::date::text as hoy,
             (select min(posting_date)::text from public.journal_entries
               where company_id = ${companyId} and status <> 'discarded') as primero`;
    if (destino.activity_start_date > lim!.hoy) {
      return err({
        code: "VALIDATION_FAILED",
        message: "La fecha de inicio de actividades no puede ser futura.",
      });
    }
    if (lim!.primero !== null && destino.activity_start_date > lim!.primero) {
      return err({
        code: "VALIDATION_FAILED",
        message: `La fecha de inicio de actividades no puede ser posterior al primer asiento de la empresa (${lim!.primero.split("-").reverse().join("/")}).`,
      });
    }
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  await sql`
    update public.companies set
      legal_name = ${destino.legal_name},
      trade_name = ${destino.trade_name},
      fiscal_address = ${destino.fiscal_address},
      business_type = ${destino.business_type},
      phone = ${destino.phone},
      whatsapp = ${destino.whatsapp},
      city = ${destino.city},
      state = ${destino.state},
      activity_start_date = ${destino.activity_start_date}::date
     where id = ${companyId}`;
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${scope.value.tenantId}, ${companyId}, 'company', ${companyId},
            'company.profile_updated', 'user', now(), ${RULES_VERSION},
            ${sql.json({ cambios, ...(input.reason === undefined ? {} : { reason: input.reason }) })})`;
  return ok(destino);
}

/**
 * Poner el PRIMER RIF (reemplazar PEND-*) o cambiarlo SIN documentos: nivel 1.
 * Con documentos, 422 con la voz de la PARTE 3 — ese caso es la corrección.
 */
export async function setCompanyTaxId(
  uow: UnitOfWork,
  companyId: string,
  input: SetCompanyTaxIdRequest,
): Promise<Result<{ tax_id: string }, CompanyProfileError>> {
  return cambiarRif(uow, companyId, input.tax_id, null, false);
}

/** La corrección EXCEPCIONAL (nivel 3): motivo obligatorio, acta propia. */
export async function correctCompanyTaxId(
  uow: UnitOfWork,
  companyId: string,
  input: CorrectCompanyTaxIdRequest,
): Promise<Result<{ tax_id: string }, CompanyProfileError>> {
  return cambiarRif(uow, companyId, input.tax_id, input.reason, true);
}

async function cambiarRif(
  uow: UnitOfWork,
  companyId: string,
  taxIdCrudo: string,
  reason: string | null,
  esCorreccion: boolean,
): Promise<Result<{ tax_id: string }, CompanyProfileError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "El RIF exige un usuario real." });
  }
  // Permiso SEGREGADO (migración 20), no el de settings: la identidad fiscal
  // de la empresa no se toca con la edición rutinaria.
  const scope = await companyScope(sql, actor.userId, companyId, "company.tax_id.manage");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }

  // A-17 y A-08: solo un RIF con estructura (nunca el marcador PEND-, que ocultaría la capa
  // fiscal de una empresa que factura), y se guarda NORMALIZADO. El dígito verificador que no
  // cuadra se acepta y queda en la auditoría.
  const leido = validarRif(taxIdCrudo);
  if (!leido.ok) return leido;
  const documento = leido.value;
  const taxId = documento.normalizado;

  const actual = await perfilActual(sql, companyId);
  // Hallazgo 5: el MISMO RIF con otra grafía (el guardado antes de la reparación P-02 puede
  // llevar guiones) no es un cambio: ok, sin escribir — ni acta ni outbox.
  if (normalizarDocumento(actual.tax_id) === taxId) return ok({ tax_id: actual.tax_id });

  const esPrimero = actual.tax_id.startsWith("PEND-");
  if (!esPrimero && !esCorreccion && (await tieneDocumentos(sql, companyId))) {
    return err({ code: "VALIDATION_FAILED", message: COPY_RIF_BLOQUEADO });
  }
  // La regla dura de la migración 43: un RIF real sin domicilio fiscal deja
  // la factura sin su art. 13.5. La dirección va primero.
  if (actual.fiscal_address === null) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Antes del RIF, carga la dirección fiscal: es la que sale en tus facturas.",
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  try {
    await sql.savepoint(async (sp) => {
      await sp`update public.companies set tax_id = ${taxId} where id = ${companyId}`;
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      return err({
        code: "DUPLICATE",
        message: "Ya existe una empresa con ese RIF en este tenant.",
      });
    }
    throw e;
  }

  await registrarDigitoDudoso(sql, {
    tenantId: scope.value.tenantId,
    companyId,
    aggregateType: "company",
    aggregateId: companyId,
    documento,
    rulesVersion: RULES_VERSION,
  });

  // El acta con el valor anterior YA la escribió el trigger de la migración
  // 20 (company.tax_id_changed). La corrección deja ADEMÁS su propia acta con
  // el motivo: son dos hechos — el cambio y su porqué excepcional.
  if (esCorreccion) {
    await sql`
      insert into public.audit_events
        (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
         actor_type, occurred_at, rules_version, payload)
      values (${scope.value.tenantId}, ${companyId}, 'company', ${companyId},
              'company.tax_id_corrected', 'user', now(), ${RULES_VERSION},
              ${sql.json({ from: actual.tax_id, to: taxId, reason })})`;
  }
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       schema_version, payload)
    values (${scope.value.tenantId}, ${companyId}, 'company', ${companyId},
            'company.tax_id_changed', 1,
            ${sql.json({ company_id: companyId, from: actual.tax_id, to: taxId, ...(reason === null ? {} : { reason }) })})`;
  return ok({ tax_id: taxId });
}

/**
 * A-07: ¿puede este usuario cambiar el logo? La ruta lo pregunta ANTES de escribir en el
 * almacenamiento: un 403 no deja objetos huérfanos. `setCompanyLogo` vuelve a autorizar al
 * persistir (la autorización de la escritura es la suya; esta solo evita la basura).
 */
export async function autorizarLogo(
  uow: UnitOfWork,
  companyId: string,
): Promise<Result<{ tenantId: string }, CompanyProfileError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "El logo exige un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, companyId, "company.settings.manage");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  return ok({ tenantId: scope.value.tenantId });
}

/**
 * A-14: los objetos de logo que ya se pueden purgar (más de 30 días, no vigentes y sin documento
 * emitido mientras fueron el logo). La decisión es del esquema (`company_logo_purgeable`); borrar
 * del almacenamiento lo hace la ruta, que tiene la credencial de Storage.
 */
export async function logosPurgables(uow: UnitOfWork, companyId: string): Promise<string[]> {
  const filas = await uow.sql<{ object_name: string }[]>`
    select object_name from platform.company_logo_purgeable(${companyId})`;
  return filas.map((f) => f.object_name);
}

/** El logo: presentación pura (jamás dato fiscal congelado). Patrón product-images. */
export async function setCompanyLogo(
  uow: UnitOfWork,
  companyId: string,
  logoPath: string,
): Promise<Result<{ logo_path: string }, CompanyProfileError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "El logo exige un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, companyId, "company.settings.manage");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const [anterior] = await sql<{ logo_path: string | null }[]>`
    select logo_path from public.companies where id = ${companyId}`;
  await sql`update public.companies set logo_path = ${logoPath} where id = ${companyId}`;
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${scope.value.tenantId}, ${companyId}, 'company', ${companyId},
            'company.logo_set', 'user', now(), ${RULES_VERSION},
            ${sql.json({ from: anterior?.logo_path ?? null, to: logoPath })})`;
  return ok({ logo_path: logoPath });
}

/** La ficha de quien administra (users_profile). Cada quien la suya. */
export async function getMyProfile(
  sql: TransactionSql,
  userId: string,
): Promise<MyProfileResponse> {
  const [fila] = await sql<{ full_name: string; national_id: string | null }[]>`
    select full_name, national_id from public.users_profile where user_id = ${userId}`;
  return { full_name: fila?.full_name ?? null, national_id: fila?.national_id ?? null };
}

export async function setMyProfile(
  uow: UnitOfWork,
  input: SetMyProfileRequest,
): Promise<Result<MyProfileResponse, { code: "PERMISSION_REQUIRED"; message: string }>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "La ficha es de una persona real." });
  }
  await sql`
    insert into public.users_profile (user_id, full_name, national_id)
    values (${actor.userId}, ${input.full_name}, ${input.national_id ?? null})
    on conflict (user_id) do update
      set full_name = excluded.full_name,
          national_id = excluded.national_id`;
  return ok({ full_name: input.full_name, national_id: input.national_id ?? null });
}
