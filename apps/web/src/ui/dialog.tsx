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
          "fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px] dark:bg-black/65",
          "transition-opacity duration-200 ease-out",
          "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
        )}
      />
      <BaseDialog.Popup
        className={cn(
          // En teléfono: casi todo el ancho y nunca más alto que la pantalla —
          // el contenido largo se desplaza DENTRO del diálogo.
          "fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-1.5rem)] w-[calc(100%-1.5rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto",
          "rounded-lg border border-glass-border bg-glass p-5 shadow-overlay outline-none backdrop-blur-xl backdrop-saturate-150",
          "transition-[opacity,transform,translate,scale] duration-200 ease-out",
          "data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
          "data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0",
          className,
        )}
        {...props}
      >
        {children}
        <BaseDialog.Close
          aria-label="Cerrar"
          className="absolute right-2 top-2 flex size-9 items-center justify-center rounded-sm text-muted-foreground hover:bg-surface-muted hover:text-foreground sm:right-3 sm:top-3 sm:size-auto sm:p-1"
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
  return <div className={cn("mt-4 flex flex-wrap justify-end gap-2", className)} {...props} />;
}
