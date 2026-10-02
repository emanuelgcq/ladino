import { err, ok, type Result } from "@ladino/core";
import type { TransactionSql } from "@ladino/db";
import { esMarcadorSinRif, filasDeDescripcion, filasDelMotivo } from "@ladino/schemas";

/**
 * LO QUE EXIGE LA FORMA LIBRE ANTES DE EMITIR (auditoría fiscal 2026-10-02 y su revisión):
 *
 *  - PA 00071 art. 33: cada factura, NC o ND sobre forma libre ocupa UNA forma. Decidido por
 *    criterio: un tope por documento, ajuste por empresa, que cuenta FILAS IMPRESAS (A-2): las
 *    filas de la descripción de cada línea y, en la NC y la ND, las del motivo, partidas con la
 *    MISMA regla que usa el PDF (`@ladino/schemas`, forma-libre.ts). Alternativa rechazada:
 *    truncar la descripción a una fila (el art. 13 exige la descripción).
 *  - PA 00071 art. 13.7 (VALIDAR-SENIAT P-57, lectura conservadora): la FACTURA lleva al
 *    adquirente identificado —nombre y RIF, cédula o pasaporte—; el «Consumidor final» de sistema
 *    es solo para recibos.
 *  - La NC y la ND (A-4/A-6, decidido por criterio; regla 1: toda factura se corrige con nota)
 *    identifican al adquirente EXACTAMENTE como lo hizo la factura que corrigen: mismo cliente y la
 *    identificación congelada del origen, aunque esa factura fuera al «Consumidor final».
 *
 * La base defiende lo mismo (`platform.assert_document_issuance`, LAD99). El registro a posteriori
 * de una factura de CONTINGENCIA no pasa por aquí: refleja un papel que ya existe (A-3).
 */
export type FormaLibreError = { code: "VALIDATION_FAILED"; message: string };

const TOPE_POR_OMISION = 15;

export const MENSAJE_SIN_IDENTIFICAR =
  "Para facturar sobre forma libre hacen falta el nombre del cliente y su RIF, cédula o " +
  "pasaporte (PA 00071 art. 13.7). Identifícalo: el «Consumidor final» es solo para recibos.";

/** Las filas impresas de las líneas: la descripción de cada producto, con «(E)» si es exento. */
export async function filasDeLineas(
  sql: TransactionSql,
  companyId: string,
  productIds: readonly string[],
): Promise<number> {
  if (productIds.length === 0) return 0;
  const productos = await sql<{ id: string; name: string; exenta: boolean }[]>`
    select id, name, tax_category_code in ('exento', 'exonerado', 'no_sujeto') as exenta
      from public.products
     where company_id = ${companyId} and id = any(${[...new Set(productIds)]}::uuid[])`;
  const porId = new Map(productos.map((p) => [p.id, p]));
  let filas = 0;
  for (const id of productIds) {
    const p = porId.get(id);
    filas += p === undefined ? 1 : filasDeDescripcion(p.name, p.exenta).length;
  }
  return filas;
}

export async function exigeFormaLibre(
  sql: TransactionSql,
  companyId: string,
  d:
    | { clase: "factura"; customerId: string; filas: number }
    | {
        clase: "nota";
        customerId: string;
        origenId: string;
        filasLineas: number;
        motivo: string | null;
      },
): Promise<Result<void, FormaLibreError>> {
  const [ajuste] = await sql<{ tope: number }[]>`
    select coalesce((select cs.rows_per_free_form from public.company_settings cs
                      where cs.company_id = ${companyId}), ${TOPE_POR_OMISION}) as tope`;
  const tope = ajuste?.tope ?? TOPE_POR_OMISION;
  const filas = d.clase === "factura" ? d.filas : d.filasLineas + filasDelMotivo(d.motivo).length;
  if (filas > tope) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        (d.clase === "factura"
          ? "No cabe en una forma libre: divide la venta en varias facturas"
          : "No cabe en una forma libre: divide la nota en varias notas") +
        ` (máximo ${tope} filas impresas; esta ocupa ${filas})`,
    });
  }

  if (d.clase === "nota") {
    const [origen] = await sql<{ customer_id: string }[]>`
      select customer_id from public.documents
       where id = ${d.origenId} and company_id = ${companyId}`;
    if (origen?.customer_id !== d.customerId) {
      return err({
        code: "VALIDATION_FAILED",
        message: "La nota va al mismo cliente de la factura que corrige.",
      });
    }
    return ok(undefined);
  }

  const [cliente] = await sql<
    { is_system: boolean; nombre: string | null; documento: string | null }[]
  >`
    select is_system, nullif(btrim(legal_name), '') as nombre,
           nullif(btrim(tax_id), '') as documento
      from public.customers where id = ${d.customerId} and company_id = ${companyId}`;
  if (
    cliente?.is_system !== false ||
    cliente.nombre === null ||
    cliente.documento === null ||
    esMarcadorSinRif(cliente.documento)
  ) {
    return err({ code: "VALIDATION_FAILED", message: MENSAJE_SIN_IDENTIFICAR });
  }
  return ok(undefined);
}
