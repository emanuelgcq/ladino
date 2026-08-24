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
    status: z.enum(["onboarding", "active", "suspended"]),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();

export type CompanyResponse = z.infer<typeof CompanyResponse>;

/** Cuerpo de error del contrato (`API_SPEC.md` §Errores). */
export const ErrorResponse = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  request_id: z.string().nullable().optional(),
});

export type ErrorResponse = z.infer<typeof ErrorResponse>;
