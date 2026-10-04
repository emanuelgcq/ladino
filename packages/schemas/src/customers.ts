import { z } from "zod";

/**
 * Contratos del maestro de clientes (migración 18, ADR-0033). En el contrato,
 * el documento solo acota longitud y trim; desde A-08 (2026-09-28) el caso de
 * uso exige RIF o cédula y lo guarda normalizado (./rif.ts, leerDocumentoCliente). Nullable únicamente para persona natural (lo exige el
 * esquema; el caso de uso lo dice antes con un mensaje).
 */
const uuid = z.string().uuid();
const CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;
const taxId = z.string().trim().min(1).max(30);
const texto = (max: number) => z.string().trim().min(1).max(max);

export const CustomerStatus = z.enum(["lead", "active", "blocked", "inactive"]);

export const CreateCustomerRequest = z
  .object({
    company_id: uuid,
    tax_id: taxId.nullable().optional(),
    legal_name: texto(200),
    trade_name: texto(200).optional(),
    /**
     * Opcionales desde la auditoría 2026-09-11 (M-06): si faltan, el dominio
     * los infiere del prefijo del RIF (J/G → jurídica/gobierno ordinario,
     * P → extranjera no domiciliada, V/E o sin RIF → natural consumidor final).
     * Antes la web los decidía en tres pantallas distintas — lógica tributaria
     * en componentes, prohibida por CLAUDE.md §2.
     */
    person_type_code: z.string().regex(CODE_RE).optional(),
    taxpayer_type_code: z.string().regex(CODE_RE).optional(),
    fiscal_address: texto(500).optional(),
    email: z.string().trim().email().max(254).optional(),
    phone: texto(40).optional(),
    status: z.enum(["lead", "active"]).optional(),
    default_price_list_id: uuid.optional(),
  })
  .strict();
export type CreateCustomerRequest = z.infer<typeof CreateCustomerRequest>;

export const UpdateCustomerRequest = z
  .object({
    company_id: uuid,
    // El RIF NO se actualiza aquí (endpoint y permiso propios, M4) ni `blocked`
    // (customer.block). Las clasificaciones fiscales tampoco: se mantienen
    // fuera de la edición rutinaria hasta que exista su caso de uso con permiso.
    legal_name: texto(200).optional(),
    trade_name: texto(200).nullable().optional(),
    fiscal_address: texto(500).nullable().optional(),
    email: z.string().trim().email().max(254).nullable().optional(),
    phone: texto(40).nullable().optional(),
    status: z.enum(["lead", "active", "inactive"]).optional(),
    default_price_list_id: uuid.nullable().optional(),
  })
  .strict();
export type UpdateCustomerRequest = z.infer<typeof UpdateCustomerRequest>;

export const SetCustomerTaxIdRequest = z
  .object({ company_id: uuid, tax_id: taxId.nullable() })
  .strict();
export type SetCustomerTaxIdRequest = z.infer<typeof SetCustomerTaxIdRequest>;

export const SetCustomerBlockedRequest = z
  .object({ company_id: uuid, blocked: z.boolean(), reason: texto(500).optional() })
  .strict();
export type SetCustomerBlockedRequest = z.infer<typeof SetCustomerBlockedRequest>;

/**
 * E-09: el límite de fiado, en USD (el fiado se ancla en USD). Importe como string, hasta el
 * céntimo. Permiso propio (`customers.credit.set`); el alta no lo acepta: un cliente nace en 0.
 */
export const SetCustomerCreditLimitRequest = z
  .object({
    company_id: uuid,
    credit_limit_usd: z
      .string()
      .regex(/^\d{1,12}(\.\d{1,2})?$/, "Importe en USD, hasta el céntimo"),
  })
  .strict();
export type SetCustomerCreditLimitRequest = z.infer<typeof SetCustomerCreditLimitRequest>;

/** E-14: la clasificación fiscal del cliente se cambia aparte, con `customer.tax_id.manage`. */
export const SetCustomerTaxpayerTypeRequest = z
  .object({ company_id: uuid, taxpayer_type_code: z.string().regex(CODE_RE) })
  .strict();
export type SetCustomerTaxpayerTypeRequest = z.infer<typeof SetCustomerTaxpayerTypeRequest>;

export const CustomerResponse = z
  .object({
    id: uuid,
    tenant_id: uuid,
    company_id: uuid,
    tax_id: z.string().nullable(),
    legal_name: z.string(),
    trade_name: z.string().nullable(),
    person_type_code: z.string(),
    taxpayer_type_code: z.string(),
    fiscal_address: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    status: CustomerStatus,
    default_price_list_id: uuid.nullable(),
    /** E-09: límite de fiado en USD. "0.00000000" = no se le fía. */
    credit_limit_usd: z.string(),
    created_at: z.string().datetime({ offset: true }),
    /**
     * Extras del listado de Fase C: `is_system` marca al Consumidor final
     * (congelado, la contraparte del mostrador) y `debt` — presente solo con
     * `with_debt=1` — es lo que ese cliente debe, sumado por el esquema.
     */
    is_system: z.boolean().optional(),
    /** null = debe algo en divisa y falta la tasa de hoy para decirlo en la moneda de la empresa. */
    debt: z.string().nullable().optional(),
    /**
     * P-05 (solo con `with_debt=1`): lo VENCIDO de esa deuda, en la moneda de la empresa a la
     * tasa de hoy. «0.00» = nada vencido. null = hay vencido y no se puede valorar hoy; el motivo
     * va en `overdue_reason` (`sin_tasa`). Nunca 0 por «no se sabe».
     */
    overdue: z.string().nullable().optional(),
    overdue_reason: z.enum(["sin_tasa"]).nullable().optional(),
  })
  .strict();
export type CustomerResponse = z.infer<typeof CustomerResponse>;

export const ListCustomersResponse = z
  .object({ items: z.array(CustomerResponse), total: z.number().int().nonnegative() })
  .strict();
export type ListCustomersResponse = z.infer<typeof ListCustomersResponse>;
