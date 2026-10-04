import { useState } from "react";
import { useSesion } from "../app/session.js";
import { LlamadaApiError, errorDePersona } from "../lib.js";
import { Input } from "../ui/input.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { FormField } from "./forms.js";

/**
 * EL SALDO QUE NO ALCANZA (ADR-0062 §4; D-11 y H-05, ola 3). El servidor rechaza con 409
 * `INSUFFICIENT_FUNDS` todo egreso que dejaría la cuenta en negativo. La pantalla no decide si se
 * puede: ofrece SIEMPRE elegir otra cuenta, y registrarlo igual SOLO a quien tiene el permiso de
 * dejar una cuenta en negativo, pidiéndole el motivo. Con el motivo se reenvía la MISMA operación
 * con `allow_negative_balance: true` y `overdraft_reason`, y el servidor deja el acta.
 *
 * Antes cualquiera veía «Registrarlo igual» y bastaba un clic: el servidor no pedía permiso ni
 * motivo, y a quien no podía se le proponía una salida que no tenía (H-05).
 *
 * Existe porque el QA de pantalla del 2026-09-15 encontró tres cajas en negativo (un gasto, un
 * pago a proveedor y un reembolso) sin que nadie se enterara: «Caja del local» quedó en −4.716,36
 * y la pantalla no dijo nada.
 */

/** El permiso que el servidor exige para sobregirar. La web solo decide qué ENSEÑA con él. */
export const PERMISO_DE_SOBREGIRO = "treasury.overdraft";
/** El mismo mínimo que el servidor (`MOTIVO_DE_SOBREGIRO_MINIMO`): una frase, no un «ok». */
export const MOTIVO_MINIMO = 5;

export const TEXTOS_SOBREGIRO = {
  titulo: "No alcanza el saldo",
  otraCuenta: "Elegir otra cuenta",
  registrarIgual: "Registrarlo igual",
  motivo: "¿Por qué se registra sin saldo?",
  ayudaMotivo: "Queda en el historial, con tu nombre.",
  consecuencia:
    "Puedes cancelar y elegir otra cuenta. Si lo registras igual, esa cuenta queda en negativo y el arqueo no va a cuadrar: suele significar que falta registrar una entrada, o que la plata salió de otra cuenta.",
  sinPermiso:
    "Elige otra cuenta, o pídele a quien administra el negocio que lo registre: dejar una cuenta en negativo necesita su permiso.",
};

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
  /** Cierra el aviso: la persona vuelve al formulario a elegir otra cuenta. */
  onCancelar: () => void;
  /**
   * Reenvía la operación con la confirmación y su MOTIVO. Si vuelve a fallar, el error se pinta
   * aquí. Solo se llama para quien tiene el permiso.
   */
  onConfirmar: (motivo: string) => Promise<void>;
}): React.JSX.Element {
  const { puede } = useSesion();
  const [motivo, setMotivo] = useState("");

  if (!puede(PERMISO_DE_SOBREGIRO)) {
    // Sin el permiso no hay «regístralo igual»: la única salida de la pantalla es otra cuenta.
    return (
      <ConfirmDialog
        open
        onOpenChange={(v) => {
          if (!v) onCancelar();
        }}
        title={TEXTOS_SOBREGIRO.titulo}
        confirmLabel={TEXTOS_SOBREGIRO.otraCuenta}
        onConfirm={() => {
          onCancelar();
          return Promise.resolve();
        }}
      >
        <p>{mensaje}</p>
        <p className="mt-2 text-muted-foreground">{TEXTOS_SOBREGIRO.sinPermiso}</p>
      </ConfirmDialog>
    );
  }

  return (
    <ConfirmDialog
      open
      onOpenChange={(v) => {
        if (!v) onCancelar();
      }}
      title={TEXTOS_SOBREGIRO.titulo}
      confirmLabel={TEXTOS_SOBREGIRO.registrarIgual}
      destructive
      confirmDisabled={motivo.trim().length < MOTIVO_MINIMO}
      onConfirm={() => onConfirmar(motivo.trim())}
    >
      <p>{mensaje}</p>
      <p className="mt-2 text-muted-foreground">{TEXTOS_SOBREGIRO.consecuencia}</p>
      <FormField
        label={TEXTOS_SOBREGIRO.motivo}
        required
        hint={TEXTOS_SOBREGIRO.ayudaMotivo}
        className="mt-3"
      >
        {(p) => (
          <Input
            {...p}
            value={motivo}
            maxLength={300}
            onChange={(e) => setMotivo(e.target.value)}
          />
        )}
      </FormField>
    </ConfirmDialog>
  );
}
