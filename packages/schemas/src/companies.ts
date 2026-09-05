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
