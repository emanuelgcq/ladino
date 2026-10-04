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
/**
 * LOS LIBROS FISCALES SON DE QUIEN TIENE RIF (AF3-13, auditoría fiscal de la ola 3; regla MODO
 * del dueño en D-01: la empresa sin RIF no deja rastro en libros ni declaraciones).
 *
 * Una empresa sin RIF puede guardar la factura de su proveedor como soporte de costo
 * (`fiscal_support = true`, IVA al costo), y `platform.purchases_book` no mira el modo: sin
 * esta puerta, el libro de compras se le podía leer y generar con ese renglón. Se cierra en la
 * LECTURA y en la GENERACIÓN, que es donde manda la regla.
 *
 * Mira el RIF y no el modo de venta, decidido por criterio: el sujeto de la regla es «sin RIF»,
 * y una empresa con RIF que todavía no activó la facturación sí lleva libro de compras. La
 * alternativa era `exigeEmpresaQueFactura`, que dejaría sin libros a esa empresa en transición.
 */
export async function exigeEmpresaConRif(
  sql: TransactionSql,
  companyId: string,
): Promise<Result<void, { code: "REGIME_KIND_NOT_ALLOWED"; message: string }>> {
  const [empresa] = await sql<{ sin_rif: boolean }[]>`
    select upper(btrim(tax_id)) like 'PEND-%' as sin_rif from public.companies
     where id = ${companyId}`;
  if (empresa?.sin_rif !== true) return ok(undefined);
  return err({
    code: "REGIME_KIND_NOT_ALLOWED",
    message:
      "Los libros de compras y ventas son de quien tiene RIF, y este negocio no tiene RIF: sus compras y ventas no van a libros ni a declaraciones. Cuando tengas tu RIF, regístralo en Mi empresa.",
  });
}

/**
 * M-09 (respuesta del dueño, 2026-09-28): la caja de un negocio que PASÓ de recibos a facturas
 * dice «Ya facturas con tu RIF» durante 30 días y hasta su primera factura, lo que tarde más.
 *
 * Lo decide el servidor, con días de Caracas en los dos lados de la resta (dos `date`, nunca un
 * instante contra una medianoche). «Impresa» se lee como EMITIDA, decidido por criterio: Ladino
 * no guarda cuándo se imprime un documento; la alternativa era registrar cada `?destino=papel`.
 * Un negocio que nació con RIF nunca tuvo la banda de recibos: no recibe esta.
 */
export async function avisoYaFactura(sql: TransactionSql, companyId: string): Promise<boolean> {
  const [fila] = await sql<{ aviso: boolean }[]>`
    select exists (
      select 1
        from public.company_fiscal_regimes r
        join public.fiscal_regimes fr on fr.code = r.regime_code
       where r.company_id = ${companyId}
         and 'invoice' = any (fr.allowed_kinds)
         and r.effective_from <= now()
         and (r.effective_to is null or r.effective_to > now())
         and exists (select 1
                       from public.company_fiscal_regimes a
                       join public.fiscal_regimes fa on fa.code = a.regime_code
                      where a.company_id = r.company_id
                        and 'receipt' = any (fa.allowed_kinds)
                        and a.effective_from < r.effective_from)
         and (platform.caracas_day(now()) - platform.caracas_day(r.effective_from) < 30
              or not exists (select 1 from public.documents d
                              where d.company_id = r.company_id and d.kind = 'invoice'
                                and d.status in ('issued', 'paid')
                                and d.issued_at >= r.effective_from))
    ) as aviso`;
  return fila?.aviso === true;
}

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
