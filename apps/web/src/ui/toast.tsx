import { Toast as BaseToast } from "@base-ui-components/react/toast";
import { CheckCircle2, Info, TriangleAlert, X, XCircle } from "lucide-react";
import { cn } from "./cn.js";

/**
 * Toasts del sistema (Base UI). Un solo Provider en la raíz; cualquier pantalla
 * anuncia con `useToast()`. Los tipos mapean a los tonos semánticos del tema —
 * un toast rojo significa que algo destructivo falló, no «atención».
 */
export function ToasterProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <BaseToast.Provider>
      {children}
      <BaseToast.Portal>
        <BaseToast.Viewport className="fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
          <ToastList />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  );
}

const ICONO: Record<string, React.JSX.Element> = {
  success: <CheckCircle2 className="size-4 text-accent" />,
  warning: <TriangleAlert className="size-4 text-warning" />,
  error: <XCircle className="size-4 text-destructive" />,
  info: <Info className="size-4 text-info" />,
};

function ToastList(): React.JSX.Element {
  const { toasts } = BaseToast.useToastManager();
  return (
    <>
      {toasts.map((t) => (
        <BaseToast.Root
          key={t.id}
          toast={t}
          className={cn(
            "pointer-events-auto rounded-md border border-border bg-surface p-3 shadow-overlay",
            "transition-all data-[starting-style]:translate-y-2 data-[starting-style]:opacity-0",
            "data-[ending-style]:opacity-0",
          )}
        >
          <div className="flex items-start gap-2.5">
            <span className="mt-px shrink-0">{ICONO[t.type ?? "info"] ?? ICONO["info"]}</span>
            <div className="min-w-0 flex-1">
              <BaseToast.Title className="text-[0.9rem] font-medium text-foreground" />
              <BaseToast.Description className="mt-0.5 break-words text-[0.85rem] text-muted-foreground" />
            </div>
            <BaseToast.Close
              aria-label="Cerrar aviso"
              className="rounded p-0.5 text-faint-foreground hover:bg-surface-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </BaseToast.Close>
          </div>
        </BaseToast.Root>
      ))}
    </>
  );
}

export interface ToastFns {
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  warning: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

/** El hook que usan las pantallas. `error` no expira solo: un fallo se lee, no se escapa. */
export function useToast(): ToastFns {
  const manager = BaseToast.useToastManager();
  const add = (type: string, title: string, description?: string, timeout?: number) => {
    manager.add({
      type,
      title,
      ...(description === undefined ? {} : { description }),
      ...(timeout === undefined ? {} : { timeout }),
    });
  };
  return {
    success: (t, d) => add("success", t, d),
    error: (t, d) => add("error", t, d, 0),
    warning: (t, d) => add("warning", t, d, 8000),
    info: (t, d) => add("info", t, d),
  };
}
