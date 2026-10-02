import { err, ok, type Result } from "@ladino/core";
import type { TransactionSql } from "@ladino/db";
import { esMarcadorSinRif, leerDocumentoCliente, leerRif, type DigitoRif } from "@ladino/schemas";

/**
 * El documento de identidad en el SERVIDOR: aquí se decide (la web solo avisa). Usa la función
 * compartida de @ladino/schemas (rif.ts), la misma con que la web viste y avisa.
 *
 * Regla del dueño (2026-09-28, A-08): la estructura BLOQUEA (422 legible); el dígito
 * verificador del módulo 11 AVISA — se acepta, y la excepción queda en `audit_events`
 * (`<agregado>.tax_id_check_digit_mismatch`, con el dígito esperado y el recibido).
 */

export const MENSAJE_RIF_INVALIDO =
  "El RIF no tiene la forma correcta: una letra (V, E, J, G, P o C) y nueve dígitos, con o " +
  "sin guiones. Por ejemplo, J-12345678-9.";

export const MENSAJE_DOCUMENTO_CLIENTE_INVALIDO =
  "El documento no tiene la forma correcta: un RIF (V, E, J, G, P o C y nueve dígitos, por " +
  "ejemplo J-12345678-9), una cédula (V o E y hasta ocho dígitos, por ejemplo V-12345678) o " +
  "un pasaporte (P y su número, por ejemplo P-AB1234567).";

export const MENSAJE_RIF_MARCADOR =
  "«PEND-…» es la marca de una empresa que todavía no tiene RIF, no un RIF. Escribe el RIF " +
  "del certificado del SENIAT, por ejemplo J-12345678-9.";

export interface DocumentoLeido {
  /** Lo que se guarda: `J408887776`, `V18222333`. */
  readonly normalizado: string;
  readonly tipo: "rif" | "cedula" | "pasaporte";
  /** Solo RIF: cuadra, no cuadra, o sin regla (letra C). */
  readonly digito: DigitoRif | null;
  readonly esperado: number | null;
}

type Invalido = { code: "VALIDATION_FAILED"; message: string };

/** El RIF de una empresa o de un proveedor: solo RIF, nunca el marcador ni una cédula. */
export function validarRif(crudo: string): Result<DocumentoLeido, Invalido> {
  if (esMarcadorSinRif(crudo))
    return err({ code: "VALIDATION_FAILED", message: MENSAJE_RIF_MARCADOR });
  const r = leerRif(crudo);
  if (!r.valido || r.tipo !== "rif") {
    return err({ code: "VALIDATION_FAILED", message: MENSAJE_RIF_INVALIDO });
  }
  return ok({ normalizado: r.normalizado, tipo: "rif", digito: r.digito, esperado: r.esperado });
}

/** El documento de un cliente: un RIF, una cédula o un pasaporte (PA 00071 art. 13.7). */
export function validarDocumentoCliente(crudo: string): Result<DocumentoLeido, Invalido> {
  const r = leerDocumentoCliente(crudo);
  if (!r.valido) {
    return err({ code: "VALIDATION_FAILED", message: MENSAJE_DOCUMENTO_CLIENTE_INVALIDO });
  }
  return r.tipo === "rif"
    ? ok({ normalizado: r.normalizado, tipo: "rif", digito: r.digito, esperado: r.esperado })
    : ok({ normalizado: r.normalizado, tipo: r.tipo, digito: null, esperado: null });
}

/**
 * Deja constancia de que se aceptó un RIF cuyo dígito verificador no cuadra: la excepción que
 * la regla del dueño manda registrar. No hace nada si el dígito cuadra, no hay regla (C) o el
 * documento es una cédula. Va en la misma transacción que el alta o el cambio.
 */
export async function registrarDigitoDudoso(
  sql: TransactionSql,
  d: {
    readonly tenantId: string;
    readonly companyId: string;
    readonly aggregateType: "company" | "customer" | "supplier";
    readonly aggregateId: string;
    readonly documento: DocumentoLeido;
    readonly rulesVersion: string;
  },
): Promise<void> {
  if (d.documento.digito !== "incorrecto") return;
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${d.tenantId}, ${d.companyId}, ${d.aggregateType}, ${d.aggregateId},
            ${`${d.aggregateType}.tax_id_check_digit_mismatch`}, 'user', now(), ${d.rulesVersion},
            ${sql.json({
              tax_id: d.documento.normalizado,
              check_digit_ok: false,
              digito_recibido: Number(d.documento.normalizado[9]),
              digito_esperado: d.documento.esperado,
              regla: "modulo11-seniat",
            })})`;
}
