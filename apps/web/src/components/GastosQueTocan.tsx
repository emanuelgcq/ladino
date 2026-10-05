import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { useSesion } from "../app/session.js";
import { conLlaveDeIntento } from "../llave-intento.js";
import { mostrarImporte } from "../money.js";
import { Button } from "../ui/button.js";
import { Card } from "../ui/card.js";
import { useToast } from "../ui/toast.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

/**
 * LOS GASTOS QUE SE REPITEN (H-07). El servidor decide cuál TOCA (`is_due`: el día de Caracas
 * contra el día del recordatorio); aquí solo se enseña y se ofrecen las tres salidas:
 * registrarlo ahora (por el formulario de siempre, con los datos de la última vez), omitirlo
 * esta vez, o dejar de avisar. Ningún importe ni fecha se calcula aquí: llegan como texto.
 *
 * Omitir y dejar de avisar NO se deshacen (los períodos son append-only; un recordatorio
 * detenido no se toca): las dos pasan por una confirmación que dice qué va a pasar.
 */
export interface GastoQueSeRepite {
  id: string;
  category: string;
  description: string | null;
  account_id: string | null;
  supplier_id: string | null;
  suggested_amount: string | null;
  currency: string | null;
  with_invoice: boolean;
  periodicity: "weekly" | "semimonthly" | "monthly" | "yearly";
  next_due_on: string;
  /** El período que sigue a `next_due_on` (lo calcula el servidor). */
  following_due_on: string;
  is_due: boolean;
  days_overdue: number;
  status: "active" | "stopped";
}

export const CADA_CUANTO: readonly (readonly [GastoQueSeRepite["periodicity"], string])[] = [
  ["monthly", "Cada mes"],
  ["semimonthly", "Cada quincena (dos veces al mes)"],
  ["weekly", "Cada semana"],
  ["yearly", "Cada año"],
];

/** `2026-10-31` → `31/10/2026`. Es un DÍA, no un instante: se reordena el texto, sin `Date`. */
export function diaDeCalendario(dia: string): string {
  const [a, m, d] = dia.split("-");
  return a !== undefined && m !== undefined && d !== undefined ? `${d}/${m}/${a}` : dia;
}

/** Cuándo toca, en palabras. Los días de atraso los cuenta el servidor. */
export function cuandoToca(g: Pick<GastoQueSeRepite, "next_due_on" | "days_overdue">): string {
  if (g.days_overdue === 0) return "toca hoy";
  if (g.days_overdue === 1) return "tocaba ayer";
  return `tocaba el ${diaDeCalendario(g.next_due_on)}`;
}

/** Los gastos que se repiten de la empresa. Solo para quien ve los gastos. */
export function useGastosQueSeRepiten(): {
  todos: GastoQueSeRepite[];
  tocan: GastoQueSeRepite[];
} {
  const { empresa, llamar, puede } = useSesion();
  const consulta = useQuery({
    queryKey: ["gastos-que-se-repiten", empresa.id],
    enabled: puede("expense.read"),
    staleTime: 60_000,
    retry: false,
    queryFn: () => llamar<{ items: GastoQueSeRepite[] }>("/v1/recurring-expenses"),
  });
  const todos = consulta.data?.items ?? [];
  return { todos, tocan: todos.filter((g) => g.is_due) };
}

export function GastosQueTocan({
  onRegistrar,
}: {
  /** Abre el formulario de gasto con los datos de este recordatorio. */
  onRegistrar: (g: GastoQueSeRepite) => void;
}): React.JSX.Element | null {
  const { empresa, llamar, puede } = useSesion();
  const qc = useQueryClient();
  const toast = useToast();
  const { todos, tocan } = useGastosQueSeRepiten();
  const puedeRegistrar = puede("expense.register");
  // Lo que se está por confirmar. Cada confirmación abierta es UN intento con su llave: se
  // conserva si la red falla (el reintento no repite el efecto) y se estrena tras un 4xx.
  const [pendiente, setPendiente] = useState<{
    g: GastoQueSeRepite;
    que: "skip" | "stop";
  } | null>(null);
  const llave = useRef(crypto.randomUUID());
  const pedir = (g: GastoQueSeRepite, que: "skip" | "stop"): void => {
    llave.current = crypto.randomUUID();
    setPendiente({ g, que });
  };

  const confirmar = async (): Promise<void> => {
    if (pendiente === null) return;
    const { g, que } = pendiente;
    try {
      const despues = await conLlaveDeIntento(llave, (k) =>
        llamar<GastoQueSeRepite>(`/v1/recurring-expenses/${g.id}/${que}`, {
          method: "POST",
          headers: { "Idempotency-Key": k },
          body: JSON.stringify(
            que === "skip"
              ? { company_id: empresa.id, due_on: g.next_due_on }
              : { company_id: empresa.id },
          ),
        }),
      );
      toast.success(
        que === "skip" ? "Omitido esta vez" : "Ya no se avisa",
        que === "skip"
          ? `${g.category}: el próximo aviso es el ${diaDeCalendario(despues.next_due_on)}.`
          : `${g.category} deja de recordarse. Los gastos ya anotados siguen en la lista.`,
      );
      setPendiente(null);
    } finally {
      // Pase lo que pase se vuelve a leer: un 409 significa que la lista en pantalla era vieja.
      void qc.invalidateQueries({ queryKey: ["gastos-que-se-repiten", empresa.id] });
    }
  };

  if (todos.length === 0) return null;
  const proximos = todos.filter((g) => !g.is_due);

  return (
    <Card className="mb-3 space-y-2 p-3" aria-label="Gastos que se repiten">
      <p className="flex items-center gap-2 text-[0.9rem] font-medium">
        <CalendarClock className="size-4" />
        {tocan.length === 0
          ? "Gastos que se repiten: ninguno toca todavía"
          : tocan.length === 1
            ? "Toca pagar 1 gasto que se repite"
            : `Toca pagar ${tocan.length} gastos que se repiten`}
      </p>
      {tocan.map((g) => (
        <div
          key={g.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
        >
          <div className="min-w-0">
            <p className="truncate font-medium">{g.category}</p>
            <p className="text-[0.82rem] text-muted-foreground">
              {cuandoToca(g)}
              {g.suggested_amount !== null && g.currency !== null
                ? ` · la última vez: ${mostrarImporte({ amount: g.suggested_amount, currency: g.currency })}`
                : ""}
            </p>
          </div>
          {puedeRegistrar && (
            <div className="flex flex-wrap gap-1.5">
              <Button variant="primary" size="sm" onClick={() => onRegistrar(g)}>
                Registrar ahora
              </Button>
              <Button variant="secondary" size="sm" onClick={() => pedir(g, "skip")}>
                Omitir esta vez
              </Button>
              <Button variant="ghost" size="sm" onClick={() => pedir(g, "stop")}>
                Ya no se paga
              </Button>
            </div>
          )}
        </div>
      ))}
      {proximos.length > 0 && (
        <ul className="space-y-0.5 text-[0.82rem] text-muted-foreground">
          {proximos.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {g.category} · {CADA_CUANTO.find(([c]) => c === g.periodicity)?.[1].toLowerCase()} ·
                toca el {diaDeCalendario(g.next_due_on)}
              </span>
              {puedeRegistrar && (
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={() => pedir(g, "stop")}
                >
                  Ya no se paga
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={pendiente !== null}
        onOpenChange={(v) => !v && setPendiente(null)}
        title={
          pendiente?.que === "stop"
            ? `¿${pendiente.g.category} ya no se paga?`
            : `¿Omitir esta vez ${pendiente?.g.category ?? ""}?`
        }
        confirmLabel={pendiente?.que === "stop" ? "Dejar de avisarme" : "Omitir este pago"}
        destructive={pendiente?.que === "stop"}
        onConfirm={confirmar}
      >
        {pendiente?.que === "stop" ? (
          <p>
            Dejaremos de avisarte de este gasto. No se deshace: si vuelve, lo registras otra vez y
            marcas que se repite. Los gastos ya anotados siguen en la lista.
          </p>
        ) : pendiente !== null ? (
          <p>
            No te avisaremos de este pago ({cuandoToca(pendiente.g)}) y no se anota ningún gasto. No
            se deshace. El siguiente toca el {diaDeCalendario(pendiente.g.following_due_on)}.
          </p>
        ) : null}
      </ConfirmDialog>
    </Card>
  );
}
