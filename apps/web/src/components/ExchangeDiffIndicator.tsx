import { ArrowRight, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "../ui/cn.js";
import { mostrarImporte } from "../money.js";

/**
 * ExchangeDiffIndicator — el diferencial cambiario con su narrativa.
 *
 * Ganancia en esmeralda, pérdida en ÁMBAR (no rojo: perder por la tasa no es
 * un error destructivo, es la economía del país), y en el detalle la historia
 * completa: tasa de emisión → tasa de cobro. El importe viene CALCULADO del
 * servidor (exchange_gain_loss / payments.exchange_difference); aquí solo se
 * decide el signo leyendo el string decimal — nunca pasando por un float.
 */
function signoDe(amount: string): -1 | 0 | 1 {
  const s = amount.trim();
  const negativo = s.startsWith("-");
  const cuerpo = negativo ? s.slice(1) : s;
  // Cero con cualquier número de decimales: "0", "0.00000000"…
  if (/^0*(?:\.0*)?$/.test(cuerpo)) return 0;
  return negativo ? -1 : 1;
}

export function ExchangeDiffIndicator({
  difference,
  currency,
  rateIssue,
  ratePayment,
  variant = "inline",
  className,
}: {
  difference: string;
  currency: string;
  /** La tasa a la que nació el documento, si quien llama la tiene. */
  rateIssue?: string | null;
  /** La tasa a la que se cobró. */
  ratePayment?: string | null;
  variant?: "inline" | "detail";
  className?: string;
}): React.JSX.Element {
  const signo = signoDe(difference);
  const importe = mostrarImporte({ amount: difference, currency });

  const color =
    signo > 0
      ? "text-accent-soft-foreground"
      : signo < 0
        ? "text-warning-soft-foreground"
        : "text-muted-foreground";
  const Icono = signo > 0 ? TrendingUp : signo < 0 ? TrendingDown : Minus;
  const etiqueta =
    signo > 0 ? "Ganancia cambiaria" : signo < 0 ? "Pérdida cambiaria" : "Sin diferencial";

  if (variant === "inline") {
    return (
      <span
        className={cn("inline-flex items-center gap-1 font-mono text-[0.84rem]", color, className)}
        title={etiqueta}
      >
        <Icono className="size-3.5" />
        {importe}
      </span>
    );
  }

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2",
        signo > 0 && "border-accent/30 bg-accent-soft/50",
        signo < 0 && "border-warning/30 bg-warning-soft",
        signo === 0 && "border-border bg-surface-muted/50",
        className,
      )}
    >
      <p className={cn("flex items-center gap-1.5 text-[0.85rem] font-medium", color)}>
        <Icono className="size-4" /> {etiqueta}
      </p>
      <p className={cn("mt-0.5 font-mono text-[1.05rem] font-semibold tabular-nums", color)}>
        {importe}
      </p>
      {rateIssue != null && ratePayment != null && (
        <p className="mt-1 flex items-center gap-1.5 font-mono text-[0.78rem] text-muted-foreground tabular-nums">
          emisión {rateIssue}
          <ArrowRight className="size-3" />
          cobro {ratePayment}
        </p>
      )}
    </div>
  );
}
