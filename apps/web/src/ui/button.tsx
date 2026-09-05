import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn.js";

/**
 * Botón del sistema. UNA acción primaria esmeralda por pantalla; el resto son
 * secundarios o fantasma. `destructive` se reserva para lo que borra o anula —
 * el rojo pierde su significado si aparece en cualquier parte.
 */
const buttonVariants = cva(
  // Micro-interacción de PRENSA (guías 2026): 150 ms ease-out, escala 0.98
  // al pulsar — feedback físico sin teatro. reduced-motion la apaga global.
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm font-medium " +
    "transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out " +
    "active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
    "[&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer select-none",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-foreground hover:bg-accent-hover shadow-soft",
        secondary:
          "border border-border-strong bg-surface text-foreground hover:bg-surface-muted shadow-soft",
        ghost: "text-muted-foreground hover:bg-surface-muted hover:text-foreground",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive-hover shadow-soft",
        outline:
          "border border-accent/40 text-accent-soft-foreground bg-accent-soft/50 hover:bg-accent-soft",
      },
      size: {
        sm: "h-7 px-2.5 text-[0.85rem]",
        md: "h-8 px-3 text-[0.92rem]",
        lg: "h-9 px-4 text-[0.95rem]",
        icon: "h-8 w-8",
        iconSm: "h-7 w-7",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      // `button` por defecto: dentro de un <form>, un botón sin type es submit
      // y dispara el envío al hacer clic en cualquier acción secundaria.
      type={type ?? "button"}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
});

export { buttonVariants };
