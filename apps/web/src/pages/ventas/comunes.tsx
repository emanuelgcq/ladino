import { Link } from "react-router";
import { ClipboardCheck } from "lucide-react";
import { errorDePersona, LlamadaApiError } from "../../lib.js";
import { useConFacturas } from "../../app/modo-venta.js";

/**
 * Los 409 de puesta a punto NO son averías: son pasos pendientes de la
 * configuración fiscal, y el error lo dice y LLEVA al paso. Es el diseño que
 * resuelve R-16: el sistema no puede emitir hasta que carguen tres cosas, y
 * cada una tiene su casilla en /configuracion/fiscal.
 */
export const CODIGOS_PUESTA_A_PUNTO: Record<string, string> = {
  TAX_RULE_MISSING: "Falta la alícuota de IVA vigente (paso 1 de la puesta a punto).",
  EXCHANGE_RATE_MISSING: "Falta la tasa de cambio del día (paso 2 de la puesta a punto).",
  FISCAL_NUMBERING_INVALID:
    "Falta régimen fiscal o rango de numeración vigente (pasos 3 y 4 de la puesta a punto).",
  RETENTION_RULE_MISSING: "Falta la norma de retención cargada (módulo de compras).",
};

/**
 * Los 409 que NO son un paso pendiente de la puesta a punto sino «esto es de quien
 * factura» (plan «Ladino sin RIF», A10). Llevan a Empezar, donde se activa la
 * facturación, no a la puesta a punto fiscal.
 */
const CODIGOS_DE_QUIEN_FACTURA: Record<string, string> = {
  REGIME_KIND_NOT_ALLOWED: "Esto es de quien factura",
};

/**
 * Lo mismo, dicho a quien NO tiene RIF: nada de alícuotas, regímenes ni puesta a punto
 * fiscal (regla del dueño, 2026-09-16). La tasa sí existe para todos: se carga en Mi dinero.
 */
const CODIGOS_SIN_RIF: Record<string, { titulo: string; ir?: { to: string; texto: string } }> = {
  EXCHANGE_RATE_MISSING: {
    titulo: "Falta la tasa del día",
    ir: { to: "/dinero", texto: "Cargar la tasa en Mi dinero" },
  },
};

export function MensajeError({ error }: { error: unknown }): React.JSX.Element | null {
  const conFacturas = useConFacturas();
  // Sin error no hay mensaje. Quien lo pinta sin condición —Declarar IVA e
  // IGTF— mostraba un «null» rojo debajo de las pestañas nada más entrar,
  // porque `String(null)` es un texto perfectamente válido.
  if (error == null) return null;
  if (error instanceof LlamadaApiError && !conFacturas) {
    const sinRif = CODIGOS_SIN_RIF[error.body.code];
    return (
      <div
        role="alert"
        className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-[0.88rem]"
      >
        <p className="font-medium text-warning-soft-foreground">
          {sinRif?.titulo ?? "No se pudo completar"}
        </p>
        {/* El mensaje EN VOZ DE PERSONA, nunca el técnico. */}
        <p className="mt-0.5 text-muted-foreground">{errorDePersona(error)}</p>
        {sinRif?.ir !== undefined && (
          <Link
            to={sinRif.ir.to}
            className="mt-1.5 inline-flex items-center gap-1.5 font-medium text-accent-soft-foreground hover:underline"
          >
            <ClipboardCheck className="size-3.5" /> {sinRif.ir.texto}
          </Link>
        )}
      </div>
    );
  }
  if (error instanceof LlamadaApiError) {
    const guia = CODIGOS_PUESTA_A_PUNTO[error.body.code];
    const deQuienFactura = CODIGOS_DE_QUIEN_FACTURA[error.body.code];
    return (
      <div
        role="alert"
        className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-[0.88rem]"
      >
        {/* Nunca el código crudo como título (A10): la persona lee una frase. */}
        <p className="font-medium text-warning-soft-foreground">
          {guia ?? deQuienFactura ?? "No se pudo completar"}
        </p>
        <p className="mt-0.5 text-muted-foreground">{error.body.message}</p>
        {deQuienFactura !== undefined && (
          <Link
            to="/empezar"
            className="mt-1.5 inline-flex items-center gap-1.5 font-medium text-accent-soft-foreground hover:underline"
          >
            <ClipboardCheck className="size-3.5" /> Ir a Empezar
          </Link>
        )}
        {guia !== undefined && (
          <Link
            to="/admin/facturacion-fiscal"
            className="mt-1.5 inline-flex items-center gap-1.5 font-medium text-accent-soft-foreground hover:underline"
          >
            <ClipboardCheck className="size-3.5" /> Ir a la puesta a punto fiscal
          </Link>
        )}
      </div>
    );
  }
  // `String(e)` de un objeto cualquiera pinta «[object Object]»; el helper da
  // una frase que una persona puede leer y actuar.
  return (
    <p role="alert" className="text-[0.88rem] text-destructive-soft-foreground">
      {error instanceof Error ? error.message : errorDePersona(error)}
    </p>
  );
}

export function numeroDe(d: { series: string; document_number: number | null }): string {
  return d.document_number === null ? "borrador" : `${d.series}-${String(d.document_number)}`;
}

export const KIND_LABEL: Record<string, string> = {
  invoice: "Factura",
  receipt: "Recibo",
  receipt_return: "Recibo de devolución",
  credit_note: "Nota de crédito",
  debit_note: "Nota de débito",
  quote: "Cotización",
  order: "Pedido",
  return: "Devolución",
};
