import { z } from "zod";

/**
 * Contratos del maestro de clientes (migración 18, ADR-0033). El RIF es texto
 * SIN formato (VALIDAR-SENIAT, OPEN_QUESTIONS 9): la forma solo acota
 * longitud y trim. Nullable únicamente para persona natural (lo exige el
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
    person_type_code: z.string().regex(CODE_RE),
    taxpayer_type_code: z.string().regex(CODE_RE),
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
    created_at: z.string().datetime({ offset: true }),
    /**
     * Extras del listado de Fase C: `is_system` marca al Consumidor final
     * (congelado, la contraparte del mostrador) y `debt` — presente solo con
     * `with_debt=1` — es lo que ese cliente debe, sumado por el esquema.
     */
    is_system: z.boolean().optional(),
    debt: z.string().optional(),
  })
  .strict();
export type CustomerResponse = z.infer<typeof CustomerResponse>;

export const ListCustomersResponse = z
  .object({ items: z.array(CustomerResponse), total: z.number().int().nonnegative() })
  .strict();
export type ListCustomersResponse = z.infer<typeof ListCustomersResponse>;
