import { mostrarImporte } from "../money.js";
import { esCero } from "./decimal-compare.js";

/**
 * LA DEUDA QUE EL SERVIDOR NO PUEDE DECIR EN BOLÍVARES (ADR-0075 §5, H12).
 *
 * La deuda de un documento en divisa se enseña en la moneda de la empresa «a la tasa de hoy».
 * Cuando no hay tasa (o un cobro viejo en otra moneda no tiene con qué valorarse), el servidor
 * manda `null` en vez de una cifra: `debt`, `balance`, `total_outstanding`, el `amount` de un
 * tramo de antigüedad y `functional_today`. `null` NO es cero: el cliente debe, y lo que falta es
 * la tasa. Aquí vive, en UN sitio, cómo se dice eso — nunca «0», «null», «NaN» ni una excepción.
 *
 * Nada de esto calcula dinero (apps/web/CLAUDE.md): solo clasifica y escribe lo que llegó.
 */
export const FALTA_LA_TASA = "Falta la tasa de hoy";

export type EstadoDeDeuda = "sin_deuda" | "debe" | "sin_valorar";

/**
 * Qué dice una cifra de deuda del servidor:
 *   · `undefined` — no se pidió o no aplica → «sin_deuda» (no hay nada que enseñar);
 *   · `null`      — hay deuda y no se puede valorar hoy → «sin_valorar»;
 *   · cero o negativa (un saldo a favor no es deuda) → «sin_deuda»;
 *   · lo demás → «debe».
 */
export function estadoDeDeuda(valor: string | null | undefined): EstadoDeDeuda {
  if (valor === undefined) return "sin_deuda";
  if (valor === null) return "sin_valorar";
  if (esCero(valor) || valor.trim().startsWith("-")) return "sin_deuda";
  return "debe";
}

/** El importe vestido, o el texto único cuando el servidor no pudo valorarlo. */
export function textoDeDeuda(amount: string | null | undefined, currency: string): string {
  if (amount === null || amount === undefined) return FALTA_LA_TASA;
  return mostrarImporte({ amount, currency });
}

/**
 * Lo que SÍ se conoce cuando falta la tasa: el nominal por moneda, tal como lo mandó el servidor
 * («USD 100,00 + EUR 20,00»). Cadena vacía si no hay nada que decir.
 */
export function nominalPorMoneda(
  filas: readonly { readonly currency: string; readonly nominal: string | null }[] | undefined,
): string {
  return (filas ?? [])
    .filter((f): f is { currency: string; nominal: string } => f.nominal !== null)
    .filter((f) => !esCero(f.nominal))
    .map((f) => mostrarImporte({ amount: f.nominal, currency: f.currency }))
    .join(" + ");
}

/** Por qué no se puede cobrar un documento sin valorar. El texto vive aquí, como el de arriba. */
export const SIN_TASA_NO_SE_COBRA = `${FALTA_LA_TASA}: cárgala para poder cobrar este documento.`;

export interface DecisionDeCobro {
  /** El botón de cobrar se enseña (el documento sigue abierto). */
  readonly visible: boolean;
  /** Se enseña APAGADO: hay deuda, pero no se sabe cuánta. */
  readonly apagado: boolean;
  /** El motivo, para el título del botón y el texto visible. `null` si se puede cobrar. */
  readonly motivo: string | null;
}

/**
 * ¿Se puede cobrar un documento con este saldo? UNA conducta para todas las pantallas:
 *   · «debe»        → el botón, encendido;
 *   · «sin_valorar» → el botón, APAGADO y con su motivo. Nunca se abre el cobro con un «0»
 *                     precargado: `null` no es cero, y la previa mandaría `total: "0"`;
 *   · «sin_deuda»   → sin botón.
 */
export function decisionDeCobro(balance: string | null | undefined): DecisionDeCobro {
  const estado = estadoDeDeuda(balance);
  if (estado === "sin_deuda") return { visible: false, apagado: false, motivo: null };
  if (estado === "sin_valorar") {
    return { visible: true, apagado: true, motivo: SIN_TASA_NO_SE_COBRA };
  }
  return { visible: true, apagado: false, motivo: null };
}
