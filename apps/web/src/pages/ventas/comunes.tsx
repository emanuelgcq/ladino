import { Link } from "react-router";
import { ClipboardCheck } from "lucide-react";
import { LlamadaApiError } from "../../lib.js";

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

export function MensajeError({ error }: { error: unknown }): React.JSX.Element {
  if (error instanceof LlamadaApiError) {
    const guia = CODIGOS_PUESTA_A_PUNTO[error.body.code];
    return (
      <div
        role="alert"
        className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-[0.88rem]"
      >
        <p className="font-medium text-warning-soft-foreground">{guia ?? `${error.body.code}`}</p>
        <p className="mt-0.5 text-muted-foreground">{error.body.message}</p>
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
  return (
    <p role="alert" className="text-[0.88rem] text-destructive-soft-foreground">
      {String(error)}
    </p>
  );
}

export function numeroDe(d: { series: string; document_number: number | null }): string {
  return d.document_number === null ? "borrador" : `${d.series}-${String(d.document_number)}`;
}

export const KIND_LABEL: Record<string, string> = {
  invoice: "Factura",
  credit_note: "Nota de crédito",
  debit_note: "Nota de débito",
  quote: "Cotización",
  order: "Pedido",
  return: "Devolución",
};
