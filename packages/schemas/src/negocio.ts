import { z } from "zod";

/**
 * EL RESUMEN DEL NEGOCIO (Fase C) — los números de Inicio y de Mi dinero,
 * calculados TODOS en el servidor. La pantalla no suma ni un céntimo: recibe
 * cifras como string y las viste (regla de apps/web).
 */
const uuid = z.string().uuid();
const cifra = z.string();

/**
 * La tasa del día, tal como la enseñan Inicio y Mi dinero. Vive aparte porque la sirven DOS
 * lecturas: el resumen (treasury.read) y `GET /v1/negocio/tasa`, que la da a quien trabaja en la
 * empresa sin ver el dinero (N-05).
 */
export const TasaDelDia = z
  .object({
    rate: cifra,
    rate_date: z.string(),
    source: z.string(),
    /** true si la fecha de la tasa es HOY (día de Venezuela). */
    es_de_hoy: z.boolean(),
    /**
     * Días desde la fecha de la tasa hasta hoy (día de Venezuela). El
     * cálculo usa la última tasa disponible SIN límite de antigüedad; esto
     * es lo que la pantalla enseña para que nadie venda con una tasa vieja
     * sin saberlo (B12: visible, sin regla dura todavía).
     */
    dias_de_antiguedad: z.number().int(),
  })
  .strict();
export type TasaDelDia = z.infer<typeof TasaDelDia>;

/** `GET /v1/negocio/tasa`: la tasa del día para cualquier miembro de la empresa (N-05). */
export const NegocioTasaResponse = z.object({ tasa_del_dia: TasaDelDia.nullable() }).strict();
export type NegocioTasaResponse = z.infer<typeof NegocioTasaResponse>;

/**
 * Por qué un total de deuda viaja en `null` (ola 4, la familia de N-05: «no hay» no es «no puedes
 * ver» ni «no se puede calcular»):
 *   · `sin_permiso` — quien pregunta no tiene `ar.read` / `ap.read`: la cifra ni se calcula;
 *   · `sin_tasa`    — hay deuda en divisa (o un cobro viejo en otra moneda) y falta la tasa para
 *                     valorarla hoy: el nominal por moneda, que sí se conoce, va aparte.
 */
export const MotivoSinTotal = z.enum(["sin_permiso", "sin_tasa"]);
export type MotivoSinTotal = z.infer<typeof MotivoSinTotal>;
const nominalPorMoneda = z.array(z.object({ currency: z.string(), nominal: cifra }).strict());

export const NegocioResumenResponse = z
  .object({
    functional_currency: z.string(),
    /**
     * Vendido: facturas + recibos + notas de débito − notas de crédito,
     * emitidas o pagadas (nunca anuladas), en moneda funcional.
     */
    vendido_hoy: cifra,
    vendido_mes: cifra,
    /**
     * Lo que gané. Con contabilidad: el RESULTADO del mayor en la ventana (ingresos − gastos,
     * lo mismo que el estado de resultados). Sin ella: el margen de lo vendido menos los
     * gastos registrados.
     */
    ganado_hoy: cifra,
    ganado_mes: cifra,
    /** true = «lo que gané» sale del mayor (y cuadra con el estado de resultados). */
    ganado_desde_contabilidad: z.boolean(),
    /** Hechos de la empresa todavía en la cola contable: el resultado puede estar incompleto. */
    pendientes_de_contabilizar: z.number().int(),
    /** Líneas vendidas EN EL MES sin costo congelado: el aviso de «sin costo». */
    lineas_sin_costo_mes: z.number().int(),
    /**
     * Suma de saldos pendientes de facturas emitidas (solo positivos). `null` = quien pregunta no
     * tiene `ar.read` («no tienes acceso», nunca «0.00»: N-07/P-04) O falta la tasa para valorar
     * hoy lo que está en divisa. Cuál de los dos lo dice `lo_que_me_deben_motivo`.
     */
    lo_que_me_deben: cifra.nullable(),
    /** El motivo del `null` de arriba; `null` cuando hay cifra. */
    lo_que_me_deben_motivo: MotivoSinTotal.nullable(),
    /** Solo con `sin_tasa`: lo que se debe en cada moneda, sin convertir. Si no, vacía. */
    lo_que_me_deben_por_moneda: nominalPorMoneda,
    /**
     * Suma de saldos pendientes de facturas de proveedor asentadas. `null` = sin `ap.read` o sin
     * tasa para valorar hoy una factura en divisa; el motivo y el nominal, como arriba.
     */
    lo_que_debo: cifra.nullable(),
    lo_que_debo_motivo: MotivoSinTotal.nullable(),
    lo_que_debo_por_moneda: nominalPorMoneda,
    /** El dinero por MONEDA: la suma de los saldos de las cuentas activas. */
    mi_dinero: z.array(z.object({ currency: z.string(), balance: cifra }).strict()),
    /** Productos bajo su mínimo. */
    por_agotarse: z.number().int(),
    /** La última tasa USD→VES, con su fuente, o null si nunca se cargó. */
    tasa_del_dia: TasaDelDia.nullable(),
    /** Las últimas ventas (facturas y recibos), para la lista de Inicio. */
    ultimas_ventas: z.array(
      z
        .object({
          id: uuid,
          issued_at: z.string().nullable(),
          customer_name: z.string(),
          total_functional: cifra,
          status: z.string(),
          /** invoice | receipt | credit_note | receipt_return: las devoluciones también. */
          kind: z.string(),
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

/**
 * Los interruptores del negocio y su depósito por defecto (migración 28). E-13 (2026-10-04):
 * `block_sale_without_stock` se RETIRÓ del contrato — nadie lo leía y la caja nunca vende sin
 * existencia (RESPUESTA §2.13). La columna sigue en la tabla; no se lee ni se ofrece.
 */
export const CompanySettingsResponse = z
  .object({
    sells_wholesale: z.boolean(),
    /** Si es false, el mostrador exige cédula o RIF: quickSale rechaza al «Consumidor final». */
    allow_unidentified_sales: z.boolean(),
    default_tax_category_code: z.string(),
    default_warehouse_id: uuid.nullable(),
    /** La lista que la caja aplica sin preferida del cliente (migración 36). NULL = heurística. */
    default_price_list_id: uuid.nullable(),
    /** ADR-0071 §4: el control (00-00001234) también en el CUERPO del documento. Por omisión, sí. */
    print_control_number: z.boolean(),
    /** PA 00071 art. 33: tope de FILAS IMPRESAS de una factura, NC o ND sobre forma libre (A-2). */
    rows_per_free_form: z.number().int(),
    /** F-05 (RESPUESTA §2.6): la empresa asume el IGTF como gasto; el cliente paga el documento justo. */
    absorb_igtf: z.boolean(),
  })
  .strict();
export type CompanySettingsResponse = z.infer<typeof CompanySettingsResponse>;

export const UpdateCompanySettingsRequest = z
  .object({
    sells_wholesale: z.boolean().optional(),
    allow_unidentified_sales: z.boolean().optional(),
    print_control_number: z.boolean().optional(),
    rows_per_free_form: z.number().int().min(1).max(18).optional(),
    absorb_igtf: z.boolean().optional(),
    default_price_list_id: uuid.nullable().optional(),
    default_tax_category_code: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/)
      .optional(),
    default_warehouse_id: uuid.nullable().optional(),
  })
  .strict();
export type UpdateCompanySettingsRequest = z.infer<typeof UpdateCompanySettingsRequest>;
