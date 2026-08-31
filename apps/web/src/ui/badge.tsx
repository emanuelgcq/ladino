import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn.js";

/**
 * Badge del sistema. Los tonos son los SEMÁNTICOS del tema y nada más:
 * esmeralda = positivo, ámbar = advertencia, rojo = destructivo, azul = info,
 * neutro = todo lo demás. FiscalStatusBadge decide cuál va con cada estado.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-px text-[0.78rem] font-medium " +
    "whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "border-border bg-surface-muted text-muted-foreground",
        accent: "border-transparent bg-accent-soft text-accent-soft-foreground",
        warning: "border-transparent bg-warning-soft text-warning-soft-foreground",
        destructive: "border-transparent bg-destructive-soft text-destructive-soft-foreground",
        info: "border-transparent bg-info-soft text-info-soft-foreground",
        outline: "border-border-strong text-muted-foreground",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;
