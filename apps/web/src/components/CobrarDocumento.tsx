import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useSesion } from "../app/session.js";
import { errorDePersona, LlamadaApiError } from "../lib.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../ui/dialog.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { SimpleSelect } from "../ui/select.js";
import { useToast } from "../ui/toast.js";
import { FormField, MoneyInput, importeValido } from "./forms.js";
import { ExchangeDiffIndicator } from "./ExchangeDiffIndicator.js";
import { FiscalStatusBadge } from "./FiscalStatusBadge.js";
import { MensajeError } from "../pages/ventas/comunes.js";
import { mostrarCantidad, mostrarImporte } from "../money.js";
import { fechaLocal } from "../fechas.js";
import { opcionesDeCobro, type FormaDePago, type OpcionDeCobro } from "./formas-de-pago.js";

/**
 * EL diálogo de cobro de un documento (M-05): antes había dos —uno en el
 * detalle de la factura y otro en la ficha del cliente— que ofrecían
 * instrumentos distintos, con o sin cuenta, con o sin saldo a favor. Ahora es
 * uno, y ofrece lo mismo que el POS: las formas configuradas del negocio (con
 * su cuenta), las formas base que ninguna cubra, y el saldo a favor del
 * cliente cuando lo tiene.
 *
 * Aquí no se calcula dinero: el importe se teclea, la tasa de hoy se ENSEÑA
 * (con su fuente) y todo lo demás —conversión, diferencial, IGTF, saldo que
 * queda, estado del documento— lo dice el servidor al terminar y se muestra
 * tal cual llegó.
 *
 * La llave de idempotencia nace UNA vez por apertura del diálogo: un rechazo
 * (4xx) se corrige y se reintenta con la misma llave; una respuesta perdida
 * tras el éxito no cobra dos veces.
 */
interface CuentaTesoreria {
  id: string;
  name: string;
  currency: string;
  is_active: boolean;
}
interface Credito {
  id: string;
  source_document_id: string;
  amount: string;
  applied_amount: string;
  status: "available" | "applied" | "expired";
}
interface TasaHoy {
  rate: string;
  source: string;
  rate_date: string;
}
interface Registrado {
  payment: { id: string; currency: string; amount: string; fx_rate: string; rate_source: string };
  exchange_difference: {
    difference: string;
    fx_rate_issue: string;
    fx_rate_payment: string;
  } | null;
  balance: string;
  document_status: string;
  igtf: { amount: string; currency: string; functional_amount: string; rate: string } | null;
}

const CLAVE_CREDITO = "credito";

export function CobrarDocumento({
  documentId,
  customerId,
  saldo,
  documentCurrency,
  etiqueta,
  tasaEmision = null,
  onCerrar,
  onCobrado,
}: {
  documentId: string;
  customerId: string | null;
  /** El saldo que dijo el servidor, en la moneda FUNCIONAL. */
  saldo: { amount: string; currency: string };
  /** La moneda en la que nació el documento (transaction_currency). */
  documentCurrency: string;
  /** Cómo se llama el documento en el título («FAC-00000012»). */
  etiqueta?: string;
  /** La tasa a la que nació el documento, para la narrativa del diferencial. */
  tasaEmision?: { rate: string; source: string } | null;
  onCerrar: () => void;
  onCobrado: (r: Registrado) => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  const [forma, setForma] = useState<string | null>(null);
  const [importe, setImporte] = useState(saldo.amount);
  const [referencia, setReferencia] = useState("");
  const [cuentaId, setCuentaId] = useState<string | null>(null);
  const [creditoId, setCreditoId] = useState<string | null>(null);
  const [resultado, setResultado] = useState<Registrado | null>(null);
  // Estable por apertura: se crea una vez y no cambia entre reintentos.
  const llave = useRef(crypto.randomUUID());

  const formas = useQuery({
    queryKey: ["formas-pago", empresa.id],
    staleTime: 60_000,
    queryFn: () => llamar<{ methods: FormaDePago[] }>("/v1/payment-methods"),
  });
  const statement = useQuery({
    queryKey: ["statement", empresa.id, customerId],
    enabled: customerId !== null,
    staleTime: 30_000,
    queryFn: () => llamar<{ credits: Credito[] }>(`/v1/customers/${customerId}/statement`),
  });
  // Ver las cuentas exige treasury.read (o cash.close): un cajero sin él
  // recibe 403 y el selector sencillamente no aparece — el servidor resuelve
  // la cuenta por la forma configurada o «Sin asignar».
  const cuentas = useQuery({
    queryKey: ["cuentas-tesoreria", empresa.id],
    staleTime: 60_000,
    retry: false,
    queryFn: () =>
      llamar<{ accounts: CuentaTesoreria[] }>("/v1/treasury/accounts").catch(() => ({
        accounts: [] as CuentaTesoreria[],
      })),
  });

  const creditosDisponibles = useMemo(
    () => (statement.data?.credits ?? []).filter((c) => c.status === "available"),
    [statement.data],
  );

  const opciones = useMemo<OpcionDeCobro[]>(() => {
    const base = opcionesDeCobro(formas.data?.methods);
    if (creditosDisponibles.length > 0) {
      base.push({
        clave: CLAVE_CREDITO,
        etiqueta: "Saldo a favor",
        instrument: "saldo_a_favor",
        currency: saldo.currency,
      });
    }
    return base;
  }, [formas.data, creditosDisponibles, saldo.currency]);

  const elegida = opciones.find((o) => o.clave === forma) ?? null;
  const monedaCobro = elegida?.currency ?? saldo.currency;
  const esCredito = elegida?.instrument === "saldo_a_favor";
  const esEfectivo = elegida?.instrument.startsWith("efectivo") ?? false;
  const cuentaFija = elegida?.account_id;
  const cuentasEnMoneda = (cuentas.data?.accounts ?? []).filter(
    (a) => a.is_active && a.currency === monedaCobro,
  );

  // La tasa de HOY con su fuente, solo para ENSEÑARLA cuando la moneda del
  // cobro no es la del documento. amount=1: se quiere la tasa, no un cálculo.
  const cruzaMoneda = elegida !== null && monedaCobro !== documentCurrency && !esCredito;
  const tasa = useQuery({
    queryKey: ["tasa-hoy", empresa.id, monedaCobro],
    enabled: cruzaMoneda,
    staleTime: 60_000,
    retry: false,
    queryFn: () => llamar<TasaHoy>(`/v1/exchange-rates/preview?amount=1&currency=${monedaCobro}`),
  });

  function elegirForma(clave: string): void {
    const nueva = opciones.find((o) => o.clave === clave);
    if (nueva === undefined) return;
    // Si la forma nueva vive en OTRA moneda, el importe tecleado deja de
    // significar lo mismo: se limpia (o se pone el saldo si vuelve a la
    // moneda del saldo), nunca se reinterpreta.
    if (nueva.currency !== monedaCobro) {
      setImporte(nueva.currency === saldo.currency ? saldo.amount : "");
    }
    setCuentaId(null);
    if (nueva.instrument === "saldo_a_favor") {
      setCreditoId(creditosDisponibles.length === 1 ? (creditosDisponibles[0]?.id ?? null) : null);
    } else {
      setCreditoId(null);
    }
    setForma(clave);
  }

  const cobrar = useMutation({
    mutationFn: () =>
      llamar<Registrado>("/v1/payments", {
        method: "POST",
        headers: { "Idempotency-Key": llave.current },
        body: JSON.stringify({
          company_id: empresa.id,
          document_id: documentId,
          currency: monedaCobro,
          amount: importe.trim().replace(",", "."),
          instrument: elegida?.instrument,
          ...(referencia.trim() === "" || esEfectivo || esCredito
            ? {}
            : { reference: referencia.trim() }),
          ...(esCredito && creditoId !== null ? { customer_credit_id: creditoId } : {}),
          ...(esCredito
            ? {}
            : cuentaFija !== undefined
              ? { account_id: cuentaFija }
              : cuentaId !== null
                ? { account_id: cuentaId }
                : {}),
        }),
      }),
    onSuccess: (r) => {
      setResultado(r);
      toast.success("Cobro registrado");
      void qc.invalidateQueries({ queryKey: ["statement", empresa.id, customerId] });
    },
  });

  const listo =
    elegida !== null &&
    importeValido(importe.trim().replace(",", ".")) &&
    (!esCredito || creditoId !== null);

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (v) return;
        if (resultado !== null) onCobrado(resultado);
        else onCerrar();
      }}
    >
      <DialogContent className="max-w-md">
        {resultado === null ? (
          <>
            <DialogTitle>Cobrar {etiqueta ?? "el documento"}</DialogTitle>
            <DialogDescription>
              Saldo pendiente: {mostrarImporte(saldo)}. Puede ser un abono: lo que se cobre se resta
              de la deuda.
            </DialogDescription>
            <div className="space-y-3 pt-2">
              <FormField label="¿Cómo pagó?" required>
                {(p) => (
                  <SimpleSelect
                    id={p.id}
                    value={forma}
                    onValueChange={elegirForma}
                    options={opciones.map((o) => ({ value: o.clave, label: o.etiqueta }))}
                    placeholder={formas.isPending ? "Cargando formas…" : "Elige la forma de pago"}
                  />
                )}
              </FormField>

              {esCredito && (
                <FormField label="Saldo a favor a aplicar" required>
                  {(p) => (
                    <SimpleSelect
                      id={p.id}
                      value={creditoId}
                      onValueChange={setCreditoId}
                      options={creditosDisponibles.map((c) => ({
                        value: c.id,
                        label: `${mostrarImporte({ amount: c.amount, currency: saldo.currency })} · aplicado ${mostrarImporte({ amount: c.applied_amount, currency: saldo.currency })}`,
                      }))}
                      placeholder="¿Qué saldo a favor?"
                    />
                  )}
                </FormField>
              )}

              <FormField
                label="¿Cuánto pagó?"
                required
                {...(cruzaMoneda
                  ? { hint: "En la moneda con la que pagó; el sistema convierte a la tasa de hoy." }
                  : {})}
              >
                {(p) => (
                  <MoneyInput
                    id={p.id}
                    ariaInvalid={p["aria-invalid"]}
                    ariaDescribedby={p["aria-describedby"]}
                    value={importe}
                    onChange={setImporte}
                    currency={monedaCobro === "VES" ? "Bs." : monedaCobro}
                  />
                )}
              </FormField>

              {elegida !== null && !esEfectivo && !esCredito && (
                <FormField label="Referencia" hint="La del comprobante del pago, si la tienes.">
                  {(p) => (
                    <Input
                      id={p.id}
                      className="font-mono"
                      value={referencia}
                      onChange={(e) => setReferencia(e.target.value)}
                    />
                  )}
                </FormField>
              )}

              {elegida !== null &&
                !esCredito &&
                cuentaFija === undefined &&
                cuentasEnMoneda.length > 0 && (
                  <FormField
                    label="¿A qué cuenta entra?"
                    hint="Si no eliges, queda en «Sin asignar» hasta que se redistribuya."
                  >
                    {(p) => (
                      <SimpleSelect
                        id={p.id}
                        value={cuentaId}
                        onValueChange={setCuentaId}
                        options={cuentasEnMoneda.map((a) => ({
                          value: a.id,
                          label: `${a.name} (${a.currency})`,
                        }))}
                        placeholder="Que la resuelva el sistema"
                      />
                    )}
                  </FormField>
                )}

              {cruzaMoneda && tasa.data !== undefined && (
                <div className="rounded-md border border-info/30 bg-info-soft px-3 py-2 text-[0.85rem]">
                  <p className="font-medium text-info-soft-foreground">
                    Tasa de hoy: {mostrarCantidad(tasa.data.rate)} ({tasa.data.source},{" "}
                    {fechaLocal(tasa.data.rate_date)})
                  </p>
                  {tasaEmision !== null && tasaEmision.rate !== tasa.data.rate && (
                    <p className="mt-1 flex items-center gap-1.5 font-mono text-[0.8rem] text-muted-foreground tabular-nums">
                      emisión {mostrarCantidad(tasaEmision.rate)} ({tasaEmision.source})
                      <ArrowRight className="size-3" />
                      hoy {mostrarCantidad(tasa.data.rate)}
                    </p>
                  )}
                  <p className="mt-1 text-muted-foreground">
                    El importe convertido y el diferencial los calcula el servidor al registrar.
                  </p>
                </div>
              )}
              {cruzaMoneda && tasa.isError && (
                <p className="text-[0.85rem] text-warning-soft-foreground">
                  {errorDePersona(tasa.error)}
                </p>
              )}

              {cobrar.isError && <ErrorDeCobro error={cobrar.error} />}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={onCerrar} disabled={cobrar.isPending}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                disabled={!listo || cobrar.isPending}
                onClick={() => cobrar.mutate()}
              >
                {cobrar.isPending ? "Registrando…" : "Registrar cobro"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogTitle>Cobro registrado</DialogTitle>
            <DialogDescription>
              Lo que el servidor confirmó, tal como lo escribió.
            </DialogDescription>
            <div className="mt-3 space-y-2 text-[0.9rem]">
              <Fila etiqueta="Cobrado">
                <span className="font-mono">
                  {mostrarImporte({
                    amount: resultado.payment.amount,
                    currency: resultado.payment.currency,
                  })}
                </span>
              </Fila>
              <Fila etiqueta="Saldo restante">
                <span className="font-mono">
                  {mostrarImporte({ amount: resultado.balance, currency: saldo.currency })}
                </span>
              </Fila>
              <Fila etiqueta="Estado del documento">
                <FiscalStatusBadge estado={resultado.document_status} />
              </Fila>
              {resultado.igtf !== null && (
                <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-[0.85rem] text-warning-soft-foreground">
                  Se cobró además{" "}
                  <span className="font-mono">
                    {mostrarImporte({
                      amount: resultado.igtf.amount,
                      currency: resultado.igtf.currency,
                    })}
                  </span>{" "}
                  de IGTF (
                  {mostrarImporte({
                    amount: resultado.igtf.functional_amount,
                    currency: saldo.currency,
                  })}
                  ).
                </p>
              )}
              {resultado.exchange_difference !== null ? (
                <ExchangeDiffIndicator
                  variant="detail"
                  difference={resultado.exchange_difference.difference}
                  currency={saldo.currency}
                  rateIssue={resultado.exchange_difference.fx_rate_issue}
                  ratePayment={resultado.exchange_difference.fx_rate_payment}
                />
              ) : (
                <p className="text-[0.85rem] text-muted-foreground">
                  Sin diferencial cambiario en este cobro.
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="primary" onClick={() => onCobrado(resultado)}>
                Listo
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * El error DENTRO del diálogo: los de la API con su guía de puesta a punto
 * (MensajeError sabe llevar a la casilla que falta); cualquier otro, en voz
 * de persona — nunca un `e.message` crudo.
 */
function ErrorDeCobro({ error }: { error: unknown }): React.JSX.Element {
  if (error instanceof LlamadaApiError) return <MensajeError error={error} />;
  return (
    <p role="alert" className="text-[0.88rem] text-destructive-soft-foreground">
      {errorDePersona(error)}
    </p>
  );
}

function Fila({
  etiqueta,
  children,
}: {
  etiqueta: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{etiqueta}</span>
      <span>{children}</span>
    </div>
  );
}
