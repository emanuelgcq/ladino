import type { TransactionSql } from "@ladino/db";

/**
 * LA FECHA CONTABLE de un hecho con fecha propia (ADR-0069 §4, K-04): la suya si su período
 * admite asientos; si cae en un período CERRADO o antes del inicio de actividades, HOY en
 * Caracas (el período en curso). El documento conserva su fecha original en su propia columna.
 * La regla vive en `platform.accounting_date_for`, en un solo sitio; esto solo la llama.
 * `fecha` es un día ISO (YYYY-MM-DD): se compara `date` contra `date`.
 */
export async function fechaContableDe(
  sql: TransactionSql,
  companyId: string,
  fecha: string,
): Promise<string> {
  const [f] = await sql<{ d: string }[]>`
    select platform.accounting_date_for(${companyId}, ${fecha}::date)::text as d`;
  return f!.d;
}
