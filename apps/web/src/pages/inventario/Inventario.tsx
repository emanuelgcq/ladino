import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowLeftRight, ArrowDownToLine, ArrowUpFromLine, Scale, TimerReset } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DataTable } from "../../components/DataTable.js";
import {
  FormField,
  MoneyInput,
  EntityPicker,
  importeValido,
  type EntityOption,
} from "../../components/forms.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { Button } from "../../ui/button.js";
import { Input } from "../../ui/input.js";
import { SimpleSelect } from "../../ui/select.js";
import { Badge } from "../../ui/badge.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card.js";
import { Skeleton } from "../../ui/card.js";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../../ui/tabs.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../ui/dialog.js";
import { useToast } from "../../ui/toast.js";
import { mostrarCantidad, mostrarImporte } from "../../money.js";
import { MensajeError } from "../ventas/comunes.js";
import type {
  ExpiringLot,
  InventoryMove,
  LowStockItem,
  Product,
  RecipeLineView,
  StockBalance,
  Warehouse,
} from "../../lib.js";

/**
 * Inventario — Fase B. Cuatro superficies en pestañas: existencias (con el
 * kardex VIRTUALIZADO por producto), los cuatro movimientos, las alertas de
 * reposición/vencimiento y las recetas de compuestos.
 *
 * CERO aritmética: saldo, valor y costo de cada línea del kardex vienen del
 * movimiento tal como el esquema los calculó y guardó (`quantity_after`,
 * `value_after`, `unit_cost`). Recalcularlos aquí sería una segunda verdad.
 */
type Operacion = "entrada" | "salida" | "ajuste" | "transferencia";

const OPERACION: Record<
  Operacion,
  { etiqueta: string; icono: React.JSX.Element; consecuencia: string; permiso: string }
> = {
  entrada: {
    etiqueta: "Entrada",
    icono: <ArrowDownToLine />,
    permiso: "inventory.move",
    consecuencia:
      "El costo promedio del producto en ese almacén se recalculará. El movimiento no se puede editar ni borrar después.",
  },
  salida: {
    etiqueta: "Salida",
    icono: <ArrowUpFromLine />,
    permiso: "inventory.move",
    consecuencia:
      "Se valorará al costo promedio vigente, que calcula el servidor. Si dejara la existencia en negativo se rechaza, salvo permiso expreso.",
  },
  ajuste: {
    etiqueta: "Ajuste",
    icono: <Scale />,
    permiso: "inventory.adjust",
    consecuencia:
      "Queda en la auditoría con tu nombre y su motivo. Un ajuste sin motivo no es un ajuste.",
  },
  transferencia: {
    etiqueta: "Transferencia",
    icono: <ArrowLeftRight />,
    permiso: "inventory.transfer",
    consecuencia:
      "Sale y entra en el mismo instante, al costo de origen: no hay estado «en tránsito». Necesitas permiso sobre los dos almacenes.",
  },
};

export function Inventario(): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const [busqueda, setBusqueda] = useState("");
  const [almacen, setAlmacen] = useState("");
  const [operacion, setOperacion] = useState<Operacion | null>(null);
  const [kardexDe, setKardexDe] = useState<StockBalance | null>(null);
  const qc = useQueryClient();

  const almacenes = useQuery({
    queryKey: ["almacenes", empresa.id],
    queryFn: () => llamar<Warehouse[]>("/v1/warehouses"),
  });

  const stock = useQuery({
    queryKey: ["stock", empresa.id, busqueda, almacen],
    queryFn: () => {
      const p = new URLSearchParams();
      if (busqueda.trim() !== "") p.set("search", busqueda.trim());
      if (almacen !== "") p.set("warehouse_id", almacen);
      return llamar<{ items: StockBalance[] }>(`/v1/inventory/stock?${p.toString()}`);
    },
  });

  const recargar = () => {
    void qc.invalidateQueries({ queryKey: ["stock", empresa.id] });
    void qc.invalidateQueries({ queryKey: ["alertas-inv", empresa.id] });
  };

  const columnas = useMemo<ColumnDef<StockBalance, unknown>[]>(
    () => [
      { id: "almacen", header: "Almacén", accessorKey: "warehouse_code" },
      {
        id: "sku",
        header: "SKU",
        accessorKey: "product_sku",
        cell: (c) => <span className="font-mono text-[0.84rem]">{c.getValue<string>()}</span>,
      },
      { id: "producto", header: "Producto", accessorKey: "product_name" },
      {
        id: "lote",
        header: "Lote",
        enableSorting: false,
        accessorFn: (b) => b.lot_code ?? "—",
      },
      {
        id: "cantidad",
        header: () => <span className="block text-right">Cantidad</span>,
        accessorKey: "quantity",
        enableSorting: false,
        cell: (c) => (
          <span className="block text-right font-mono text-[0.84rem]">
            {mostrarCantidad(c.getValue<string>())}
          </span>
        ),
      },
      {
        id: "valor",
        header: () => <span className="block text-right">Valor</span>,
        enableSorting: false,
        accessorKey: "value",
        cell: (c) => (
          <span className="block text-right font-mono text-[0.84rem]">
            {mostrarImporte({ amount: c.row.original.value, currency: c.row.original.currency })}
          </span>
        ),
      },
      {
        id: "costo",
        header: () => <span className="block text-right">Costo unit.</span>,
        enableSorting: false,
        accessorKey: "last_unit_cost",
        cell: (c) => (
          <span className="block text-right font-mono text-[0.84rem]">
            {mostrarImporte({
              amount: c.row.original.last_unit_cost,
              currency: c.row.original.currency,
            })}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div>
      <PageHeader
        title="Inventario"
        description="Existencias al costo promedio ponderado del servidor; cada movimiento es un hecho que no se edita."
        actions={
          <div className="flex gap-2">
            {/* ADR-0048: cada verbo aparece según el rol; el servidor decide. */}
            {(Object.keys(OPERACION) as Operacion[])
              .filter((op) => puede(OPERACION[op].permiso))
              .map((op) => (
                <Button
                  key={op}
                  variant={op === "entrada" ? "primary" : "secondary"}
                  size="sm"
                  onClick={() => setOperacion(op)}
                >
                  {OPERACION[op].icono} {OPERACION[op].etiqueta}
                </Button>
              ))}
          </div>
        }
      />

      <Tabs defaultValue="existencias">
        <TabsList className="mb-3">
          <TabsTab value="existencias">Existencias</TabsTab>
          <TabsTab value="alertas">Alertas</TabsTab>
          <TabsTab value="recetas">Recetas</TabsTab>
        </TabsList>

        <TabsPanel value="existencias">
          <DataTable
            columns={columnas}
            data={stock.data?.items}
            error={stock.error instanceof Error ? stock.error.message : null}
            onRetry={() => void stock.refetch()}
            onRowClick={setKardexDe}
            density="compact"
            exportCsv={{ filename: `existencias-${empresa.tax_id}.csv` }}
            search={{ value: busqueda, onChange: setBusqueda, placeholder: "SKU o nombre…" }}
            toolbar={
              <div className="w-52">
                <SimpleSelect
                  ariaLabel="Almacén"
                  value={almacen === "" ? "todos" : almacen}
                  onValueChange={(v) => setAlmacen(v === "todos" ? "" : v)}
                  options={[
                    { value: "todos", label: "Todos los almacenes" },
                    ...(almacenes.data ?? []).map((w) => ({
                      value: w.id,
                      label: `${w.code} · ${w.name}`,
                    })),
                  ]}
                />
              </div>
            }
            empty={{
              title: "Sin existencias con ese filtro",
              description:
                "La primera entrada de mercancía abre el kardex del producto — clic en una fila para verlo.",
              ...(puede("inventory.move")
                ? {
                    action: (
                      <Button variant="primary" size="sm" onClick={() => setOperacion("entrada")}>
                        Registrar entrada
                      </Button>
                    ),
                  }
                : {}),
            }}
          />
        </TabsPanel>

        <TabsPanel value="alertas">
          <Alertas />
        </TabsPanel>

        <TabsPanel value="recetas">
          <Recetas almacenes={almacenes.data ?? []} onConsumido={recargar} />
        </TabsPanel>
      </Tabs>

      {operacion !== null && (
        <Movimiento
          operacion={operacion}
          almacenes={almacenes.data ?? []}
          onCerrar={(hecho) => {
            setOperacion(null);
            if (hecho) recargar();
          }}
        />
      )}
      {kardexDe !== null && <Kardex balance={kardexDe} onCerrar={() => setKardexDe(null)} />}
    </div>
  );
}

function Kardex({
  balance,
  onCerrar,
}: {
  balance: StockBalance;
  onCerrar: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const movimientos = useQuery({
    queryKey: ["kardex", empresa.id, balance.product_id],
    queryFn: () =>
      llamar<{ items: InventoryMove[] }>(
        `/v1/inventory/moves?product_id=${balance.product_id}&per_page=100`,
      ),
  });

  const columnas = useMemo<ColumnDef<InventoryMove, unknown>[]>(
    () => [
      {
        id: "fecha",
        header: "Fecha",
        accessorFn: (m) => m.occurred_at.slice(0, 16).replace("T", " "),
      },
      {
        id: "tipo",
        header: "Tipo",
        accessorKey: "kind",
        enableSorting: false,
        cell: (c) => {
          const k = c.getValue<string>();
          return (
            <Badge tone={k === "entrada" ? "accent" : k === "salida" ? "warning" : "neutral"}>
              {k}
            </Badge>
          );
        },
      },
      {
        id: "cantidad",
        header: () => <span className="block text-right">Cantidad</span>,
        enableSorting: false,
        accessorKey: "quantity",
        cell: (c) => (
          <span className="block text-right font-mono text-[0.84rem]">
            {mostrarCantidad(c.getValue<string>())}
          </span>
        ),
      },
      {
        id: "importe",
        header: () => <span className="block text-right">Importe</span>,
        enableSorting: false,
        accessorKey: "functional_amount",
        cell: (c) => {
          const m = c.row.original;
          return (
            <span className="block text-right font-mono text-[0.84rem]">
              {mostrarImporte({ amount: m.functional_amount, currency: m.functional_currency })}
            </span>
          );
        },
      },
      {
        id: "saldo",
        header: () => <span className="block text-right">Saldo</span>,
        enableSorting: false,
        accessorKey: "quantity_after",
        cell: (c) => (
          <span className="block text-right font-mono text-[0.84rem]">
            {mostrarCantidad(c.getValue<string>())}
          </span>
        ),
      },
      {
        id: "valor",
        header: () => <span className="block text-right">Valor acum.</span>,
        enableSorting: false,
        accessorKey: "value_after",
        cell: (c) => {
          const m = c.row.original;
          return (
            <span className="block text-right font-mono text-[0.84rem]">
              {mostrarImporte({ amount: m.value_after, currency: m.functional_currency })}
            </span>
          );
        },
      },
      {
        id: "costo",
        header: () => <span className="block text-right">Costo unit.</span>,
        enableSorting: false,
        accessorKey: "unit_cost",
        cell: (c) => {
          const m = c.row.original;
          return (
            <span className="block text-right font-mono text-[0.84rem]">
              {mostrarImporte({ amount: m.unit_cost, currency: m.functional_currency })}
            </span>
          );
        },
      },
      {
        id: "ref",
        header: "Referencia",
        enableSorting: false,
        accessorFn: (m) => `${m.reference ?? "—"}${m.reason != null ? ` · ${m.reason}` : ""}`,
        cell: (c) => (
          <span className="block max-w-44 truncate text-[0.82rem] text-muted-foreground">
            {c.getValue<string>()}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-5xl">
        <DialogTitle>
          Kardex — <span className="font-mono">{balance.product_sku}</span> {balance.product_name}
        </DialogTitle>
        <DialogDescription>
          Saldo y costo de cada línea son los que el kardex calculó y guardó al registrar. Un
          movimiento no se edita ni se borra: se corrige con un ajuste nuevo.
        </DialogDescription>
        <div className="mt-3">
          <DataTable
            columns={columnas}
            data={movimientos.data?.items}
            error={movimientos.error instanceof Error ? movimientos.error.message : null}
            onRetry={() => void movimientos.refetch()}
            density="compact"
            virtualized
            exportCsv={{ filename: `kardex-${balance.product_sku}.csv` }}
            empty={{
              title: "Sin movimientos",
              description: "El kardex nace con la primera entrada.",
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Movimiento({
  operacion,
  almacenes,
  onCerrar,
}: {
  operacion: Operacion;
  almacenes: Warehouse[];
  onCerrar: (hecho: boolean) => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [producto, setProducto] = useState<EntityOption | null>(null);
  const [form, setForm] = useState({
    warehouse_id: "",
    to_warehouse_id: "",
    quantity: "",
    amount: "",
    currency: "VES",
    fx_rate: "",
    fx_source: "",
    reason: "",
    reference: "",
  });
  const [confirmando, setConfirmando] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const def = OPERACION[operacion];
  const cantidadValida =
    operacion === "ajuste"
      ? /^-?\d{1,16}(\.\d{1,8})?$/.test(form.quantity)
      : /^\d{1,16}(\.\d{1,8})?$/.test(form.quantity);
  const listo =
    producto !== null &&
    form.warehouse_id !== "" &&
    cantidadValida &&
    (operacion !== "entrada" ||
      (importeValido(form.amount) &&
        (form.currency === "VES" || (form.fx_rate !== "" && form.fx_source.trim() !== "")))) &&
    (operacion !== "ajuste" || form.reason.trim().length >= 3) &&
    (operacion !== "transferencia" ||
      (form.to_warehouse_id !== "" && form.to_warehouse_id !== form.warehouse_id));

  async function enviar(): Promise<void> {
    setError(null);
    const comun = {
      company_id: empresa.id,
      product_id: producto?.id ?? "",
      ...(form.reference.trim() === "" ? {} : { reference: form.reference.trim() }),
    };
    try {
      if (operacion === "entrada") {
        await llamar("/v1/inventory/receipts", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            ...comun,
            warehouse_id: form.warehouse_id,
            quantity: form.quantity,
            amount: form.amount,
            currency: form.currency,
            ...(form.currency !== "VES"
              ? {
                  fx: {
                    rate: form.fx_rate,
                    source: form.fx_source,
                    at: new Date().toISOString(),
                  },
                }
              : {}),
          }),
        });
      } else if (operacion === "salida") {
        await llamar("/v1/inventory/issues", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            ...comun,
            warehouse_id: form.warehouse_id,
            quantity: form.quantity,
          }),
        });
      } else if (operacion === "ajuste") {
        await llamar("/v1/inventory/adjustments", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            ...comun,
            warehouse_id: form.warehouse_id,
            delta: form.quantity,
            reason: form.reason.trim(),
          }),
        });
      } else {
        await llamar("/v1/inventory/transfers", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            ...comun,
            from_warehouse_id: form.warehouse_id,
            to_warehouse_id: form.to_warehouse_id,
            quantity: form.quantity,
          }),
        });
      }
      toast.success(
        `${def.etiqueta} registrada`,
        `${mostrarCantidad(form.quantity)} × ${producto?.detalle ?? ""}`,
      );
      onCerrar(true);
    } catch (e) {
      setError(e);
      toast.error("No se pudo registrar");
      throw e;
    }
  }

  const opcionesAlmacen = almacenes.map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }));

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar(false)}>
      <DialogContent className="max-w-xl">
        <DialogTitle>{def.etiqueta} de existencias</DialogTitle>
        <DialogDescription>{def.consecuencia}</DialogDescription>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Producto" required className="sm:col-span-2">
            {(a) => (
              <EntityPicker
                id={a.id}
                placeholder="SKU o nombre (los compuestos se consumen por receta, no aquí)…"
                value={producto}
                onChange={setProducto}
                buscar={async (q) => {
                  const r = await llamar<{ items: Product[] }>(
                    `/v1/products?search=${encodeURIComponent(q)}&per_page=10`,
                  );
                  return r.items
                    .filter((p) => p.kind === "good" && !p.is_composed)
                    .map((p) => ({ id: p.id, label: p.name, detalle: p.sku }));
                }}
              />
            )}
          </FormField>
          <FormField
            label={operacion === "transferencia" ? "Almacén de origen" : "Almacén"}
            required
          >
            {(a) => (
              <SimpleSelect
                id={a.id}
                value={form.warehouse_id === "" ? null : form.warehouse_id}
                onValueChange={(v) => setForm({ ...form, warehouse_id: v })}
                placeholder="Elige…"
                options={opcionesAlmacen}
              />
            )}
          </FormField>
          {operacion === "transferencia" && (
            <FormField label="Almacén de destino" required>
              {(a) => (
                <SimpleSelect
                  id={a.id}
                  value={form.to_warehouse_id === "" ? null : form.to_warehouse_id}
                  onValueChange={(v) => setForm({ ...form, to_warehouse_id: v })}
                  placeholder="Elige…"
                  options={opcionesAlmacen.filter((o) => o.value !== form.warehouse_id)}
                />
              )}
            </FormField>
          )}
          <FormField
            label={operacion === "ajuste" ? "Delta (con signo)" : "Cantidad"}
            required
            {...(operacion === "ajuste" ? { hint: "Ej. -3 para faltante, 3 para sobrante." } : {})}
          >
            {(a) => (
              <Input
                id={a.id}
                inputMode="decimal"
                className="text-right font-mono"
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              />
            )}
          </FormField>
          {operacion === "entrada" && (
            <>
              <FormField label="Costo TOTAL de la recepción" required hint="Total, no unitario.">
                {(a) => (
                  <MoneyInput
                    id={a.id}
                    value={form.amount}
                    onChange={(v) => setForm({ ...form, amount: v })}
                    currency={form.currency}
                  />
                )}
              </FormField>
              <FormField label="Moneda" required>
                {(a) => (
                  <SimpleSelect
                    id={a.id}
                    value={form.currency}
                    onValueChange={(v) => setForm({ ...form, currency: v })}
                    options={[
                      { value: "VES", label: "VES" },
                      { value: "USD", label: "USD" },
                    ]}
                  />
                )}
              </FormField>
              {form.currency !== "VES" && (
                <>
                  <FormField label="Tasa a VES" required>
                    {(a) => (
                      <Input
                        id={a.id}
                        inputMode="decimal"
                        className="text-right font-mono"
                        value={form.fx_rate}
                        onChange={(e) => setForm({ ...form, fx_rate: e.target.value })}
                      />
                    )}
                  </FormField>
                  <FormField label="Fuente de la tasa" required hint="Sin fuente no se guarda.">
                    {(a) => (
                      <Input
                        id={a.id}
                        placeholder="BCV"
                        value={form.fx_source}
                        onChange={(e) => setForm({ ...form, fx_source: e.target.value })}
                      />
                    )}
                  </FormField>
                </>
              )}
            </>
          )}
          {operacion === "ajuste" && (
            <FormField label="Motivo" required className="sm:col-span-2">
              {(a) => (
                <Input
                  id={a.id}
                  placeholder="Obligatorio: queda en la auditoría"
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                />
              )}
            </FormField>
          )}
          <FormField label="Referencia" className="sm:col-span-2">
            {(a) => (
              <Input
                id={a.id}
                placeholder="Guía, nota de entrega… (opcional)"
                value={form.reference}
                onChange={(e) => setForm({ ...form, reference: e.target.value })}
              />
            )}
          </FormField>
        </div>
        {error !== null && (
          <div className="mt-3">
            <MensajeError error={error} />
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onCerrar(false)}>
            Cancelar
          </Button>
          <Button variant="primary" disabled={!listo} onClick={() => setConfirmando(true)}>
            Registrar {def.etiqueta.toLowerCase()}…
          </Button>
        </div>

        <ConfirmDialog
          open={confirmando}
          onOpenChange={setConfirmando}
          title={`Registrar la ${def.etiqueta.toLowerCase()}`}
          confirmLabel={`Registrar la ${def.etiqueta.toLowerCase()}`}
          onConfirm={enviar}
        >
          {mostrarCantidad(form.quantity || "0")} × {producto?.label ?? "—"}
          {operacion === "transferencia"
            ? ` · ${almacenes.find((w) => w.id === form.warehouse_id)?.code ?? ""} → ${almacenes.find((w) => w.id === form.to_warehouse_id)?.code ?? ""}`
            : ` · ${almacenes.find((w) => w.id === form.warehouse_id)?.code ?? ""}`}
          . {def.consecuencia}
        </ConfirmDialog>
      </DialogContent>
    </Dialog>
  );
}

function Alertas(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const [dias, setDias] = useState("30");
  const [definiendo, setDefiniendo] = useState(false);
  const qc = useQueryClient();

  const alertas = useQuery({
    queryKey: ["alertas-inv", empresa.id, dias],
    queryFn: async () => {
      const [bajo, vencen] = await Promise.all([
        llamar<{ items: LowStockItem[] }>("/v1/inventory/low-stock"),
        llamar<{ items: ExpiringLot[] }>(`/v1/inventory/expiring-lots?days=${dias}`),
      ]);
      return { bajo: bajo.items, vencen: vencen.items };
    },
  });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Por reponer ({alertas.data?.bajo.length ?? 0})</CardTitle>
          <Button variant="secondary" size="sm" onClick={() => setDefiniendo(true)}>
            Definir umbral…
          </Button>
        </CardHeader>
        <CardContent>
          {alertas.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : (alertas.data?.bajo ?? []).length === 0 ? (
            <CardDescription>
              Nada por debajo del mínimo. Solo aparecen los productos con umbral definido.
            </CardDescription>
          ) : (
            <ul className="space-y-1.5 text-[0.9rem]">
              {(alertas.data?.bajo ?? []).map((i) => (
                <li
                  key={`${i.warehouse_id}-${i.product_id}`}
                  className="flex items-baseline justify-between gap-2"
                >
                  <span>
                    <span className="font-mono text-[0.82rem]">{i.product_sku}</span>{" "}
                    {i.product_name}
                  </span>
                  <span className="font-mono text-[0.84rem] text-warning-soft-foreground">
                    faltan {mostrarCantidad(i.missing)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Por vencer ({alertas.data?.vencen.length ?? 0})</CardTitle>
          <label className="flex items-center gap-1.5 text-[0.82rem] text-muted-foreground">
            <TimerReset className="size-3.5" /> próximos{" "}
            <Input
              aria-label="Días"
              className="h-6 w-14 text-center"
              value={dias}
              onChange={(e) => setDias(e.target.value.replace(/\D/g, "") || "0")}
            />{" "}
            días
          </label>
        </CardHeader>
        <CardContent>
          {alertas.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : (alertas.data?.vencen ?? []).length === 0 ? (
            <CardDescription>Ningún lote con existencia vence en ese plazo.</CardDescription>
          ) : (
            <ul className="space-y-1.5 text-[0.9rem]">
              {(alertas.data?.vencen ?? []).map((l) => (
                <li
                  key={`${l.lot_id}-${l.warehouse_id}`}
                  className="flex items-baseline justify-between gap-2"
                >
                  <span>
                    <span className="font-mono text-[0.82rem]">{l.lot_code}</span> {l.product_sku} ·
                    vence {l.expires_at.slice(0, 10)}
                  </span>
                  {l.days_left < 0 ? (
                    <Badge tone="destructive">vencido hace {String(-l.days_left)} d</Badge>
                  ) : (
                    <Badge tone={l.days_left <= 7 ? "warning" : "neutral"}>{l.days_left} d</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[0.8rem] text-faint-foreground">
            Un lote vencido no se despacha sin el permiso de existencia vencida; entrar sí puede —
            el control es sobre lo que llega al cliente.
          </p>
        </CardContent>
      </Card>

      {definiendo && (
        <DefinirUmbral
          onCerrar={(hecho) => {
            setDefiniendo(false);
            if (hecho) void qc.invalidateQueries({ queryKey: ["alertas-inv", empresa.id] });
          }}
        />
      )}
    </div>
  );
}

/**
 * UMBRAL DE REPOSICIÓN (Nivel B de la auditoría de superficie): la alerta de
 * «por reponer» decía «solo con umbral definido»… y no había dónde definirlo.
 */
function DefinirUmbral({ onCerrar }: { onCerrar: (hecho: boolean) => void }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [producto, setProducto] = useState<EntityOption | null>(null);
  const [almacen, setAlmacen] = useState<string | null>(null);
  const [minimo, setMinimo] = useState("");
  const [maximo, setMaximo] = useState("");

  const almacenes = useQuery({
    queryKey: ["almacenes", empresa.id],
    queryFn: () => llamar<Warehouse[]>("/v1/warehouses"),
  });
  if (almacen === null && (almacenes.data?.length ?? 0) > 0) {
    setAlmacen(almacenes.data![0]!.id);
  }

  const guardar = useMutation({
    mutationFn: () =>
      llamar("/v1/inventory/thresholds", {
        method: "PUT",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          warehouse_id: almacen,
          product_id: producto?.id ?? "",
          stock_min: minimo.trim().replace(",", "."),
          ...(maximo.trim() === "" ? {} : { stock_max: maximo.trim().replace(",", ".") }),
        }),
      }),
    onSuccess: () => {
      toast.success("Umbral definido", "La alerta de reposición ya lo vigila.");
      onCerrar(true);
    },
    onError: (e) => toast.error("No se pudo definir", e instanceof Error ? e.message : undefined),
  });

  const listo =
    producto !== null &&
    almacen !== null &&
    /^d{1,16}(.d{1,8})?$/.test(minimo.trim().replace(",", "."));

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar(false)}>
      <DialogContent className="max-w-md">
        <DialogTitle>Definir umbral de reposición</DialogTitle>
        <DialogDescription>
          Cuando la existencia baje del mínimo, el producto aparece en «Por reponer».
        </DialogDescription>
        <div className="space-y-3 pt-2">
          <FormField label="Producto" required>
            {(a) => (
              <EntityPicker
                id={a.id}
                placeholder="SKU o nombre…"
                value={producto}
                onChange={setProducto}
                buscar={async (q) => {
                  const r = await llamar<{ items: Product[] }>(
                    "/v1/products?search=" + encodeURIComponent(q) + "&per_page=10",
                  );
                  return r.items
                    .filter((x) => x.kind === "good")
                    .map((x) => ({ id: x.id, label: x.name, detalle: x.sku }));
                }}
              />
            )}
          </FormField>
          <FormField label="Almacén" required>
            {(a) => (
              <SimpleSelect
                id={a.id}
                value={almacen}
                onValueChange={setAlmacen}
                options={(almacenes.data ?? []).map((w) => ({
                  value: w.id,
                  label: w.code + " · " + w.name,
                }))}
              />
            )}
          </FormField>
          <div className="grid grid-cols-2 gap-2">
            <FormField label="Mínimo" required>
              {(a) => (
                <Input
                  id={a.id}
                  inputMode="decimal"
                  className="text-right font-mono"
                  value={minimo}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMinimo(e.target.value)}
                />
              )}
            </FormField>
            <FormField label="Máximo (opcional)">
              {(a) => (
                <Input
                  id={a.id}
                  inputMode="decimal"
                  className="text-right font-mono"
                  value={maximo}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMaximo(e.target.value)}
                />
              )}
            </FormField>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onCerrar(false)}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={!listo || guardar.isPending}
            onClick={() => guardar.mutate()}
          >
            Guardar umbral
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Recetas({
  almacenes,
  onConsumido,
}: {
  almacenes: Warehouse[];
  onConsumido: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [compuesto, setCompuesto] = useState<EntityOption | null>(null);
  const [almacen, setAlmacen] = useState("");
  const [unidades, setUnidades] = useState("1");
  const [confirmando, setConfirmando] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const receta = useQuery({
    queryKey: ["receta", empresa.id, compuesto?.id, almacen],
    enabled: compuesto !== null && almacen !== "",
    queryFn: () =>
      llamar<{ lines: RecipeLineView[]; estimated_unit_cost: string | null; currency: string }>(
        `/v1/products/${compuesto?.id}/recipe?warehouse_id=${almacen}`,
      ),
  });

  const faltaConversion = (receta.data?.lines ?? []).some(
    (l) => l.quantity_in_product_unit === null,
  );

  async function consumir(): Promise<void> {
    setError(null);
    try {
      const r = await llamar<{ total_cost: string; currency: string; moves: unknown[] }>(
        "/v1/inventory/recipe-consumptions",
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            company_id: empresa.id,
            warehouse_id: almacen,
            product_id: compuesto?.id ?? "",
            quantity: unidades,
          }),
        },
      );
      toast.success(
        "Receta consumida",
        `${String(r.moves.length)} salidas por ${mostrarImporte({ amount: r.total_cost, currency: r.currency })}`,
      );
      onConsumido();
    } catch (e) {
      setError(e);
      throw e;
    }
  }

  const [definiendo, setDefiniendo] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Consumo por receta</CardTitle>
        <Button variant="secondary" size="sm" onClick={() => setDefiniendo(true)}>
          Definir receta…
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <CardDescription>
          Un compuesto no tiene existencias propias: consumirlo genera UNA salida por ingrediente,
          todas en el mismo instante y ligadas al mismo documento.
        </CardDescription>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FormField label="Producto compuesto" required>
            {(a) => (
              <EntityPicker
                id={a.id}
                placeholder="Buscar compuesto…"
                value={compuesto}
                onChange={setCompuesto}
                buscar={async (q) => {
                  const r = await llamar<{ items: Product[] }>(
                    `/v1/products?search=${encodeURIComponent(q)}&per_page=10`,
                  );
                  return r.items
                    .filter((p) => p.is_composed)
                    .map((p) => ({ id: p.id, label: p.name, detalle: p.sku }));
                }}
              />
            )}
          </FormField>
          <FormField label="Almacén" required>
            {(a) => (
              <SimpleSelect
                id={a.id}
                value={almacen === "" ? null : almacen}
                onValueChange={setAlmacen}
                placeholder="¿De dónde salen los ingredientes?"
                options={almacenes.map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }))}
              />
            )}
          </FormField>
          <FormField label="Unidades a consumir" required>
            {(a) => (
              <Input
                id={a.id}
                inputMode="decimal"
                className="text-right font-mono"
                value={unidades}
                onChange={(e) => setUnidades(e.target.value)}
              />
            )}
          </FormField>
        </div>

        {compuesto !== null && almacen !== "" && receta.data !== undefined && (
          <div className="rounded-md border border-border bg-surface-muted/40 p-3">
            {receta.data.lines.length === 0 ? (
              <p className="text-[0.88rem] text-muted-foreground">
                Sin receta. Un compuesto sin receta no se puede consumir: no descontaría nada.
              </p>
            ) : (
              <>
                <ul className="space-y-1 text-[0.88rem]">
                  {receta.data.lines.map((l) => (
                    <li key={l.child_product_id} className="flex justify-between gap-2">
                      <span>
                        <span className="font-mono text-[0.8rem]">{l.child_sku}</span>{" "}
                        {l.child_name}
                      </span>
                      <span className="font-mono text-[0.84rem]">
                        {l.quantity_in_product_unit === null ? (
                          <span className="text-warning-soft-foreground">
                            sin conversión {l.unit_code}→{l.product_unit_code}
                          </span>
                        ) : (
                          `${mostrarCantidad(l.quantity_in_product_unit)} ${l.product_unit_code}`
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[0.85rem]">
                  Costo estimado por unidad:{" "}
                  {receta.data.estimated_unit_cost === null ? (
                    <span className="text-warning-soft-foreground">
                      no calculable — falta una conversión
                    </span>
                  ) : (
                    <span className="font-mono">
                      {mostrarImporte({
                        amount: receta.data.estimated_unit_cost,
                        currency: receta.data.currency,
                      })}
                    </span>
                  )}
                  <span className="ml-1 text-[0.78rem] text-faint-foreground">
                    (el real será la suma de las salidas al ejecutarse)
                  </span>
                </p>
              </>
            )}
          </div>
        )}

        {error !== null && <MensajeError error={error} />}

        <Button
          variant="primary"
          disabled={
            compuesto === null ||
            almacen === "" ||
            faltaConversion ||
            (receta.data?.lines ?? []).length === 0
          }
          onClick={() => setConfirmando(true)}
        >
          Consumir receta…
        </Button>

        {definiendo && (
          <DefinirReceta
            onCerrar={() => {
              setDefiniendo(false);
              // La receta del compuesto elegido se rehace en la próxima consulta.
            }}
          />
        )}

        <ConfirmDialog
          open={confirmando}
          onOpenChange={setConfirmando}
          title="Consumir la receta"
          confirmLabel="Consumir la receta"
          onConfirm={consumir}
        >
          {mostrarCantidad(unidades)} × {compuesto?.label}. Se genera una salida POR INGREDIENTE,
          ninguna se puede editar ni borrar después; el compuesto no se descuenta a sí mismo.
        </ConfirmDialog>
      </CardContent>
    </Card>
  );
}

/**
 * DEFINIR LA RECETA (Nivel B de la auditoría de superficie): consumirla
 * existía; crearla o corregirla, no. La receta se reemplaza ENTERA — una
 * receta a medias no es una receta (contrato del servidor).
 */
function DefinirReceta({ onCerrar }: { onCerrar: () => void }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [compuesto, setCompuesto] = useState<EntityOption | null>(null);
  const [lineas, setLineas] = useState<
    { ingrediente: EntityOption | null; quantity: string; unit_code: string }[]
  >([{ ingrediente: null, quantity: "", unit_code: "unidad" }]);
  const [error, setError] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);

  const unidades = useQuery({
    queryKey: ["unidades"],
    staleTime: 300_000,
    queryFn: () => llamar<{ code: string; name: string }[]>("/v1/units"),
  });

  const validas = lineas.filter(
    (l) => l.ingrediente !== null && l.quantity.trim() !== "" && l.unit_code !== "",
  );
  const listo = compuesto !== null && validas.length > 0;

  async function guardar(): Promise<void> {
    setError(null);
    setOcupado(true);
    try {
      await llamar("/v1/products/" + (compuesto?.id ?? "") + "/recipe", {
        method: "PUT",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          lines: validas.map((l) => ({
            child_product_id: l.ingrediente!.id,
            quantity: l.quantity.trim().replace(",", "."),
            unit_code: l.unit_code,
          })),
        }),
      });
      toast.success("Receta guardada", "Reemplaza a la anterior por completo.");
      onCerrar();
    } catch (e) {
      setError(e);
      toast.error("No se pudo guardar la receta");
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-xl">
        <DialogTitle>Definir la receta</DialogTitle>
        <DialogDescription>
          Cuánto de cada ingrediente consume UNA unidad del compuesto. Guardar reemplaza la receta
          anterior entera; lo ya consumido no cambia.
        </DialogDescription>
        <div className="space-y-3 pt-2">
          <FormField label="Producto compuesto" required>
            {(a) => (
              <EntityPicker
                id={a.id}
                placeholder="Buscar compuesto…"
                value={compuesto}
                onChange={setCompuesto}
                buscar={async (q) => {
                  const r = await llamar<{ items: Product[] }>(
                    "/v1/products?search=" + encodeURIComponent(q) + "&per_page=10",
                  );
                  return r.items
                    .filter((x) => x.is_composed)
                    .map((x) => ({ id: x.id, label: x.name, detalle: x.sku }));
                }}
              />
            )}
          </FormField>
          <div className="space-y-2">
            {lineas.map((l, i) => (
              <div key={i} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <EntityPicker
                    placeholder="Ingrediente…"
                    value={l.ingrediente}
                    onChange={(v) =>
                      setLineas((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, ingrediente: v } : x)),
                      )
                    }
                    buscar={async (q) => {
                      const r = await llamar<{ items: Product[] }>(
                        "/v1/products?search=" + encodeURIComponent(q) + "&per_page=10",
                      );
                      return r.items
                        .filter((x) => x.kind === "good" && !x.is_composed)
                        .map((x) => ({ id: x.id, label: x.name, detalle: x.sku }));
                    }}
                  />
                </div>
                <Input
                  aria-label="Cantidad por unidad"
                  placeholder="Cant."
                  inputMode="decimal"
                  className="w-20 text-right font-mono"
                  value={l.quantity}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setLineas((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)),
                    )
                  }
                />
                <div className="w-32">
                  <SimpleSelect
                    ariaLabel="Unidad del ingrediente"
                    value={l.unit_code}
                    onValueChange={(v) =>
                      setLineas((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, unit_code: v } : x)),
                      )
                    }
                    options={(unidades.data ?? []).map((u) => ({
                      value: u.code,
                      label: u.name,
                    }))}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="iconSm"
                  aria-label="Quitar ingrediente"
                  disabled={lineas.length <= 1}
                  onClick={() => setLineas((prev) => prev.filter((_, j) => j !== i))}
                >
                  ×
                </Button>
              </div>
            ))}
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setLineas((prev) => [
                  ...prev,
                  { ingrediente: null, quantity: "", unit_code: "unidad" },
                ])
              }
            >
              Otro ingrediente
            </Button>
          </div>
          {error !== null && <MensajeError error={error} />}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button variant="primary" disabled={!listo || ocupado} onClick={() => void guardar()}>
            {ocupado ? "Guardando…" : "Guardar la receta"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
