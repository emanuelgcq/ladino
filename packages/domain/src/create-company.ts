import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork } from "@ladino/db";
import type { CreateCompanyRequest, CompanyResponse } from "@ladino/schemas";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CASO DE USO PLANTILLA — crear empresa. LOS DIEZ PASOS DEL PATRÓN, EN ORDEN.
 *
 * Esto lo copian diez módulos: el código es la referencia, no un ejemplo
 * simplificado. Cada paso lleva su número; los que aquí son no-op se declaran
 * como no-op EN SU SITIO en vez de omitirse, para que quien copie vea el hueco
 * que su módulo sí tiene que llenar.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Entra con la transacción YA ABIERTA por `withTransaction` (@ladino/db), que
 * fijó `ladino.actor_id` como primera sentencia. El caso de uso NO abre
 * transacciones ni fija GUC de actor: si lo hiciera, habría dos sitios donde
 * equivocarse. La única excepción es `ladino.rules_version` (paso 5), que es
 * dato del caso de uso, no del transporte.
 *
 * Versión de reglas: este caso de uso no calcula nada tributario, pero la
 * regla 3 de CLAUDE.md exige versión de reglas en TODO evento de auditoría, y
 * el trigger M4 la lee del GUC. Se declara la del paquete.
 */
export const RULES_VERSION = "domain-s0.5";

export type CreateCompanyError =
  | { code: "NOT_FOUND"; message: string }
  | { code: "PERMISSION_REQUIRED"; message: string }
  | { code: "TENANT_SUSPENDED"; message: string }
  | { code: "DUPLICATE"; message: string };

interface CompanyRow {
  id: string;
  tenant_id: string;
  legal_name: string;
  trade_name: string | null;
  tax_id: string;
  status: "onboarding" | "active" | "suspended";
  created_at: string;
}

export async function createCompany(
  uow: UnitOfWork,
  input: CreateCompanyRequest,
): Promise<Result<CompanyResponse, CreateCompanyError>> {
  const { sql, actor } = uow;

  // ── 1. AUTORIZAR ──────────────────────────────────────────────────────────
  // Crear una company es una operación de NIVEL TENANT: todavía no hay company
  // contra la que preguntar, así que las funciones platform.ladino_* (que
  // resuelven POR company, ADR-0025 §5) no sirven aquí. La regla que se aplica
  // es la de ADR-0025 §2: una asignación de rol con company_id NULL es
  // tenant-wide. Autoriza quien tiene `company.manage` en una asignación
  // tenant-wide de este tenant.
  //
  // El actor de sistema NO pasa por aquí: companies.created_by tiene FK a
  // auth.users (asimetría deliberada, API_SPEC.md §El centinela), así que este
  // caso de uso exige un usuario real siempre.
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Crear una empresa exige un usuario real, no el actor de sistema.",
    });
  }

  // ⚠ Este JOIN replica la semántica de platform.ladino_user_has_permission()
  // para el caso tenant-wide, y CADA filtro de la función canónica tiene que
  // estar aquí. La primera versión omitió `not r.requires_scope` y la
  // auditoría lo encontró alcanzable: un rol ACOTADO (cajero) con
  // company.manage, asignado tenant-wide, autorizaba a crear empresas — cuando
  // ADR-0025 §4 dice que un rol acotado sin bindings no opera NADA, y en una
  // operación de nivel tenant no hay recurso al que atar un binding. Si la
  // función canónica gana un filtro (p. ej. expires_at, ADR-0030), este JOIN
  // tiene que ganarlo también — es el coste de no poder usarla aquí.
  const [membresia] = await sql<{ autorizado: boolean }[]>`
    select exists (
      select 1
        from public.memberships m
        join public.user_role_assignments ura
          on ura.membership_id = m.id and ura.company_id is null
        join public.roles r
          on r.id = ura.role_id and not r.requires_scope
        join public.role_permissions rp
          on rp.role_id = r.id and rp.permission_key = 'company.manage'
       where m.tenant_id = ${input.tenant_id}
         and m.user_id = ${actor.userId}
         and m.status = 'active'
    ) as autorizado`;

  // ── 3. CARGAR Y BLOQUEAR ──────────────────────────────────────────────────
  // (El paso 2, idempotencia, vive en el MIDDLEWARE: T1 reservó la clave antes
  //  de llegar aquí y T2 la cierra después. Un replay no ejecuta este cuerpo.)
  //
  // Se bloquea la fila del TENANT: serializa el alta contra una suspensión
  // concurrente del tenant, y de paso responde si existe. FOR UPDATE y no
  // FOR SHARE porque la decisión de crear depende del estado que se lee.
  const [tenant] = await sql<{ id: string; status: string }[]>`
    select id, status from public.tenants
     where id = ${input.tenant_id}
       for update`;

  // La regla 404/403 de ERROR_CATALOG.md, aplicada en el orden que la hace
  // valer: PRIMERO invisible (404), DESPUÉS sin permiso (403). Al revés, un
  // 403 sobre un tenant ajeno confirmaría que existe.
  if (!tenant || !membresia?.autorizado) {
    // Sin membership activo en el tenant, el tenant NO ES VISIBLE para este
    // usuario → 404, exista o no (las dos respuestas deben ser idénticas: un
    // 403 sobre tenant ajeno confirmaría su existencia). Con membership pero
    // sin company.manage tenant-wide → 403: la existencia ya la conocía.
    const [visible] = await sql<{ v: boolean }[]>`
      select exists (
        select 1 from public.memberships
         where tenant_id = ${input.tenant_id}
           and user_id = ${actor.userId} and status = 'active'
      ) as v`;
    if (!tenant || !visible?.v) {
      // Código NOT_FOUND, EL MISMO que produce el 23503 de la FK cuando el
      // tenant no existe. Con un código propio (TENANT_NOT_FOUND) los dos 404
      // eran distinguibles por el cuerpo y el status no ocultaba nada: quien
      // sondea leería «existe pero no es tuyo» en el code. Lo cazó el test E2E
      // comparando los cuerpos de los dos caminos, no solo el status.
      return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    }
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Crear empresas exige el permiso company.manage a nivel de tenant.",
    });
  }

  // ── 4. VALIDAR ────────────────────────────────────────────────────────────
  // La FORMA la validó Zod en el borde (el handler no llama aquí sin parsear).
  // Aquí van los invariantes de NEGOCIO que Zod no puede saber:
  if (tenant.status !== "active") {
    return err({
      code: "TENANT_SUSPENDED",
      message: "No se pueden crear empresas en un tenant suspendido.",
    });
  }

  // ── 5. CALCULAR (puro) ────────────────────────────────────────────────────
  // Aquí no hay cálculo monetario: no-op DECLARADO. En un módulo con dinero,
  // este paso invoca packages/money|accounting con reglas versionadas y SIN
  // reloj ni aleatoriedad propios.
  //
  // Lo que sí se fija aquí es la versión de reglas, ANTES de persistir: el
  // trigger M4 la lee al registrar company.tax_id_established, y sin esto esa
  // fila diría 'db-guard' (= "ningún caso de uso declaró su versión").
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  // ── 6. PERSISTIR ──────────────────────────────────────────────────────────
  // created_by/created_at/version los gobierna set_row_provenance() desde el
  // GUC que fijó withTransaction: el caso de uso NO los toca.
  let fila: CompanyRow;
  try {
    const [creada] = await sql<CompanyRow[]>`
      insert into public.companies (tenant_id, legal_name, trade_name, tax_id)
      values (${input.tenant_id}, ${input.legal_name}, ${input.trade_name ?? null},
              ${input.tax_id})
      returning id, tenant_id, legal_name, trade_name, tax_id, status,
                -- ISO 8601 explícito: el texto por defecto de timestamptz usa
                -- espacio y offset corto, y depender del parseo laxo de Date
                -- es depender de un detalle del motor.
                to_char(created_at at time zone 'utc',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;
    fila = creada!;
  } catch (e) {
    // El único conflicto esperable: RIF repetido en el tenant
    // (companies_tenant_tax_id_key). Cualquier otro error sube al middleware.
    if ((e as { code?: string }).code === "23505") {
      return err({
        code: "DUPLICATE",
        message: "Ya existe una empresa con ese RIF en este tenant.",
      });
    }
    throw e;
  }

  // ── 7. IMPACTAR CONTABILIDAD / INVENTARIO ────────────────────────────────
  // No-op DECLARADO: crear una empresa no mueve dinero ni stock. En ventas,
  // compras o tesorería este paso es obligatorio y va ANTES de auditar, para
  // que la auditoría cubra también el impacto.

  // ── 8. AUDITAR ────────────────────────────────────────────────────────────
  // El caso de uso escribe el HECHO DE NEGOCIO: company.created. El trigger M4
  // escribe además company.tax_id_established — NO es un duplicado: son dos
  // hechos distintos (el acto administrativo / la identidad fiscal inicial), y
  // la partición del trabajo está decidida en EVENT_CATALOG.md §Estructura:
  // el caso de uso NO registra el hecho del RIF, el trigger NO registra el
  // acto. Cada uno el suyo.
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values
      (${fila.tenant_id}, ${fila.id}, 'company', ${fila.id}, 'company.created',
       'user', now(), ${RULES_VERSION},
       ${sql.json({ legal_name: fila.legal_name, tax_id: fila.tax_id })})`;

  // ── 9. OUTBOX ─────────────────────────────────────────────────────────────
  // En LA MISMA transacción: si el commit falla, no hay evento huérfano.
  // event_type del catálogo (EVENT_CATALOG.md §Estructura organizacional), no
  // inventado aquí — el CHECK de forma no valida el catálogo, solo la forma.
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       schema_version, payload)
    values
      (${fila.tenant_id}, ${fila.id}, 'company', ${fila.id}, 'company.created', 1,
       ${sql.json({
         company_id: fila.id,
         tenant_id: fila.tenant_id,
         legal_name: fila.legal_name,
         tax_id: fila.tax_id,
       })})`;

  // ── 10. COMMIT ────────────────────────────────────────────────────────────
  // Implícito: lo hace withTransaction al resolver esta promesa. El caso de
  // uso NUNCA commitea por su cuenta — si lo hiciera, los pasos posteriores de
  // otro llamante quedarían fuera de la atomicidad.
  return ok({
    id: fila.id,
    tenant_id: fila.tenant_id,
    legal_name: fila.legal_name,
    trade_name: fila.trade_name,
    tax_id: fila.tax_id,
    status: fila.status,
    created_at: fila.created_at,
  });
}
