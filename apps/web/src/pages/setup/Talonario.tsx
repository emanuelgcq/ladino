import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSesion } from "../../app/session.js";
import { FormField } from "../../components/forms.js";
import { Button } from "../../ui/button.js";
import { Input } from "../../ui/input.js";
import { useToast } from "../../ui/toast.js";
import { MensajeError } from "../ventas/comunes.js";
import { avisoDigitoRif } from "@ladino/schemas";

/**
 * EL TALONARIO DE LA IMPRENTA (ADR-0071; B-03, E-01, G-01).
 *
 * Un talonario por empresa e identificador sirve para facturas, notas de crédito y notas de
 * débito (PA 00071 arts. 31 y 44): ya no se pregunta «para qué documento». Lo que la imprenta
 * preimprime se pide tal como viene en el papel. Esta pantalla NO valida el RIF ni decide nada
 * fiscal: lo decide la API y su mensaje se enseña tal cual.
 */

/** Lo que la API devuelve de un talonario (FiscalRangeResponse). */
export interface Talonario {
  id: string;
  kind: string | null;
  series: string;
  printer_identifier: string;
  range_from: number;
  range_to: number;
  status: string;
  remaining: number;
  printer_legal_name: string | null;
  printer_data_complete: boolean;
  is_contingency: boolean;
}

/** Los talonarios de la CAJA con papel: activos, con números y que no son de contingencia. */
export function talonariosConPapel(rangos: readonly Talonario[]): Talonario[] {
  return rangos.filter((r) => r.status === "active" && r.remaining > 0 && !r.is_contingency);
}

/** «Listo para emitir»: con papel y con los datos de la imprenta completos. */
export function talonariosListos(rangos: readonly Talonario[]): Talonario[] {
  return talonariosConPapel(rangos).filter((r) => r.printer_data_complete);
}

/** Cómo se nombra un talonario en pantalla. */
export function nombreTalonario(r: Talonario): string {
  return `${r.series === "" ? "Sin serie" : `Serie ${r.series}`} · control ${r.printer_identifier}-${String(r.range_from).padStart(8, "0")} a ${r.printer_identifier}-${String(r.range_to).padStart(8, "0")}`;
}

const IMPRENTA_VACIA = {
  printer_legal_name: "",
  printer_tax_id: "",
  printer_authorization: "",
  printer_authorization_date: "",
  printed_on: "",
};
type Imprenta = typeof IMPRENTA_VACIA;

function CamposImprenta({
  valor,
  onValor,
}: {
  valor: Imprenta;
  onValor: (v: Imprenta) => void;
}): React.JSX.Element {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <FormField label="Imprenta (razón social)" required>
        {(a) => (
          <Input
            {...a}
            value={valor.printer_legal_name}
            placeholder="Gráficas El Sol, C.A."
            onChange={(e) => onValor({ ...valor, printer_legal_name: e.target.value })}
          />
        )}
      </FormField>
      <FormField label="RIF de la imprenta" required hint="Como viene impreso: J-12345678-9.">
        {(a) => (
          <>
            <Input
              {...a}
              value={valor.printer_tax_id}
              onChange={(e) => onValor({ ...valor, printer_tax_id: e.target.value })}
            />
            {/* Solo avisa: el dígito que no cuadra se guarda y queda en el acta (P-49). */}
            {avisoDigitoRif(valor.printer_tax_id) !== null && (
              <p className="mt-1 text-[0.8rem] text-warning-soft-foreground">
                {avisoDigitoRif(valor.printer_tax_id)}
              </p>
            )}
          </>
        )}
      </FormField>
      <FormField
        label="Providencia de la imprenta"
        required
        hint="El número de la providencia del SENIAT que la autoriza, como viene en el papel."
      >
        {(a) => (
          <Input
            {...a}
            value={valor.printer_authorization}
            onChange={(e) => onValor({ ...valor, printer_authorization: e.target.value })}
          />
        )}
      </FormField>
      <FormField label="Fecha de la providencia" required>
        {(a) => (
          <Input
            {...a}
            type="date"
            value={valor.printer_authorization_date}
            onChange={(e) => onValor({ ...valor, printer_authorization_date: e.target.value })}
          />
        )}
      </FormField>
      <FormField label="Fecha de elaboración" required hint="La que la imprenta puso en el papel.">
        {(a) => (
          <Input
            {...a}
            type="date"
            value={valor.printed_on}
            onChange={(e) => onValor({ ...valor, printed_on: e.target.value })}
          />
        )}
      </FormField>
    </div>
  );
}

const imprentaLlena = (v: Imprenta): boolean => Object.values(v).every((x) => x.trim() !== "");
const recortar = (v: Imprenta): Imprenta => ({
  printer_legal_name: v.printer_legal_name.trim(),
  printer_tax_id: v.printer_tax_id.trim(),
  printer_authorization: v.printer_authorization.trim(),
  printer_authorization_date: v.printer_authorization_date,
  printed_on: v.printed_on,
});

/** Registrar el talonario: número de control con su identificador, desde–hasta y la imprenta. */
export function FormularioTalonario({
  onRegistrado,
}: {
  onRegistrado?: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const qc = useQueryClient();
  const toast = useToast();
  const [forma, setForma] = useState({ series: "A", identificador: "00", desde: "1", hasta: "" });
  const [imprenta, setImprenta] = useState<Imprenta>(IMPRENTA_VACIA);
  const [error, setError] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);

  async function registrar(): Promise<void> {
    setError(null);
    setOcupado(true);
    try {
      await llamar("/v1/fiscal-number-ranges", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          series: forma.series.trim(),
          printer_identifier: forma.identificador.trim(),
          range_from: forma.desde.trim(),
          range_to: forma.hasta.trim(),
          ...recortar(imprenta),
        }),
      });
      toast.success(
        "Talonario registrado",
        forma.series.trim() === "" ? "Sin serie" : `Serie ${forma.series.trim()}`,
      );
      await qc.invalidateQueries({ queryKey: ["rangos", empresa.id] });
      await qc.invalidateQueries({ queryKey: ["empezar-rangos", empresa.id] });
      await qc.invalidateQueries({ queryKey: ["talonarios-caja", empresa.id] });
      onRegistrado?.();
    } catch (e) {
      setError(e);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface-muted/40 p-3">
      <p className="text-[0.88rem] text-muted-foreground">
        Un talonario sirve para facturas, notas de crédito y notas de débito: cada documento toma el
        siguiente número de control del papel, sea de la clase que sea.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <FormField label="Serie" hint="Como aparece impresa. Vacía si tu papel no trae serie.">
          {(a) => (
            <Input
              {...a}
              value={forma.series}
              onChange={(e) => setForma({ ...forma, series: e.target.value })}
            />
          )}
        </FormField>
        <FormField
          label="Identificador"
          required
          hint="Los 2 dígitos antes del guion del número de control."
        >
          {(a) => (
            <Input
              {...a}
              inputMode="numeric"
              maxLength={2}
              className="font-mono"
              value={forma.identificador}
              onChange={(e) => setForma({ ...forma, identificador: e.target.value })}
            />
          )}
        </FormField>
        <FormField label="Número de control desde" required>
          {(a) => (
            <Input
              {...a}
              inputMode="numeric"
              className="font-mono"
              value={forma.desde}
              onChange={(e) => setForma({ ...forma, desde: e.target.value })}
            />
          )}
        </FormField>
        <FormField label="Número de control hasta" required>
          {(a) => (
            <Input
              {...a}
              inputMode="numeric"
              className="font-mono"
              value={forma.hasta}
              onChange={(e) => setForma({ ...forma, hasta: e.target.value })}
            />
          )}
        </FormField>
      </div>
      <CamposImprenta valor={imprenta} onValor={setImprenta} />
      {error !== null && <MensajeError error={error} />}
      <Button
        variant="primary"
        size="sm"
        disabled={
          ocupado ||
          !/^\d+$/.test(forma.desde.trim()) ||
          !/^\d+$/.test(forma.hasta.trim()) ||
          !/^\d{2}$/.test(forma.identificador.trim()) ||
          !imprentaLlena(imprenta)
        }
        onClick={() => void registrar()}
      >
        Registrar talonario
      </Button>
    </div>
  );
}

/** Completar, una vez, los datos de la imprenta de un talonario registrado antes de ADR-0071. */
export function CompletarImprenta({ talonario }: { talonario: Talonario }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const qc = useQueryClient();
  const toast = useToast();
  const [imprenta, setImprenta] = useState<Imprenta>({
    ...IMPRENTA_VACIA,
    printer_legal_name: talonario.printer_legal_name ?? "",
  });
  const [error, setError] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);

  async function completar(): Promise<void> {
    setError(null);
    setOcupado(true);
    try {
      await llamar(`/v1/fiscal-number-ranges/${talonario.id}/printer`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id, ...recortar(imprenta) }),
      });
      toast.success("Datos de la imprenta completos", nombreTalonario(talonario));
      await qc.invalidateQueries({ queryKey: ["rangos", empresa.id] });
      await qc.invalidateQueries({ queryKey: ["empezar-rangos", empresa.id] });
      await qc.invalidateQueries({ queryKey: ["talonarios-caja", empresa.id] });
    } catch (e) {
      setError(e);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-warning/40 bg-warning-soft/30 p-3">
      <p className="text-[0.9rem] font-medium">
        {nombreTalonario(talonario)}: datos de imprenta incompletos
      </p>
      <p className="text-[0.85rem] text-muted-foreground">
        Hasta completarlos no se emite con este talonario. Se guardan una sola vez.
      </p>
      <CamposImprenta valor={imprenta} onValor={setImprenta} />
      {error !== null && <MensajeError error={error} />}
      <Button
        variant="primary"
        size="sm"
        disabled={ocupado || !imprentaLlena(imprenta)}
        onClick={() => void completar()}
      >
        Completar datos de la imprenta
      </Button>
    </div>
  );
}
