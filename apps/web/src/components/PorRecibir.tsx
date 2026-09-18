import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, PackageCheck, X } from "lucide-react";
import { useSesion } from "../app/session.js";
import { errorDePersona } from "../lib.js";
import { Button } from "../ui/button.js";
import { Card } from "../ui/card.js";
import { Textarea } from "../ui/input.js";
import { useToast } from "../ui/toast.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { FormField } from "./forms.js";
import { fechaLocal } from "../fechas.js";

/**
 * POR RECIBIR (ADR-0066, entrega iii) — los pedidos que esperan mercancía, en la pantalla de
 * quien la va a recibir.
 *
 * Es la otra mitad de la puerta única: pedir y recibir son dos hechos distintos, y entre uno y
 * otro el pedido tiene que estar A LA VISTA de quien abre la caja. Sin esta bandeja, «Hacer un
 * pedido» sería un formulario que no lleva a ninguna parte y la recepción a ciegas no existiría:
 * quien recibe tendría que buscar el pedido por su número.
 *
 * Dos verbos, ni uno más: **Ya llegó** abre la puerta con el pedido cargado, y **No va a llegar**
 * lo cierra con su motivo escrito. Cerrar no es borrar — el pedido se queda, con quién lo cerró
 * y por qué.
 */
interface PedidoPendiente {
  id: string;
  order_number: number;
  supplier_id: string;
  supplier_name: string;
  transaction_currency: string;
  expected_at: string | null;
  age_days: number;
}

export function PorRecibir({ compacto = false }: { compacto?: boolean }): React.JSX.Element | null {
  const { empresa, llamar, puede } = useSesion();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [cerrando, setCerrando] = useState<PedidoPendiente | null>(null);
  const [motivo, setMotivo] = useState("");

  const puedeVer = puede("purchase.receive") || puede("purchase.order.manage");
  const puedeRecibir = puede("purchase.receive") && puede("inventory.move");
  const puedeCerrar = puede("purchase.order.manage");

  const pendientes = useQuery({
    queryKey: ["pedidos-pendientes", empresa.id],
    enabled: puedeVer,
    staleTime: 30_000,
    retry: false,
    queryFn: () => llamar<{ items: PedidoPendiente[] }>("/v1/purchase-orders?pending=1"),
  });

  const cerrar = useMutation({
    mutationFn: (p: { id: string; reason: string }) =>
      llamar(`/v1/purchase-orders/${p.id}/close`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id, reason: p.reason }),
      }),
    onSuccess: () => {
      toast.success("Pedido cerrado", "Ya no aparece en «Por recibir».");
      setMotivo("");
      void qc.invalidateQueries({ queryKey: ["pedidos-pendientes", empresa.id] });
      void qc.invalidateQueries({ queryKey: ["compras", empresa.id] });
    },
  });

  const items = pendientes.data?.items ?? [];
  // Sin pedidos esperando no hay bandeja: un bloque vacío que dice «nada por recibir» ocupa el
  // sitio de lo que sí hay que mirar.
  if (!puedeVer || items.length === 0) return null;

  return (
    <section className="space-y-3" aria-labelledby="por-recibir-titulo">
      <div className="flex items-center gap-2">
        <ClipboardList className="size-5 text-accent" />
        <h2 id="por-recibir-titulo" className="font-medium">
          Por recibir
        </h2>
        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[0.78rem] text-accent-soft-foreground tabular-nums">
          {items.length}
        </span>
      </div>

      <div className={compacto ? "space-y-2" : "grid gap-2 sm:grid-cols-2"}>
        {items.map((p) => (
          <Card key={p.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
            <div>
              <p className="font-medium">
                Pedido n.º {p.order_number} · {p.supplier_name}
              </p>
              <p className="text-[0.85rem] text-muted-foreground">
                {p.age_days === 0
                  ? "Pedido hoy"
                  : p.age_days === 1
                    ? "Pedido ayer"
                    : `Pedido hace ${p.age_days} días`}
                {p.expected_at === null ? "" : ` · esperado el ${fechaLocal(p.expected_at)}`}
              </p>
            </div>
            <div className="flex gap-2">
              {puedeRecibir && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void navigate(`/admin/llego-mercancia?pedido=${p.id}`)}
                >
                  <PackageCheck /> Ya llegó
                </Button>
              )}
              {puedeCerrar && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setMotivo("");
                    setCerrando(p);
                  }}
                >
                  <X /> No va a llegar
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>

      {pendientes.isError && (
        <p role="alert" className="text-[0.85rem] text-warning-soft-foreground">
          No se pudo ver qué está por recibir: {errorDePersona(pendientes.error)}
        </p>
      )}

      <ConfirmDialog
        open={cerrando !== null}
        onOpenChange={(v) => !v && setCerrando(null)}
        title="¿Este pedido no va a llegar?"
        confirmLabel="Cerrar el pedido"
        destructive
        confirmDisabled={motivo.trim() === ""}
        onConfirm={async () => {
          if (cerrando === null) return;
          await cerrar.mutateAsync({ id: cerrando.id, reason: motivo.trim() });
          setCerrando(null);
        }}
      >
        <div className="space-y-3 text-left">
          <p>
            Sale de «Por recibir» y deja de esperar mercancía. Lo que ya hayas recibido de él se
            queda como está: cerrar no deshace nada.
          </p>
          <FormField label="¿Por qué no va a llegar?" required hint="Queda escrito en el pedido.">
            {(p) => (
              <Textarea
                {...p}
                rows={2}
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="El proveedor no tenía…"
              />
            )}
          </FormField>
        </div>
      </ConfirmDialog>
    </section>
  );
}
