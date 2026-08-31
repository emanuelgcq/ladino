import { cn } from "./cn.js";

/**
 * Primitivas de tabla estilo Stripe: cabecera queda, filas de 36–40 px,
 * bordes solo horizontales, números a la derecha en mono. DataTable las
 * orquesta; las pantallas simples pueden usarlas directas.
 */
export function Table({
  className,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement>): React.JSX.Element {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full caption-bottom border-collapse", className)} {...props} />
    </div>
  );
}

export function THead({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>): React.JSX.Element {
  return <thead className={cn("[&_tr]:border-b [&_tr]:border-border", className)} {...props} />;
}

export function TBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>): React.JSX.Element {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

export function TR({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement>): React.JSX.Element {
  return (
    <tr
      className={cn(
        "border-b border-border transition-colors hover:bg-surface-muted/60",
        "data-[clickable]:cursor-pointer",
        className,
      )}
      {...props}
    />
  );
}

export function TH({
  className,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>): React.JSX.Element {
  return (
    <th
      className={cn(
        "h-8 whitespace-nowrap px-2.5 text-left align-middle text-[0.8rem] font-medium",
        "text-muted-foreground first:pl-3 last:pr-3",
        className,
      )}
      {...props}
    />
  );
}

export function TD({
  className,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement>): React.JSX.Element {
  return (
    <td
      className={cn(
        "whitespace-nowrap px-2.5 py-2 align-middle text-[0.88rem] first:pl-3 last:pr-3",
        className,
      )}
      {...props}
    />
  );
}

/** Celda numérica: derecha y mono con tnum — la firma tipográfica contable. */
export function TDNum({
  className,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement>): React.JSX.Element {
  return <TD className={cn("text-right font-mono text-[0.84rem]", className)} {...props} />;
}
