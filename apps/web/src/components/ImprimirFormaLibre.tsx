import { useSesion } from "../app/session.js";
import { abrirPdf as abrirPdfApi } from "../pdf.js";
import { Button } from "../ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog.js";
import { useToast } from "../ui/toast.js";

/**
 * El diálogo «Imprimir en la forma libre» (ADR-0071 §4; RESPUESTA 2026-09-24 §2.1): enseña
 * «Próximo control: 00-00001234» para que la persona confirme que la hoja de la forma libre que va
 * a poner en la impresora coincide, y abre el PDF en su destino.
 *
 * El control lo da el SERVIDOR ya vestido (`control_display`): la web solo lo muestra. Lo usan el
 * detalle del documento y la «Venta lista» de la caja; el recibo no lo ofrece (no es fiscal).
 */
export function ImprimirFormaLibre({
  documentId,
  controlDisplay,
  onClose,
}: {
  documentId: string;
  controlDisplay: string | null;
  onClose: () => void;
}): React.JSX.Element {
  const { empresa } = useSesion();
  const toast = useToast();

  function abrir(destino: "papel" | "vista", copia = false): void {
    const q = `destino=${destino}${copia ? "&copia=1" : ""}`;
    void abrirPdfApi(`/v1/documents/${documentId}/pdf?${q}`, empresa.id, (m) =>
      toast.error("No se pudo abrir el PDF", m),
    );
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Imprimir en la forma libre</DialogTitle>
        <DialogDescription>
          Pon en la impresora la hoja de la forma libre cuyo número de control preimpreso coincida.
          Lo que la imprenta ya imprimió (control, RIF, sus datos y el rango) no se imprime encima.
        </DialogDescription>
        <p className="rounded-md border border-border px-3 py-2 text-[0.95rem]">
          Próximo control: <span className="font-mono font-semibold">{controlDisplay ?? "—"}</span>
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => abrir("vista")}>
            Vista previa
          </Button>
          <Button variant="secondary" onClick={() => abrir("papel", true)}>
            Imprimir copia
          </Button>
          <Button variant="primary" onClick={() => abrir("papel")}>
            Imprimir original
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
