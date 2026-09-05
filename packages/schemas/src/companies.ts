import { z } from "zod";

/**
 * Contratos de `POST /v1/companies` — la fuente única de la que sale el
 * OpenAPI (ADR-0004, ADR-0015). Lo que no está aquí no existe en el contrato.
 *
 * ⚠ SOBRE `tax_id` (el RIF): SIN REGEX, y es una PROHIBICIÓN, no una omisión.
 * El formato del RIF no está en docs/02_COMPLIANCE/ con fuente normativa
 * citada (OPEN_QUESTIONS #9, VALIDAR-SENIAT). Ponerlo aquí sería PEOR que en
 * un CHECK de Postgres: el esquema Zod se comparte con los clientes, y un
 * regex aquí es un cliente decidiendo una regla fiscal (CLAUDE.md §7).
 * Lo defendible sin fuente: no vacío y cota de longitud. Nada más.
 */
export const CreateCompanyRequest = z
  .object({
    tenant_id: z.string().uuid(),
    legal_name: z.string().trim().min(1).max(200),
    trade_name: z.string().trim().min(1).max(200).optional(),
    tax_id: z.string().trim().min(1).max(30),
  })
  .strict();

export type CreateCompanyRequest = z.infer<typeof CreateCompanyRequest>;

export const CompanyResponse = z
  .object({
    id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    legal_name: z.string(),
    trade_name: z.string().nullable(),
    tax_id: z.string(),
    /** Domicilio fiscal del emisor (PA 00071 art. 13.5). NULL hasta que lo cargue. */
    fiscal_address: z.string().nullable(),
    status: z.enum(["onboarding", "active", "suspended"]),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();

/** Cargar o corregir el domicilio fiscal del emisor (migración 34). */
export const SetCompanyFiscalAddressRequest = z
  .object({ fiscal_address: z.string().trim().min(5).max(500) })
  .strict();
export type SetCompanyFiscalAddressRequest = z.infer<typeof SetCompanyFiscalAddressRequest>;

export type CompanyResponse = z.infer<typeof CompanyResponse>;

/**
 * GET /v1/companies — las companies VISIBLES para el actor
 * (`platform.ladino_user_company_ids()`, migración 15). Un array plano: sin
 * paginación mientras el caso real sean decenas de empresas por usuario; el
 * día que haga falta, se envuelve en `{items, next}` como cambio de contrato.
 */
export const ListCompaniesResponse = z.array(CompanyResponse);

/** ADR-0048: los permisos del usuario en la empresa activa, para formar el menú. */
export const MePermissionsResponse = z.object({ permissions: z.array(z.string()) }).strict();
export type MePermissionsResponse = z.infer<typeof MePermissionsResponse>;

/**
 * ADR-0049: fundar el negocio en un acto — tenant, empresa, depósito, roles
 * del fundador y plan contable con plantillas. El RIF es opcional: sin él, la
 * empresa nace con placeholder PEND- y el modo recibos la deja vender ya.
 */
export const OnboardBusinessRequest = z
  .object({
    business_name: z.string().trim().min(2).max(200),
    tax_id: z.string().trim().min(1).max(30).nullable().optional(),
  })
  .strict();
export type OnboardBusinessRequest = z.infer<typeof OnboardBusinessRequest>;

export const OnboardBusinessResponse = z
  .object({
    tenant_id: z.string().uuid(),
    company_id: z.string().uuid(),
    warehouse_id: z.string().uuid(),
  })
  .strict();
export type OnboardBusinessResponse = z.infer<typeof OnboardBusinessResponse>;

/** ADR-0049: miembros del negocio y sus roles. */
export const MemberAssignment = z
  .object({
    id: z.string().uuid(),
    role_key: z.string(),
    role_name: z.string(),
    /** null = asignación a nivel de todo el negocio (el fundador). */
    company_id: z.string().uuid().nullable(),
  })
  .strict();
export type MemberAssignment = z.infer<typeof MemberAssignment>;

export const MemberResponse = z
  .object({
    membership_id: z.string().uuid(),
    user_id: z.string().uuid(),
    email: z.string().nullable(),
    status: z.string(),
    assignments: z.array(MemberAssignment),
  })
  .strict();
export type MemberResponse = z.infer<typeof MemberResponse>;

export const ListMembersResponse = z.object({ members: z.array(MemberResponse) }).strict();
export type ListMembersResponse = z.infer<typeof ListMembersResponse>;

export const AddMemberRequest = z
  .object({
    company_id: z.string().uuid(),
    email: z.string().trim().email(),
    role_key: z.enum([
      "owner",
      "cashier",
      "store_manager",
      "back_office",
      "accountant",
      "warehouse_ops",
    ]),
  })
  .strict();
export type AddMemberRequest = z.infer<typeof AddMemberRequest>;

export const SetMemberStatusRequest = z
  .object({
    company_id: z.string().uuid(),
    status: z.enum(["active", "inactive"]),
  })
  .strict();
export type SetMemberStatusRequest = z.infer<typeof SetMemberStatusRequest>;
export type ListCompaniesResponse = z.infer<typeof ListCompaniesResponse>;

/** Cuerpo de error del contrato (`API_SPEC.md` §Errores). */
export const ErrorResponse = z.object({
  code: z.string(),
  message: z.string(),
  /**
   * La misma verdad en VOZ DE PERSONA (Fase C): dos frases como máximo, qué
   * pasó y qué hacer. Las pantallas de negocio enseñan esta; /admin puede
   * enseñar las dos.
   */
  person_message: z.string().optional(),
  details: z.unknown().optional(),
  request_id: z.string().nullable().optional(),
});

export type ErrorResponse = z.infer<typeof ErrorResponse>;
