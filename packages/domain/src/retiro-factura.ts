import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork } from "@ladino/db";
import type {
  InventoryMoveResponse,
  IssueStockRequest,
  StockExitPreviewResponse,
} from "@ladino/schemas";
import { RETIRO_REASONS, USO_NO_GRAVADO_REASONS, serieYNumero } from "@ladino/schemas";
import { issueStock, type InventoryError } from "./inventory.js";
import { emitirFacturaDeRetiro, type SalesError } from "./sales.js";

/**
 * LA SALIDA DE INVENTARIO CON SU CONSECUENCIA FISCAL (ADR-0082; RLIVA art. 31).
 *
 * Es la puerta de `POST /v1/inventory/issues`: la salida con motivo de `issueStock`, con el emisor
 * de la FACTURA DE RETIRO inyectado. Vive aparte porque inventario no importa ventas (ventas ya
 * importa inventario, y el gate de fronteras prohíbe el ciclo): este módulo conoce a los dos.
 *
 * Qué emite cada motivo, en una empresa que factura:
 *   · consumo propio, regalo, donación, muestra → factura de retiro (control del talonario, libro
 *     de ventas, declaración) y su asiento: gasto por retiro + débito fiscal contra inventario;
 *   · uso en el negocio → nada: gasto de operación contra inventario;
 *   · activo fijo, incorporado a un inmueble → nada: activo fijo contra inventario;
 *   · merma, rotura, vencido, faltante (con evidencia) → nada: pérdida justificada.
 * Sin RIF, ningún motivo emite documento.
 */
export async function issueStockWithExit(
  uow: UnitOfWork,
  input: IssueStockRequest,
): Promise<Result<InventoryMoveResponse, InventoryError | SalesError>> {
  // El error de la emisión viaja por fuera: `issueStock` solo sabe de errores de inventario, y el
  // de la factura (talonario agotado, falta el tipo de contribuyente, falta la tasa) tiene su
  // propio código y su mensaje de persona, que la API debe devolver tal cual.
  const fallo: { deLaFactura: SalesError | null } = { deLaFactura: null };
  const salida = await issueStock(uow, {
    ...input,
    facturarRetiro: async (a) => {
      const r = await emitirFacturaDeRetiro(uow, a);
      if (!r.ok) {
        fallo.deLaFactura = r.error;
        return err({ code: "VALIDATION_FAILED", message: r.error.message });
      }
      const d = r.value;
      return ok({
        id: d.id,
        series: d.series,
        number: serieYNumero(d.series, d.document_number ?? ""),
        control_number:
          d.control_number === null
            ? null
            : `${d.control_identifier ?? "00"}-${String(d.control_number).padStart(8, "0")}`,
        subtotal_amount: d.subtotal_amount,
        tax_amount: d.tax_amount,
        total_amount: d.total_amount,
        currency: d.functional_currency,
      });
    },
  });
  if (!salida.ok && fallo.deLaFactura !== null) return err(fallo.deLaFactura);
  return salida;
}

/**
 * LA VISTA PREVIA DE UNA SALIDA (ADR-0082): qué va a emitir, con sus cifras, antes de confirmar.
 *
 * No hay una segunda regla que pueda divergir de la primera: se ENSAYA la salida entera —la misma
 * `issueStockWithExit`— dentro de un savepoint y se deshace siempre (el patrón de
 * `previewInvoicedExpense`). Lo que la pantalla anuncia es lo que la emisión habría guardado. No
 * mueve el kardex ni gasta correlativo ni número de control: el `rollback` del savepoint los
 * devuelve. El NÚMERO no se anuncia (se asigna al emitir, y otro puede emitir entre medias): solo
 * la serie. Un rechazo (sin precio, sin existencia, sin papel, sin evidencia) sale aquí igual que
 * saldría al confirmar, con su mensaje.
 */
export async function previewStockExit(
  uow: UnitOfWork,
  input: IssueStockRequest,
): Promise<Result<StockExitPreviewResponse, InventoryError | SalesError>> {
  const DESHACER = new Error("vista previa: se deshace siempre");
  const caja: { vista: Result<StockExitPreviewResponse, InventoryError | SalesError> | null } = {
    vista: null,
  };
  try {
    await uow.sql.savepoint(async (sp) => {
      const r = await issueStockWithExit({ ...uow, sql: sp }, input);
      if (!r.ok) {
        caja.vista = r;
      } else {
        const f = r.value.withdrawal_invoice ?? null;
        caja.vista = ok(
          f !== null
            ? {
                emits: "withdrawal_invoice" as const,
                why: "retiro" as const,
                series: f.series,
                subtotal_amount: f.subtotal_amount,
                tax_amount: f.tax_amount,
                total_amount: f.total_amount,
                currency: f.currency,
              }
            : {
                emits: "nothing" as const,
                why: RETIRO_REASONS.includes(input.reason)
                  ? ("sin_rif" as const)
                  : USO_NO_GRAVADO_REASONS.includes(input.reason)
                    ? ("no_gravado" as const)
                    : ("perdida" as const),
                series: null,
                subtotal_amount: null,
                tax_amount: null,
                total_amount: null,
                currency: null,
              },
        );
      }
      throw DESHACER;
    });
  } catch (e) {
    if (e !== DESHACER) throw e;
  }
  if (caja.vista === null) throw new Error("vista previa de la salida: sin resultado");
  return caja.vista;
}
