import { forwardRef } from "react";
import { cn } from "./cn.js";

/** Input de texto del sistema. La validación la pinta FormField, no el input. */
export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "h-8 w-full rounded-sm border border-border-strong bg-surface px-2.5 text-[0.92rem]",
          "text-foreground placeholder:text-faint-foreground shadow-soft transition-colors",
          "focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
          className,
        )}
        {...props}
      />
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "min-h-16 w-full rounded-sm border border-border-strong bg-surface px-2.5 py-1.5",
        "text-[0.92rem] text-foreground placeholder:text-faint-foreground shadow-soft",
        "focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
});

export function Label({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>): React.JSX.Element {
  // Label real, no un span: clic enfoca el control y el lector lo anuncia.
  // La asociación la hace quien lo usa, vía htmlFor (FormField lo garantiza).
  return (
    <label
      className={cn("text-[0.85rem] font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}
