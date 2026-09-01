import { cn } from "../ui/cn.js";
import { Tooltip } from "../ui/tooltip.js";
import { mostrarCantidad, mostrarImporte } from "../money.js";

/**
 * DualMoney — LA firma visual de Ladino: el manejo dual Bs/USD como identidad.
 *
 * Importe principal grande con tabular-nums; el otro lado de la operación,
 * discreto al lado; la tasa como tooltip con FUENTE y fecha, porque una tasa
 * sin fuente es un número que nadie puede defender.
 *
 * REGLA INNEGOCIABLE: este componente FORMATEA (packages/money/format) y jamás
 * convierte. El secundario solo existe si el SERVIDOR lo mandó — un documento
 * en USD trae su funcional en Bs congelado con la tasa de emisión (ADR-0020).
 * Convertir aquí con la tasa de hoy pintaría un importe que el sistema nunca
 * registró. Si solo hay una moneda, se muestra una: la honestidad es parte de
 * la firma.
 */
export interface RateInfo {
  readonly rate: string;
  readonly source: string;
  readonly timestamp?: string | null;
}

export interface DualMoneyProps {
  amount: string;
  currency: string;
  /** El otro lado (p. ej. funcional en Bs de un documento en USD), si el servidor lo dio. */
  secondary?: { amount: string; currency: string } | null;
  rate?: RateInfo | null;
  variant?: "inline" | "cell" | "kpi";
  className?: string;
}

function TooltipTasa({
  rate,
  children,
}: {
  rate: RateInfo;
  children: React.ReactElement<Record<string, unknown>>;
}): React.JSX.Element {
  return (
    <Tooltip
      content={
        <span className="block">
          <span className="block font-mono text-[0.82rem]">Tasa {mostrarCantidad(rate.rate)}</span>
          <span className="block text-muted-foreground">
            Fuente: {rate.source}
            {rate.timestamp != null && ` · ${rate.timestamp.slice(0, 10)}`}
          </span>
        </span>
      }
    >
      {children}
    </Tooltip>
  );
}

export function DualMoney({
  amount,
  currency,
  secondary,
  rate,
  variant = "inline",
  className,
}: DualMoneyProps): React.JSX.Element {
  const principal = mostrarImporte({ amount, currency });
  const secundario = secondary != null ? mostrarImporte(secondary) : null;

  const cuerpo =
    variant === "kpi" ? (
      <span className={cn("block", className)}>
        <span className="block font-mono text-[1.55rem] font-semibold leading-tight tracking-tight tabular-nums">
          {principal}
        </span>
        {secundario !== null && (
          <span className="mt-0.5 block font-mono text-[0.85rem] text-muted-foreground tabular-nums">
            ≈ {secundario}
          </span>
        )}
      </span>
    ) : variant === "cell" ? (
      <span className={cn("block text-right font-mono text-[0.84rem] tabular-nums", className)}>
        <span className="block">{principal}</span>
        {secundario !== null && (
          <span className="block text-[0.76rem] text-faint-foreground">{secundario}</span>
        )}
      </span>
    ) : (
      <span className={cn("inline-flex items-baseline gap-1.5", className)}>
        <span className="font-mono font-medium tabular-nums">{principal}</span>
        {secundario !== null && (
          <span className="font-mono text-[0.85em] text-muted-foreground tabular-nums">
            ≈ {secundario}
          </span>
        )}
      </span>
    );

  return rate != null ? <TooltipTasa rate={rate}>{cuerpo}</TooltipTasa> : cuerpo;
}
