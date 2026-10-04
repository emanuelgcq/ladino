/**
 * A-02 (regla del dueño, 2026-09-28): «Hasta que haya un rango con papel, la caja de una empresa
 * con RIF está en pausa con un mensaje y el enlace al talonario; no hay recibos para quien tiene
 * RIF».
 *
 * El SERVIDOR ya lo impone al cobrar (409 FISCAL_NUMBERING_INVALID con `details.reason`, y el
 * recibo rechazado para quien tiene datos fiscales): esto solo lo dice ANTES, con los mismos tres
 * motivos, para que nadie arme una venta que no va a poder cobrar. Puro: sin React, para probarlo.
 *
 * Lo que no se sabe (una consulta que todavía carga, o que el rol no puede leer) NO pausa: la
 * pausa se afirma solo con el dato delante, y el cobro sigue respondiendo por sí mismo.
 */
export type MotivoDePausa = "regime_missing" | "no_range" | "printer_data_incomplete";

export interface TalonarioDeCaja {
  /** `retention_receipt` numera comprobantes de retención, no facturas; null = los documentos. */
  readonly kind?: string | null;
  readonly status: string;
  readonly remaining: number;
  readonly is_contingency: boolean;
  readonly printer_data_complete: boolean;
}

export function motivoDePausa(entrada: {
  readonly conRif: boolean;
  /** `GET /v1/fiscal/setup`; undefined mientras carga o si no se pudo leer. */
  readonly setup: { readonly current_regime: string | null } | undefined;
  /** `GET /v1/fiscal-number-ranges`; undefined mientras carga o si no se pudo leer. */
  readonly talonarios: readonly TalonarioDeCaja[] | undefined;
}): MotivoDePausa | null {
  const { conRif, setup, talonarios } = entrada;
  // Sin RIF se vende con recibos: no hay talonario que esperar.
  if (!conRif || setup === undefined) return null;
  if (setup.current_regime === null) return "regime_missing";
  // Solo la forma libre numera con el talonario de la imprenta (la misma lectura que /empezar).
  if (setup.current_regime !== "formatos_libres" || talonarios === undefined) return null;
  // Lo mismo que mira el servidor al reclamar el control (`platform.claim_fiscal_control`): un
  // rango activo, con números, que NO sea el de los comprobantes de retención. El de contingencia
  // tampoco cuenta: vive en su propia serie, que la caja no usa (se registra aparte, con el papel
  // ya hecho), así que con solo ese papel el cobro de la caja también se rechaza.
  const conPapel = talonarios.filter(
    (t) =>
      t.status === "active" &&
      t.remaining > 0 &&
      !t.is_contingency &&
      t.kind !== "retention_receipt",
  );
  if (conPapel.length === 0) return "no_range";
  if (!conPapel.some((t) => t.printer_data_complete)) return "printer_data_incomplete";
  return null;
}
