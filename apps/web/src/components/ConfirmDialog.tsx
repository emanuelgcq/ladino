import { useEffect, useRef, useState } from "react";
import { errorDePersona } from "../lib.js";
import { Button } from "../ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../ui/dialog.js";

/**
 * ConfirmDialog — toda acción irreversible pasa por aquí (UX no negociable):
 * resume las CONSECUENCIAS en lenguaje llano antes del botón. El botón
 * confirma en pasado remoto de lo que hará («Emitir la factura»), nunca un
 * «Aceptar» genérico que no dice qué acepta.
 *
 * Si `onConfirm` rechaza, el diálogo NO se cierra: el error se pinta aquí
 * dentro, en voz de persona, y el botón vuelve a habilitarse para reintentar
 * o volver. Antes se cerraba igual y el rechazo quedaba sin manejar (un
 * `pageerror` en consola y una pantalla que no decía nada — auditoría
 * 2026-09-11, transferencia rechazada por permiso).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  destructive = false,
  confirmDisabled = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  /** Las consecuencias, en llano. Puede ser texto o un resumen con importes. */
  children: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  /**
   * El botón de confirmar se apaga mientras lo que se pide dentro del diálogo
   * (un motivo, un importe, una fecha) no sea válido. Sin esto el usuario
   * confirmaba y recibía el 422 del servidor como si fuera un fallo.
   */
  confirmDisabled?: boolean;
  onConfirm: () => Promise<void>;
}): React.JSX.Element {
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Quien confirma puede desmontar este diálogo desde su propio `onConfirm`
  // (cerrando el diálogo padre): no se toca el estado de un componente ido.
  const montado = useRef(true);
  useEffect(() => {
    montado.current = true;
    return () => {
      montado.current = false;
    };
  }, []);

  // Cada apertura empieza limpia: un error de la vez anterior no es de esta.
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  async function confirmar(): Promise<void> {
    setError(null);
    setOcupado(true);
    try {
      await onConfirm();
      if (montado.current) onOpenChange(false);
    } catch (e) {
      if (montado.current) setError(e);
    } finally {
      if (montado.current) setOcupado(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>Revisa las consecuencias antes de confirmar.</DialogDescription>
        <div className="mt-3 text-[0.9rem]">{children}</div>
        {error !== null && (
          <p
            role="alert"
            className="mt-3 rounded-md bg-destructive-soft px-3 py-2 text-[0.85rem] text-destructive-soft-foreground"
          >
            {errorDePersona(error)}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={ocupado}>
            Volver
          </Button>
          <Button
            variant={destructive ? "destructive" : "primary"}
            disabled={ocupado || confirmDisabled}
            onClick={() => void confirmar()}
          >
            {ocupado ? "Procesando…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
