import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useSesion } from "../../app/session.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../ui/dialog.js";
import { Button } from "../../ui/button.js";
import { Input } from "../../ui/input.js";
import { SimpleSelect } from "../../ui/select.js";
import { useToast } from "../../ui/toast.js";
import { FormField, MoneyInput, importeValido } from "../../components/forms.js";
import { ExchangeDiffIndicator } from "../../components/ExchangeDiffIndicator.js";
import { mostrarImporte } from "../../money.js";
import { MensajeError } from "./comunes.js";

/**
 * Registro de cobro con el diferencial contado ANTES de confirmar — como
 * narrativa de tasas, no como cifra: «la factura nació a tasa X; hoy la tasa
 * es Y; el diferencial exacto lo calcula el servidor al registrar». Calcular
 * el importe aquí para adelantarlo está prohibido (apps/web/CLAUDE.md), y un
 * número adelantado que luego difiere del real es peor que la espera. El
 * resultado del servidor se enseña al terminar, con su ganancia o pérdida.
 */
const INSTRUMENTOS = [
  { value: "efectivo_bs", label: "Efectivo Bs" },
  { value: "efectivo_usd", label: "Efectivo USD" },
  { value: "zelle", label: "Zelle" },
  { value: "usdt", label: "USDT" },
  { value: "transferencia", label: "Transferencia" },
  { value: "punto_venta", label: "Punto de venta" },
  { value: "otro", label: "Otro" },
];

interface DocumentoPago {
  id: string;
  transaction_currency: string;
  functional_currency: string;
  fx_rate: string;
  rate_source: string;
}

export function RegistrarPago({
  documento,
  balance,
  onClose,
}: {
  documento: DocumentoPago;
  balance: string;
  onClose: (hecho: boolean) => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [moneda, setMoneda] = useState(documento.transaction_currency);
  const [importe, setImporte] = useState("");
  const [instrumento, setInstrumento] = useState("transferencia");
  const [referencia, setReferencia] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);
  const [resultado, setResultado] = useState<{ exchange_difference: string | null } | null>(null);

  // La tasa de HOY, para la narrativa del preview. Es un dato del servidor.
  const tasas = useQuery({
    queryKey: ["tasas", "USD-VES"],
    staleTime: 60_000,
    queryFn: () =>
      llamar<{ rate: string; source: string; rate_date: string }[]>(`/v1/exchange-rates`),
  });
  const tasaHoy = tasas.data?.[0];
  const enDivisa = moneda !== documento.functional_currency;
  const habraDiferencial =
    documento.transaction_currency !== documento.functional_currency &&
    tasaHoy !== undefined &&
    tasaHoy.rate !== documento.fx_rate;

  const puedeEnviar = useMemo(
    () => importeValido(importe) && instrumento !== "",
    [importe, instrumento],
  );

  async function registrar(): Promise<void> {
    setError(null);
    setOcupado(true);
    try {
      const r = await llamar<
        { payment: unknown; exchange_difference: string | null } & Record<string, unknown>
      >("/v1/payments", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          document_id: documento.id,
          currency: moneda,
          amount: importe.trim(),
          instrument: instrumento,
          ...(referencia.trim() === "" ? {} : { reference: referencia.trim() }),
        }),
      });
      const dif = typeof r["exchange_difference"] === "string" ? r["exchange_difference"] : null;
      setResultado({ exchange_difference: dif });
      toast.success("Cobro registrado");
    } catch (e) {
      setError(e);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose(resultado !== null)}>
      <DialogContent>
        {resultado === null ? (
          <>
            <DialogTitle>Registrar cobro</DialogTitle>
            <DialogDescription>
              Saldo pendiente:{" "}
              {mostrarImporte({ amount: balance, currency: documento.functional_currency })}
            </DialogDescription>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Moneda" required>
                  {(a) => (
                    <SimpleSelect
                      id={a.id}
                      value={moneda}
                      onValueChange={setMoneda}
                      options={[
                        { value: "VES", label: "VES — Bolívares" },
                        { value: "USD", label: "USD — Dólares" },
                      ]}
                    />
                  )}
                </FormField>
                <FormField label="Importe" required>
                  {(a) => (
                    <MoneyInput
                      id={a.id}
                      ariaInvalid={a["aria-invalid"]}
                      ariaDescribedby={a["aria-describedby"]}
                      value={importe}
                      onChange={setImporte}
                      currency={moneda}
                    />
                  )}
                </FormField>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Instrumento" required>
                  {(a) => (
                    <SimpleSelect
                      id={a.id}
                      value={instrumento}
                      onValueChange={setInstrumento}
                      options={INSTRUMENTOS}
                    />
                  )}
                </FormField>
                <FormField label="Referencia" hint="Número de operación, si aplica.">
                  {(a) => (
                    <Input
                      id={a.id}
                      value={referencia}
                      onChange={(e) => setReferencia(e.target.value)}
                    />
                  )}
                </FormField>
              </div>

              {habraDiferencial && (
                <div className="rounded-md border border-info/30 bg-info-soft px-3 py-2 text-[0.85rem]">
                  <p className="font-medium text-info-soft-foreground">
                    Este cobro tendrá diferencial cambiario
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 font-mono text-[0.8rem] text-muted-foreground tabular-nums">
                    tasa de emisión {documento.fx_rate} ({documento.rate_source})
                    <ArrowRight className="size-3" />
                    tasa de hoy {tasaHoy.rate} ({tasaHoy.source})
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    El importe exacto lo calcula el servidor al registrar — aquí no se adelantan
                    cifras que el sistema no haya escrito.
                  </p>
                </div>
              )}
              {enDivisa && tasaHoy === undefined && !tasas.isPending && (
                <p className="text-[0.85rem] text-warning-soft-foreground">
                  No hay tasa cargada: el cobro en divisa responderá EXCHANGE_RATE_MISSING.
                </p>
              )}
              {error !== null && <MensajeError error={error} />}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => onClose(false)} disabled={ocupado}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                disabled={!puedeEnviar || ocupado}
                onClick={() => void registrar()}
              >
                {ocupado ? "Registrando…" : "Registrar cobro"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogTitle>Cobro registrado</DialogTitle>
            <DialogDescription>El servidor confirmó el cobro y su efecto.</DialogDescription>
            <div className="mt-3">
              {resultado.exchange_difference !== null ? (
                <ExchangeDiffIndicator
                  variant="detail"
                  difference={resultado.exchange_difference}
                  currency={documento.functional_currency}
                  rateIssue={documento.fx_rate}
                  ratePayment={tasaHoy?.rate ?? null}
                />
              ) : (
                <p className="text-[0.9rem] text-muted-foreground">
                  Sin diferencial cambiario en este cobro.
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="primary" onClick={() => onClose(true)}>
                Listo
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
