import { err, ok, type Result } from "@ladino/core";
import type { TransactionSql } from "@ladino/db";
import type { CompanyTaxpayerTypeResponse } from "@ladino/schemas";

/**
 * EL TIPO DE CONTRIBUYENTE DE LA EMPRESA (ADR-0072 §1; A-03, B-07; migración 20260928190000).
 *
 * La verdad es la historia `company_taxpayer_types`, y su ÚNICA lectura es
 * `platform.taxpayer_type_at(empresa, día)`. La columna `companies.taxpayer_type_code` es un
 * espejo para la API desplegada: nada de este paquete la lee.
 *
 * Nunca «ordinario por omisión»: sin tipo vigente en la fecha del documento, una empresa con RIF
 * no factura. La empresa sin RIF es `no_contribuyente` por hecho (no está inscrita) y emite
 * recibos sin que se le pida nada.
 */
/** Los tipos que se declaran y facturan. no_contribuyente se deriva, nunca se declara. */
// «formal» queda fuera hasta construir M-10 (PA 00071 art. 15, P-38; hallazgo 8).
export const TIPOS_QUE_FACTURAN: ReadonlySet<string> = new Set(["ordinario", "especial"]);

export type TaxpayerTypeRequiredError = { code: "TAXPAYER_TYPE_REQUIRED"; message: string };

/** El tipo vigente el DÍA dado (fecha `AAAA-MM-DD` de Caracas), o null. */
export async function tipoVigente(
  sql: TransactionSql,
  companyId: string,
  dia: string,
): Promise<string | null> {
  const [fila] = await sql<{ tipo: string | null }[]>`
    select platform.taxpayer_type_at(${companyId}, ${dia}::date) as tipo`;
  return fila?.tipo ?? null;
}

/**
 * La puerta de la emisión fiscal (factura, NC y ND): tipo vigente en el DÍA DE CARACAS del
 * instante del documento. El mensaje es de persona y depende de quién lo recibe: quien puede
 * declararlo recibe el camino; quien no, a quién pedírselo.
 */
export async function exigeTipoParaFacturar(
  sql: TransactionSql,
  /** null: actor de sistema — recibe el mensaje de «pídeselo a quien administra». */
  userId: string | null,
  companyId: string,
  instante: string,
): Promise<Result<string, TaxpayerTypeRequiredError>> {
  const [fila] = await sql<{ tipo: string | null; dia: string; puede: boolean }[]>`
    select platform.taxpayer_type_at(${companyId}, platform.caracas_day(${instante}::timestamptz))
             as tipo,
           platform.caracas_day(${instante}::timestamptz)::text as dia,
           coalesce(platform.ladino_user_has_permission(${userId}::uuid,
                                                         'company.settings.manage',
                                                         ${companyId}), false) as puede`;
  // Solo un tipo DECLARABLE factura (decidido por criterio, ADR-0072 nota de aplicación):
  // no_contribuyente se deriva de no tener RIF y no emite factura, NC ni ND.
  if (fila?.tipo != null && TIPOS_QUE_FACTURAN.has(fila.tipo)) return ok(fila.tipo);
  const fecha = fila?.dia ?? "";
  return err({
    code: "TAXPAYER_TYPE_REQUIRED",
    message:
      fila?.puede === true
        ? `Para facturar falta declarar el tipo de contribuyente del negocio vigente al ${fecha}. ` +
          "Decláralo en Configuración → Mi empresa → Tipo de contribuyente (o en Empezar) y vuelve a intentar."
        : `Para facturar falta declarar el tipo de contribuyente del negocio vigente al ${fecha}. ` +
          "Pídeselo a quien administra el negocio.",
  });
}

/**
 * Cuántos documentos FISCALES (factura, NC, ND) se emitieron desde el día dado, en día de
 * Caracas. Lo usa el aviso de una declaración retroactiva (ADR-0072, nota de aplicación).
 */
export async function emitidosDesde(
  sql: TransactionSql,
  companyId: string,
  dia: string,
): Promise<number> {
  const [fila] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.documents
     where company_id = ${companyId}
       -- ADR-0082: la factura de retiro y su nota congelan el tipo de contribuyente como las demás.
       and kind in ('invoice', 'withdrawal_invoice', 'credit_note', 'withdrawal_credit_note',
                    'debit_note')
       and issued_at is not null and status <> 'draft'
       and platform.caracas_day(issued_at) >= ${dia}::date`;
  return fila?.n ?? 0;
}

/**
 * El tipo vigente hoy y la historia entera, para la pantalla. Con `desde`, además, cuántos
 * documentos fiscales se emitieron desde esa fecha: la web lo enseña ANTES de confirmar una
 * declaración retroactiva.
 */
export async function readCompanyTaxpayerType(
  sql: TransactionSql,
  companyId: string,
  desde?: string,
): Promise<CompanyTaxpayerTypeResponse> {
  const [hoy] = await sql<{ dia: string }[]>`select platform.caracas_day(now())::text as dia`;
  const dia = hoy!.dia;
  const historia = await sql<CompanyTaxpayerTypeResponse["history"]>`
    select id, taxpayer_type_code, effective_from::text as effective_from,
           notified_on::text as notified_on, reason,
           to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
      from public.company_taxpayer_types
     where company_id = ${companyId}
     order by effective_from desc, created_at desc, id desc`;
  const tipo = await tipoVigente(sql, companyId, dia);
  const vigente = historia.find((h) => h.effective_from <= dia) ?? null;
  return {
    today: dia,
    current:
      tipo === null
        ? null
        : {
            taxpayer_type_code: tipo as NonNullable<
              CompanyTaxpayerTypeResponse["current"]
            >["taxpayer_type_code"],
            effective_from: vigente?.effective_from ?? null,
            notified_on: vigente?.notified_on ?? null,
          },
    history: [...historia],
    documents_issued_since: desde === undefined ? null : await emitidosDesde(sql, companyId, desde),
  };
}
