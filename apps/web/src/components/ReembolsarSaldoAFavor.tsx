import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useSesion } from "../app/session.js";
import { errorDePersona, LlamadaApiError } from "../lib.js";
import { conLlaveDeIntento } from "../llave-intento.js";
import { abrirPdf } from "../pdf.js";
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
import { FormField, MoneyInput, importeLimpio, importeValido } from "./forms.js";
import { mostrarImporte } from "../money.js";

/**
 * G-15: DEVOLVER EN DINERO un saldo a favor que ya existe (de una nota de crédito, de una
 * devolución o de un pago de más). Exige `sales.refund`, que es lo que comprueba el servidor.
 *
 * El saldo a favor vive en la moneda del documento que lo originó (G-05). El dinero sale de la
 * cuenta que se elija, EN LA MONEDA DE ESA CUENTA y a la tasa del día: la conversión, el
 * diferencial y el asiento los hace el servidor. Aquí no se calcula nada — ni siquiera «cuánto
 * queda»: por omisión se devuelve TODO lo disponible (`whole`), y eso también lo decide el
 * servidor. El cuerpo lleva `whole` o `amount`, nunca los dos.
 *
 * D-11, como en toda salida de dinero: si la cuenta no alcanza, el servidor responde 409 y dice
 * qué hacer. Aquí se ofrece lo mismo que dice: elegir otra cuenta o —solo a quien tiene
 * `treasury.overdraft`— registrarlo igual con su motivo, que queda en el historial.
 */
interface CuentaTesoreria {
  id: string;
  name: string;
  currency: string;
  is_active: boolean;
}
interface Reembolso {
  id: string;
  amount: string;
  currency: string;
  paid_amount: string;
  paid_currency: string;
  fx_rate: string;
  exchange_difference: string;
  credit_remaining: string;
}

/** El mínimo que exige el servidor para el motivo de un sobregiro (lo vuelve a comprobar él). */
const MOTIVO_SOBREGIRO_MINIMO = 5;

export function ReembolsarSaldoAFavor({
  creditId,
  moneda,
  onCerrar,
  onReembolsado,
}: {
  creditId: string;
  /** La moneda del saldo a favor. */
  moneda: string;
  onCerrar: () => void;
  onReembolsado: () => void;
}): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const toast = useToast();
  const [cuentaId, setCuentaId] = useState<string | null>(null);
  const [todo, setTodo] = useState(true);
  const [importe, setImporte] = useState("");
  const [motivo, setMotivo] = useState("");
  const [porQueSobregiro, setPorQueSobregiro] = useState("");
  const [resultado, setResultado] = useState<Reembolso | null>(null);
  // Por intento (ADR-0076): un 4xx estrena la llave, así «registrarlo igual» —otro cuerpo— viaja
  // con la suya; un fallo de red la conserva y no se reembolsa dos veces.
  const llave = useRef(crypto.randomUUID());

  const cuentas = useQuery({
    queryKey: ["cuentas-tesoreria", empresa.id],
    staleTime: 60_000,
    queryFn: () => llamar<{ accounts: CuentaTesoreria[] }>("/v1/treasury/accounts"),
  });
  const activas = (cuentas.data?.accounts ?? []).filter((a) => a.is_active);
  const cuenta = activas.find((a) => a.id === cuentaId) ?? null;

  const reembolsar = useMutation({
    mutationFn: (sobregirar: boolean) =>
      conLlaveDeIntento(llave, (k) =>
        llamar<Reembolso>(`/v1/customer-credits/${creditId}/refunds`, {
          method: "POST",
          headers: { "Idempotency-Key": k },
          body: JSON.stringify({
            company_id: empresa.id,
            account_id: cuentaId,
            // EXACTAMENTE uno: todo lo disponible, o el importe tecleado.
            ...(todo ? { whole: true } : { amount: importeLimpio(importe) }),
            reason: motivo.trim(),
            ...(sobregirar
              ? { allow_negative_balance: true, overdraft_reason: porQueSobregiro.trim() }
              : {}),
          }),
        }),
      ),
    onSuccess: (r) => {
      setResultado(r);
      toast.success("Saldo a favor devuelto");
    },
  });

  const listo = cuentaId !== null && motivo.trim().length >= 3 && (todo || importeValido(importe));
  const mon = (c: string): string => (c === "VES" ? "Bs." : c);
  const sinSaldo =
    reembolsar.error instanceof LlamadaApiError &&
    reembolsar.error.body.code === "INSUFFICIENT_FUNDS";
  const puedeSobregirar = puede("treasury.overdraft");

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (v) return;
        if (resultado !== null) onReembolsado();
        else onCerrar();
      }}
    >
      <DialogContent className="max-w-md">
        {resultado === null ? (
          <>
            <DialogTitle>Devolver el saldo a favor en dinero</DialogTitle>
            <DialogDescription>
              El saldo a favor está en {mon(moneda)}. El dinero sale de la cuenta que elijas, en la
              moneda de esa cuenta y a la tasa de hoy. Esto no se puede deshacer.
            </DialogDescription>
            <div className="space-y-3 pt-2">
              <FormField label="¿De qué cuenta sale el dinero?" required>
                {(p) => (
                  <SimpleSelect
                    id={p.id}
                    value={cuentaId}
                    onValueChange={(v) => {
                      setCuentaId(v);
                      // Otra cuenta es otro intento: el aviso de «no alcanza» era de la anterior.
                      reembolsar.reset();
                    }}
                    options={activas.map((a) => ({
                      value: a.id,
                      label: `${a.name} (${mon(a.currency)})`,
                    }))}
                    placeholder={cuentas.isPending ? "Cargando cuentas…" : "Elige la cuenta"}
                  />
                )}
              </FormField>
              {cuentas.isError && (
                <p role="alert" className="text-[0.85rem] text-destructive-soft-foreground">
                  {errorDePersona(cuentas.error)}
                </p>
              )}
              <label className="flex items-center gap-2 text-[0.9rem]">
                <input type="checkbox" checked={todo} onChange={(e) => setTodo(e.target.checked)} />
                Devolver todo lo que queda disponible
              </label>
              {!todo && (
                <FormField
                  label="¿Cuánto se devuelve?"
                  required
                  hint={`En la moneda del saldo a favor (${mon(moneda)}).`}
                >
                  {(p) => (
                    <MoneyInput
                      id={p.id}
                      ariaInvalid={p["aria-invalid"]}
                      ariaDescribedby={p["aria-describedby"]}
                      value={importe}
                      onChange={setImporte}
                      currency={mon(moneda)}
                    />
                  )}
                </FormField>
              )}
              <FormField label="Motivo" required hint="Queda en el acta del reembolso.">
                {(p) => (
                  <Input
                    id={p.id}
                    aria-describedby={p["aria-describedby"]}
                    value={motivo}
                    maxLength={300}
                    onChange={(e) => setMotivo(e.target.value)}
                  />
                )}
              </FormField>
              {cuenta !== null && cuenta.currency !== moneda && (
                <p className="rounded-md border border-info/30 bg-info-soft px-3 py-2 text-[0.85rem] text-info-soft-foreground">
                  La cuenta está en {mon(cuenta.currency)} y el saldo a favor en {mon(moneda)}: el
                  sistema convierte a la tasa BCV de hoy y te dice cuánto salió.
                </p>
              )}
              {reembolsar.isError && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-[0.88rem] text-destructive-soft-foreground"
                >
                  <p>{errorDePersona(reembolsar.error)}</p>
                  {/* D-11: la cuenta no alcanza. El servidor ya dijo qué hacer; aquí se ofrece. */}
                  {sinSaldo && puedeSobregirar && (
                    <div className="mt-2 space-y-2">
                      <FormField
                        label="¿Por qué se registra sin saldo?"
                        hint="Queda en el historial de la cuenta."
                      >
                        {(p) => (
                          <Input
                            id={p.id}
                            aria-describedby={p["aria-describedby"]}
                            value={porQueSobregiro}
                            maxLength={300}
                            onChange={(e) => setPorQueSobregiro(e.target.value)}
                          />
                        )}
                      </FormField>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={
                          porQueSobregiro.trim().length < MOTIVO_SOBREGIRO_MINIMO ||
                          reembolsar.isPending
                        }
                        onClick={() => reembolsar.mutate(true)}
                      >
                        Registrarlo igual y dejar la cuenta en negativo
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={onCerrar} disabled={reembolsar.isPending}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                disabled={!listo || reembolsar.isPending}
                onClick={() => reembolsar.mutate(false)}
              >
                {reembolsar.isPending ? "Registrando…" : "Devolver el dinero"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogTitle>Reembolso registrado</DialogTitle>
            <DialogDescription>
              Lo que el servidor confirmó, tal como lo escribió.
            </DialogDescription>
            <div className="mt-3 space-y-2 text-[0.9rem]">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">Se devolvió del saldo a favor</span>
                <span className="font-mono">
                  {mostrarImporte({ amount: resultado.amount, currency: resultado.currency })}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">Salió de la cuenta</span>
                <span className="font-mono">
                  {mostrarImporte({
                    amount: resultado.paid_amount,
                    currency: resultado.paid_currency,
                  })}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">Queda de saldo a favor</span>
                <span className="font-mono">
                  {mostrarImporte({
                    amount: resultado.credit_remaining,
                    currency: resultado.currency,
                  })}
                </span>
              </div>
            </div>
            <DialogFooter>
              {/* G-15: el documento de reembolso, para imprimir y que el cliente firme. */}
              <Button
                variant="ghost"
                onClick={() =>
                  void abrirPdf(`/v1/customer-refunds/${resultado.id}/pdf`, empresa.id, (m) =>
                    toast.error("No se pudo abrir el comprobante", m),
                  )
                }
              >
                Imprimir el comprobante
              </Button>
              <Button variant="primary" onClick={onReembolsado}>
                Listo
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
