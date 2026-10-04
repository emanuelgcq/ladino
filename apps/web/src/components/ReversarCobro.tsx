import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useSesion } from "../app/session.js";
import { errorDePersona, LlamadaApiError } from "../lib.js";
import { conLlaveDeIntento } from "../llave-intento.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../ui/dialog.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { useToast } from "../ui/toast.js";
import { FormField } from "./forms.js";
import { FiscalStatusBadge } from "./FiscalStatusBadge.js";
import { mostrarImporte } from "../money.js";
import { textoDeDeuda } from "./deuda.js";

/**
 * LA REVERSA DE UN COBRO o de una retención soportada (ADR-0075 §8; R-61). La pantalla que la
 * ola 3 dejó sin hacer: los dos endpoints existían, y nadie podía llegar a ellos.
 *
 * Es una acción irreversible (apps/web/CLAUDE.md): antes de confirmar se dice EN LLANO qué va a
 * pasar —el saldo vuelve a deber, la caja baja, el IGTF queda pendiente de reintegro— y se pide
 * el motivo, que queda en el acta. Después se enseña lo que el SERVIDOR confirmó, tal cual: aquí
 * no se calcula nada.
 *
 * Los rechazos se dicen con su mensaje de persona, no con un código:
 *   · IGTF_NOTE_ISSUED — el IGTF de ese cobro se documentó con una nota de débito ya emitida;
 *   · PAYMENT_ALREADY_REVERSED — el cobro ya se reversó (o el comprobante ya está anulado);
 *   · RETENTION_PERIOD_DECLARED — el comprobante ya entró en una declaración.
 */
interface Reversa {
  id: string;
  currency: string;
  amount: string;
  functional_amount: string;
  document: { id: string; status: string };
  debt: {
    currency: string;
    nominal: string | null;
    functional_currency: string;
    functional_today: string | null;
  } | null;
  igtf: { currency: string; restituted_amount: string; absorbed: boolean } | null;
}

/** Lo que dice cada rechazo conocido, además del mensaje del servidor: qué hacer ahora. */
const QUE_HACER: Record<string, string> = {
  IGTF_NOTE_ISSUED:
    "El IGTF de este cobro ya se documentó con una nota de débito, que es un documento fiscal emitido: este cobro no se reversa desde aquí. Habla con quien lleva la contabilidad.",
  PAYMENT_ALREADY_REVERSED: "No hay nada más que reversar: cierra y revisa la lista de cobros.",
  RETENTION_PERIOD_DECLARED:
    "El comprobante ya entró en una declaración de IVA: no se anula. Lo corrige quien lleva la contabilidad, en el período corriente.",
  PERIOD_CLOSED:
    "El período contable de hoy está cerrado. Hay que reabrirlo, o esperar al siguiente, para reversar.",
};

const MOTIVO_MINIMO = 10;

export function ReversarCobro({
  tipo,
  id,
  importe,
  conIgtf,
  onCerrar,
  onReversado,
}: {
  /** Un cobro, o el abono de un comprobante de retención de IVA que nos practicaron. */
  tipo: "cobro" | "retencion";
  /** El id del cobro, o el del comprobante de retención. */
  id: string;
  /** Lo que se cobró, como lo dijo el servidor. */
  importe: { amount: string; currency: string };
  /** Si el servidor dijo que este cobro percibió IGTF (se enseña la consecuencia). */
  conIgtf?: boolean;
  onCerrar: () => void;
  onReversado: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [motivo, setMotivo] = useState("");
  const [resultado, setResultado] = useState<Reversa | null>(null);
  const llave = useRef(crypto.randomUUID());
  const esRetencion = tipo === "retencion";

  const reversar = useMutation({
    mutationFn: () =>
      conLlaveDeIntento(llave, (k) =>
        llamar<Reversa>(
          esRetencion ? `/v1/supported-retentions/${id}/reversal` : `/v1/payments/${id}/reversal`,
          {
            method: "POST",
            headers: { "Idempotency-Key": k },
            body: JSON.stringify({ company_id: empresa.id, reason: motivo.trim() }),
          },
        ),
      ),
    onSuccess: (r) => {
      setResultado(r);
      toast.success(esRetencion ? "Retención reversada" : "Cobro reversado");
    },
  });

  const faltan = MOTIVO_MINIMO - motivo.trim().length;
  const error = reversar.error;
  const codigo = error instanceof LlamadaApiError ? error.body.code : null;

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (v) return;
        if (resultado !== null) onReversado();
        else onCerrar();
      }}
    >
      <DialogContent className="max-w-md">
        {resultado === null ? (
          <>
            <DialogTitle>
              {esRetencion ? "Reversar la retención" : "Reversar el cobro"} de{" "}
              {mostrarImporte(importe)}
            </DialogTitle>
            <DialogDescription>
              Esto no se puede deshacer: queda registrado con tu nombre y el motivo.
            </DialogDescription>
            <div className="space-y-3 pt-2">
              <ul className="list-disc space-y-1 pl-5 text-[0.88rem] text-muted-foreground">
                <li>
                  El documento vuelve a deber lo que este {esRetencion ? "abono" : "cobro"} pagó.
                </li>
                {esRetencion ? (
                  <li>
                    El comprobante de retención queda anulado. Si hay que corregirlo, se vuelve a
                    cargar con los datos correctos.
                  </li>
                ) : (
                  <li>
                    El dinero sale de la cuenta donde entró. Si ya se gastó, esa cuenta queda en
                    negativo y se ve.
                  </li>
                )}
                {!esRetencion && (
                  <li>
                    Si el cliente pagó de más, el saldo a favor que ese cobro le dejó se retira:
                    deja de estar a su nombre. Si ya lo usó, el cobro no se puede reversar.
                  </li>
                )}
                {!esRetencion && conIgtf !== false && (
                  <li>
                    Si este cobro percibió IGTF, ese IGTF se le devuelve al cliente y queda
                    pendiente de reintegro.
                  </li>
                )}
                <li>
                  En la contabilidad se hace el asiento contrario, con fecha de hoy. El cobro no se
                  borra: queda marcado como reversado.
                </li>
              </ul>
              <FormField
                label="¿Por qué se reversa?"
                required
                hint={
                  faltan > 0
                    ? `Explícalo en al menos ${MOTIVO_MINIMO} letras (faltan ${faltan}).`
                    : "Queda en el acta."
                }
              >
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
              {reversar.isError && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-[0.88rem] text-destructive-soft-foreground"
                >
                  <p>{errorDePersona(error)}</p>
                  {codigo !== null && QUE_HACER[codigo] !== undefined && (
                    <p className="mt-1">{QUE_HACER[codigo]}</p>
                  )}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={onCerrar} disabled={reversar.isPending}>
                No reversar
              </Button>
              <Button
                variant="destructive"
                disabled={faltan > 0 || reversar.isPending}
                onClick={() => reversar.mutate()}
              >
                {reversar.isPending
                  ? "Reversando…"
                  : esRetencion
                    ? "Reversar la retención"
                    : "Reversar el cobro"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogTitle>{esRetencion ? "Retención reversada" : "Cobro reversado"}</DialogTitle>
            <DialogDescription>
              Lo que el servidor confirmó, tal como lo escribió.
            </DialogDescription>
            <div className="mt-3 space-y-2 text-[0.9rem]">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">
                  {esRetencion ? "Abono reversado" : "Salió de la cuenta"}
                </span>
                <span className="font-mono">
                  {mostrarImporte({ amount: resultado.amount, currency: resultado.currency })}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">El documento vuelve a deber</span>
                <span className="font-mono">
                  {resultado.debt === null
                    ? "Míralo en el documento"
                    : resultado.debt.currency !== resultado.debt.functional_currency &&
                        resultado.debt.nominal !== null
                      ? `${mostrarImporte({ amount: resultado.debt.nominal, currency: resultado.debt.currency })} · ${textoDeDeuda(resultado.debt.functional_today, resultado.debt.functional_currency)}`
                      : textoDeDeuda(
                          resultado.debt.functional_today,
                          resultado.debt.functional_currency,
                        )}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">Estado del documento</span>
                <FiscalStatusBadge estado={resultado.document.status} />
              </div>
              {resultado.igtf !== null && (
                <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-[0.85rem] text-warning-soft-foreground">
                  IGTF pendiente de reintegro:{" "}
                  <span className="font-mono">
                    {mostrarImporte({
                      amount: resultado.igtf.restituted_amount,
                      currency: resultado.igtf.currency,
                    })}
                  </span>
                  {resultado.igtf.absorbed
                    ? ". La empresa lo había asumido: no se le devuelve al cliente."
                    : ". Se le devolvió al cliente con el cobro."}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="primary" onClick={onReversado}>
                Listo
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
