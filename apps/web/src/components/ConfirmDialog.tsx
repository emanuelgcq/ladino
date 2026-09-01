import { useState } from "react";
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
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  destructive = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  /** Las consecuencias, en llano. Puede ser texto o un resumen con importes. */
  children: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<void>;
}): React.JSX.Element {
  const [ocupado, setOcupado] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>Revisa las consecuencias antes de confirmar.</DialogDescription>
        <div className="mt-3 text-[0.9rem]">{children}</div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={ocupado}>
            Volver
          </Button>
          <Button
            variant={destructive ? "destructive" : "primary"}
            disabled={ocupado}
            onClick={() => {
              setOcupado(true);
              void onConfirm().finally(() => {
                setOcupado(false);
                onOpenChange(false);
              });
            }}
          >
            {ocupado ? "Procesando…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
