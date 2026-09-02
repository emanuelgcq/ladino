import { z } from "zod";

/**
 * EL RESUMEN DEL NEGOCIO (Fase C) — los números de Inicio y de Mi dinero,
 * calculados TODOS en el servidor. La pantalla no suma ni un céntimo: recibe
 * cifras como string y las viste (regla de apps/web).
 */
const uuid = z.string().uuid();
const cifra = z.string();

export const NegocioResumenResponse = z
  .object({
    functional_currency: z.string(),
    /** Vendido (facturas emitidas/pagadas), en moneda funcional. */
    vendido_hoy: cifra,
    vendido_mes: cifra,
    /** Margen: base vendida menos costo congelado de las líneas que lo tienen. */
    ganado_hoy: cifra,
    ganado_mes: cifra,
    /** Líneas vendidas EN EL MES sin costo congelado: el aviso de «sin costo». */
    lineas_sin_costo_mes: z.number().int(),
    /** Suma de saldos pendientes de facturas emitidas (solo positivos). */
    lo_que_me_deben: cifra,
    /** Suma de saldos pendientes de facturas de proveedor asentadas. */
    lo_que_debo: cifra,
    /** El dinero por MONEDA: la suma de los saldos de las cuentas activas. */
    mi_dinero: z.array(z.object({ currency: z.string(), balance: cifra }).strict()),
    /** Productos bajo su mínimo. */
    por_agotarse: z.number().int(),
    /** La última tasa USD→VES, con su fuente, o null si nunca se cargó. */
    tasa_del_dia: z
      .object({
        rate: cifra,
        rate_date: z.string(),
        source: z.string(),
        /** true si la fecha de la tasa es HOY (día de Venezuela). */
        es_de_hoy: z.boolean(),
      })
      .strict()
      .nullable(),
    /** Las últimas ventas, para la lista de Inicio. */
    ultimas_ventas: z.array(
      z
        .object({
          id: uuid,
          issued_at: z.string().nullable(),
          customer_name: z.string(),
          total_functional: cifra,
          status: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type NegocioResumenResponse = z.infer<typeof NegocioResumenResponse>;

/** Conversión del SERVIDOR: `converted = amount × tasa vigente`, en SQL. */
export const ConvertResponse = z
  .object({
    amount: cifra,
    from_currency: z.string(),
    to_currency: z.string(),
    rate: cifra,
    rate_source: z.string(),
    converted: cifra,
  })
  .strict();
export type ConvertResponse = z.infer<typeof ConvertResponse>;

/** Los tres interruptores del negocio y su depósito por defecto (migración 28). */
export const CompanySettingsResponse = z
  .object({
    sells_wholesale: z.boolean(),
    block_sale_without_stock: z.boolean(),
    /** Si es false, el mostrador exige cédula o RIF: quickSale rechaza al «Consumidor final». */
    allow_unidentified_sales: z.boolean(),
    default_tax_category_code: z.string(),
    default_warehouse_id: uuid.nullable(),
  })
  .strict();
export type CompanySettingsResponse = z.infer<typeof CompanySettingsResponse>;

export const UpdateCompanySettingsRequest = z
  .object({
    sells_wholesale: z.boolean().optional(),
    block_sale_without_stock: z.boolean().optional(),
    allow_unidentified_sales: z.boolean().optional(),
    default_tax_category_code: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/)
      .optional(),
    default_warehouse_id: uuid.nullable().optional(),
  })
  .strict();
export type UpdateCompanySettingsRequest = z.infer<typeof UpdateCompanySettingsRequest>;
