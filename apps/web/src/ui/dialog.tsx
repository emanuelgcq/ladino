import { Dialog as BaseDialog } from "@base-ui-components/react/dialog";
import { X } from "lucide-react";
import { cn } from "./cn.js";

/**
 * Diálogo del sistema sobre Base UI: foco atrapado, Escape cierra, backdrop
 * con scrim sutil. La accesibilidad viene de serie — no la rompas quitando
 * Title o Description.
 */
export const Dialog = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;

export function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof BaseDialog.Popup>): React.JSX.Element {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop
        className={cn(
          "fixed inset-0 z-40 bg-slate-950/40 backdrop-blur-[1px]",
          "transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
        )}
      />
      <BaseDialog.Popup
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2",
          "rounded-md border border-border bg-surface p-5 shadow-overlay outline-none",
          "transition-all data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
          "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
          className,
        )}
        {...props}
      >
        {children}
        <BaseDialog.Close
          aria-label="Cerrar"
          className="absolute right-3 top-3 rounded-sm p-1 text-muted-foreground hover:bg-surface-muted hover:text-foreground"
        >
          <X className="size-4" />
        </BaseDialog.Close>
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof BaseDialog.Title>): React.JSX.Element {
  return (
    <BaseDialog.Title
      className={cn("text-[1.05rem] font-semibold text-foreground", className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof BaseDialog.Description>): React.JSX.Element {
  return (
    <BaseDialog.Description
      className={cn("mt-1 text-[0.9rem] text-muted-foreground", className)}
      {...props}
    />
  );
}

export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn("mt-4 flex justify-end gap-2", className)} {...props} />;
}
