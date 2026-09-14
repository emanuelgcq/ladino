import { Check } from "lucide-react";
import { Button } from "../../ui/button.js";
import { Input } from "../../ui/input.js";
import { FormField } from "../forms.js";

/**
 * «El IVA que cobras»: el paso de Empezar para una empresa que FACTURA. El
 * porcentaje lo escribe y lo acepta la persona (ADR-0038, VALIDAR-TRIBUTARIO);
 * esta pieza solo lo pinta — el estado y la llamada viven en la pantalla.
 */
export function IvaQueCobras({
  aceptado,
  valor,
  onValor,
  puedeAceptar,
  onAceptar,
}: {
  /** El porcentaje ya aceptado (p. ej. «16»), o null si falta. */
  aceptado: string | null;
  valor: string;
  onValor: (v: string) => void;
  puedeAceptar: boolean;
  onAceptar: () => void;
}): React.JSX.Element {
  return (
    <div className="space-y-2 border-t border-border pt-4">
      <h3 className="font-medium">El IVA que cobras</h3>
      {aceptado !== null ? (
        <p className="flex items-center gap-2 text-[0.95rem]">
          <Check className="size-4 text-success-soft-foreground" />
          Quedó en {aceptado}%, aceptado por ti.
        </p>
      ) : (
        <>
          <p className="text-[0.9rem] text-muted-foreground">
            El porcentaje lo fija la ley, no Ladino: escríbelo tú y confírmalo con tu contador. Al
            aceptar queda registrado con tu usuario y la fecha de hoy, y así aparecerá en la
            auditoría.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <FormField
              label="Porcentaje (%)"
              hint="La alícuota general vigente la confirma tu contador (Ley de IVA; hoy 16 %)."
            >
              {(p) => (
                <Input
                  {...p}
                  value={valor}
                  onChange={(e) => onValor(e.target.value)}
                  inputMode="decimal"
                  placeholder="16"
                  className="w-28"
                />
              )}
            </FormField>
            <Button variant="primary" disabled={!puedeAceptar} onClick={onAceptar}>
              Acepto este porcentaje
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
