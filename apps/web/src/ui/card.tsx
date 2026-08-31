import { cn } from "./cn.js";

/**
 * Tarjeta del sistema: superficie blanca (o slate-800), borde sutil, sombra
 * mínima. La elevación real la da el borde — nada de sombras dramáticas.
 */
export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn("rounded-md border border-border bg-surface shadow-soft", className)}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn("flex items-center justify-between gap-2 px-4 pt-3 pb-2", className)}
      {...props}
    />
  );
}

export function CardTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>): React.JSX.Element {
  return (
    <h3 className={cn("text-[0.95rem] font-semibold text-foreground", className)} {...props} />
  );
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  return <p className={cn("text-[0.85rem] text-muted-foreground", className)} {...props} />;
}

export function CardContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn("px-4 pb-4", className)} {...props} />;
}

export function Separator({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div role="separator" className={cn("h-px w-full bg-border", className)} {...props} />;
}

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn("animate-pulse rounded-sm bg-surface-muted", className)} {...props} />;
}
