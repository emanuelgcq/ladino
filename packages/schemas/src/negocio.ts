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
