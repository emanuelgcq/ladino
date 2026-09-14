import { err, ok, type Result } from "@ladino/core";
import type { TransactionSql } from "@ladino/db";
import type { SalesMode } from "@ladino/schemas";

/**
 * EL MODO DE VENTA de una empresa a una fecha (migración 54). No se deduce aquí:
 * lo contesta `platform.sales_mode_at`, que replica la lógica del trigger de
 * emisión y que el pgTAP 054 compara contra el trigger régimen por régimen.
 * Dominio, API y web leen esta misma respuesta.
 */
export async function modoDeVenta(
  sql: TransactionSql,
  companyId: string,
  fecha: string,
): Promise<SalesMode> {
  const [fila] = await sql<{ modo: SalesMode }[]>`
    select platform.sales_mode_at(${companyId}, ${fecha}) as modo`;
  return fila?.modo ?? "ninguno";
}

/**
 * LA CAPA FISCAL EXIGE UNA EMPRESA QUE FACTURA (plan «Ladino sin RIF», A7).
 * El IGTF, marcarse contribuyente especial y cargar talonarios de la imprenta
 * son de quien emite documentos fiscales. Hasta hoy una empresa sin RIF podía
 * hacer las tres cosas, y un recibo llegaba a percibir IGTF.
 *
 * El mensaje da la SALIDA, no un muro: una empresa en transición legítima
 * activa primero su facturación. VALIDAR con el asesor que ningún caso real
 * necesite estas piezas antes de facturar (PENDIENTES_ASESOR).
 */
export async function exigeEmpresaQueFactura(
  sql: TransactionSql,
  companyId: string,
  queHace: string,
): Promise<Result<void, { code: "REGIME_KIND_NOT_ALLOWED"; message: string }>> {
  const modo = await modoDeVenta(sql, companyId, new Date().toISOString());
  if (modo === "facturas") return ok(undefined);
  return err({
    code: "REGIME_KIND_NOT_ALLOWED",
    message:
      modo === "recibos"
        ? `${queHace} es de quien factura, y este negocio vende con recibos. Cuando tengas tu RIF, activa la facturación en Empezar y después vuelve aquí.`
        : `${queHace} es de quien factura, y esta empresa todavía no tiene cómo vende. Complétalo en Empezar.`,
  });
}
