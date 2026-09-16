import { LlamadaApiError, errorDePersona } from "../lib.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

/**
 * EL SALDO QUE NO ALCANZA (ADR-0062 §4). El servidor rechaza con 409
 * `INSUFFICIENT_FUNDS` todo egreso que dejaría la cuenta en negativo, y dice
 * cuánto hay. La pantalla no decide si se puede: pregunta, y si el dueño
 * confirma, reenvía la MISMA operación con `allow_negative_balance: true`.
 *
 * Existe porque el QA de pantalla del 2026-09-15 encontró tres cajas en
 * negativo (un gasto, un pago a proveedor y un reembolso) sin que nadie se
 * enterara: «Caja del local» quedó en −4.716,36 y la pantalla no dijo nada.
 */

/** El mensaje del servidor si el rechazo fue por falta de saldo; si no, `null`. */
export function esSinSaldo(e: unknown): string | null {
  if (e instanceof LlamadaApiError && e.body.code === "INSUFFICIENT_FUNDS") {
    return errorDePersona(e);
  }
  return null;
}

export function ConfirmarSobregiro({
  mensaje,
  onCancelar,
  onConfirmar,
}: {
  /** Lo que respondió el servidor: cuánto hay y cuánto se pedía. */
  mensaje: string;
  onCancelar: () => void;
  /** Reenvía la operación con la confirmación. Si vuelve a fallar, el error se pinta aquí. */
  onConfirmar: () => Promise<void>;
}): React.JSX.Element {
  return (
    <ConfirmDialog
      open
      onOpenChange={(v) => {
        if (!v) onCancelar();
      }}
      title="No alcanza el saldo"
      confirmLabel="Registrarlo igual"
      destructive
      onConfirm={onConfirmar}
    >
      <p>{mensaje}</p>
      <p className="mt-2 text-muted-foreground">
        Si lo registras igual, esa cuenta queda en negativo y el arqueo no va a cuadrar. Suele
        significar que falta registrar una entrada, o que la plata salió de otra cuenta.
      </p>
    </ConfirmDialog>
  );
}
