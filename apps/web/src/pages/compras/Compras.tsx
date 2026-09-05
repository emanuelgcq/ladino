import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { PackageCheck, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DataTable } from "../../components/DataTable.js";
import { DualMoney } from "../../components/DualMoney.js";
import { FiscalStatusBadge } from "../../components/FiscalStatusBadge.js";
import {
  DatePicker,
  EntityPicker,
  FormField,
  MoneyInput,
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
import { Table, TBody, TD, TDNum, TH, THead, TR } from "../../ui/table.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../ui/dialog.js";
import { useToast } from "../../ui/toast.js";
import { mostrarCantidad, mostrarImporte } from "../../money.js";
import { MensajeError } from "../ventas/comunes.js";
import type {
  GoodsReceiptDetail,
  LandedCostResult,
  MatchingRow,
  Product,
  PurchaseOrder,
  PurchaseOrderDetail,
  RetentionConcept,
  RetentionRule,
  Supplier,
  SupplierInvoice,
  SupplierStatement,
  Warehouse,
} from "../../lib.js";

/**
 * Compras — Fase B. Cuatro superficies: órdenes (con recepción y landed cost),
 * nueva orden, cuentas por pagar (estado de cuenta, facturas y matching de
 * tres vías) y las reglas de retención — el catálogo que NACE VACÍO a
 * propósito (ADR-0039): sin regla con norma citada no se retiene, y cargarla
 * es un acto visible con su sello VALIDAR-SENIAT, no un ajuste escondido.
 *
 * CERO dinero calculado aquí. La pantalla anterior sumaba en el cliente el
 * reparto del landed cost (`reduce(Number(...))`) — esta NO: enseña el total
 * repartido y la variación tal como el servidor los devolvió.
 */
export function Compras(): React.JSX.Element {
  return (
    <div>
      <PageHeader
        title="Compras"
        description="La orden compromete; la recepción mueve inventario y fija costo; la factura puede llegar después — el sistema no la espera."
      />
      <Tabs defaultValue="ordenes">
        <TabsList className="mb-3">
          <TabsTab value="ordenes">Órdenes</TabsTab>
          <TabsTab value="nueva">Nueva orden</TabsTab>
          <TabsTab value="cxp">Cuentas por pagar</TabsTab>
          <TabsTab value="retenciones">Reglas de retención</TabsTab>
        </TabsList>
        <TabsPanel value="ordenes">
          <Ordenes />
        </TabsPanel>
        <TabsPanel value="nueva">
          <NuevaOrden />
        </TabsPanel>
        <TabsPanel value="cxp">
          <CuentasPorPagar />
        </TabsPanel>
        <TabsPanel value="retenciones">
          <Retenciones />
        </TabsPanel>
      </Tabs>
    </div>
  );
}

// ── Órdenes ─────────────────────────────────────────────────────────────────

function Ordenes(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const [abierta, setAbierta] = useState<string | null>(null);

  const ordenes = useQuery({
    queryKey: ["ordenes-compra", empresa.id],
    queryFn: () => llamar<{ items: PurchaseOrder[] }>("/v1/purchase-orders"),
  });

  const columnas = useMemo<ColumnDef<PurchaseOrder, unknown>[]>(
    () => [
      {
        id: "numero",
        header: "Nº",
        accessorFn: (o) => o.order_number ?? "—",
        cell: (c) => <span className="font-mono text-[0.84rem]">{c.getValue<string>()}</span>,
      },
      {
        id: "estado",
        header: "Estado",
        enableSorting: false,
        // El estado DERIVADO de lo recibido, no la columna cruda.
        accessorFn: (o) => o.derived_status ?? o.status,
        cell: (c) => <FiscalStatusBadge estado={c.getValue<string>()} />,
      },
      { id: "fecha", header: "Fecha", accessorFn: (o) => o.ordered_at?.slice(0, 10) ?? "—" },
      {
        id: "total",
        header: () => <span className="block text-right">Total</span>,
        enableSorting: false,
        accessorKey: "amount_transaction_currency",
        cell: (c) => {
          const o = c.row.original;
          return (
            <DualMoney
              variant="cell"
              amount={o.amount_transaction_currency}
              currency={o.transaction_currency}
            />
          );
        },
      },
    ],
    [],
  );

  return (
    <>
      <DataTable
        columns={columnas}
        data={ordenes.data?.items}
        error={ordenes.error instanceof Error ? ordenes.error.message : null}
        onRetry={() => void ordenes.refetch()}
        getRowId={(o) => o.id}
        onRowClick={(o) => setAbierta(o.id)}
        density="compact"
        empty={{
          title: "Sin órdenes de compra",
          description: "La orden compromete cantidades y precios; nada se mueve hasta recibir.",
        }}
      />
      {abierta !== null && <DetalleOrden id={abierta} onCerrar={() => setAbierta(null)} />}
    </>
  );
}

function DetalleOrden({ id, onCerrar }: { id: string; onCerrar: () => void }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  const [cantidades, setCantidades] = useState<Record<string, string>>({});
  const [confirmando, setConfirmando] = useState(false);
  const [recepcion, setRecepcion] = useState<string | null>(null);
  const [facturando, setFacturando] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const detalle = useQuery({
    queryKey: ["orden-compra", empresa.id, id],
    queryFn: () => llamar<PurchaseOrderDetail>(`/v1/purchase-orders/${id}`),
  });

  async function recibir(): Promise<void> {
    const d = detalle.data;
    if (d === undefined) return;
    setError(null);
    const lines = d.lines
      .filter((l) => (cantidades[l.id] ?? "").trim() !== "")
      .map((l) => ({
        purchase_order_line_id: l.id,
        product_id: l.product_id,
        quantity: cantidades[l.id]?.trim() ?? "",
        unit_price: l.unit_price_transaction,
        ...(l.unit_weight !== null ? { unit_weight: l.unit_weight } : {}),
      }));
    try {
      await llamar("/v1/goods-receipts", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          supplier_id: d.order.supplier_id,
          purchase_order_id: d.order.id,
          warehouse_id: d.order.warehouse_id,
          currency: d.order.transaction_currency,
          lines,
        }),
      });
      toast.success("Recepción confirmada", "El inventario ya la refleja.");
      setCantidades({});
      await qc.invalidateQueries({ queryKey: ["orden-compra", empresa.id, id] });
    } catch (e) {
      setError(e);
      throw e;
    }
  }

  const d = detalle.data;
  const hayQueRecibir = Object.values(cantidades).some((v) => v.trim() !== "");

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-4xl">
        {d === undefined ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <>
            <DialogTitle>
              Orden {d.order.order_number ?? "borrador"}{" "}
              <FiscalStatusBadge estado={d.derived_status} className="ml-2 align-middle" />
            </DialogTitle>
            <DialogDescription>
              Moneda {d.order.transaction_currency} · tasa{" "}
              <span className="font-mono">{mostrarCantidad(d.order.fx_rate)}</span> (
              {d.order.rate_source})
            </DialogDescription>

            <div className="mt-3 space-y-4">
              <div>
                <p className="mb-1 text-[0.85rem] font-medium">Avance por línea</p>
                <Table>
                  <THead>
                    <TR>
                      <TH>Descripción</TH>
                      <TH className="text-right">Pedido</TH>
                      <TH className="text-right">Recibido</TH>
                      <TH className="text-right">Pendiente</TH>
                      <TH className="text-right">P. unit.</TH>
                      <TH>Recibir ahora</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {d.lines.map((l) => {
                      const p = d.progress.find((x) => x.order_line_id === l.id);
                      const pendiente = p?.quantity_pending ?? l.quantity;
                      const completa = /^0*(?:\.0*)?$/.test(pendiente);
                      return (
                        <TR key={l.id}>
                          <TD className="whitespace-normal">{l.description}</TD>
                          <TDNum>{mostrarCantidad(l.quantity)}</TDNum>
                          <TDNum>{mostrarCantidad(p?.quantity_received ?? "0")}</TDNum>
                          <TDNum>{mostrarCantidad(pendiente)}</TDNum>
                          <TDNum>
                            {mostrarImporte({
                              amount: l.unit_price_transaction,
                              currency: d.order.transaction_currency,
                            })}
                          </TDNum>
                          <TD>
                            {completa ? (
                              <Badge tone="accent">Completa</Badge>
                            ) : (
                              <Input
                                aria-label={`Recibir de ${l.description}`}
                                className="h-7 w-24 text-right font-mono"
                                placeholder={`≤ ${mostrarCantidad(pendiente)}`}
                                value={cantidades[l.id] ?? ""}
                                onChange={(e) =>
                                  setCantidades({ ...cantidades, [l.id]: e.target.value })
                                }
                              />
                            )}
                          </TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
                <div className="mt-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!hayQueRecibir}
                    onClick={() => setConfirmando(true)}
                  >
                    <PackageCheck /> Registrar recepción…
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div>
                  <p className="mb-1 text-[0.85rem] font-medium">Recepciones</p>
                  {d.receipts.length === 0 ? (
                    <p className="text-[0.85rem] text-muted-foreground">Todavía no llegó nada.</p>
                  ) : (
                    <ul className="space-y-1 text-[0.88rem]">
                      {d.receipts.map((r) => (
                        <li key={r.id} className="flex items-center justify-between gap-2">
                          <span>
                            Nº {r.receipt_number ?? "—"} · {r.received_at?.slice(0, 10) ?? "—"} ·{" "}
                            <span className="font-mono">
                              {mostrarImporte({
                                amount: r.functional_amount,
                                currency: d.order.functional_currency,
                              })}
                            </span>
                          </span>
                          <Button variant="ghost" size="sm" onClick={() => setRecepcion(r.id)}>
                            Costear
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <p className="text-[0.85rem] font-medium">Facturas del proveedor</p>
                    <Button variant="secondary" size="sm" onClick={() => setFacturando(true)}>
                      Registrar factura…
                    </Button>
                  </div>
                  {d.invoices.length === 0 ? (
                    <p className="text-[0.85rem] text-muted-foreground">
                      Ninguna todavía — puede llegar días después de la mercancía; el inventario no
                      la espera.
                    </p>
                  ) : (
                    <ul className="space-y-1 text-[0.88rem]">
                      {d.invoices.map((i) => (
                        <li key={i.id} className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[0.84rem]">
                            {i.supplier_document_number} · {i.invoice_date}
                          </span>
                          <span className="font-mono">
                            {mostrarImporte({
                              amount: i.total_amount,
                              currency: d.order.functional_currency,
                            })}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {error !== null && <MensajeError error={error} />}
            </div>

            <ConfirmDialog
              open={confirmando}
              onOpenChange={setConfirmando}
              title="Registrar la recepción"
              confirmLabel="Registrar la recepción"
              onConfirm={recibir}
            >
              Confirmar la recepción <strong>mueve el inventario</strong> y fija el costo con la
              tasa de hoy. Una vez confirmada no se edita: lo que corrige una recepción es un
              ajuste.
            </ConfirmDialog>

            {recepcion !== null && (
              <LandedCost receiptId={recepcion} onCerrar={() => setRecepcion(null)} />
            )}

            {facturando && (
              <RegistrarFacturaProveedor
                detalle={d}
                onCerrar={(hecho) => {
                  setFacturando(false);
                  if (hecho) {
                    void qc.invalidateQueries({ queryKey: ["orden-compra", empresa.id, id] });
                  }
                }}
              />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function LandedCost({
  receiptId,
  onCerrar,
}: {
  receiptId: string;
  onCerrar: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  const [gasto, setGasto] = useState({
    concept: "",
    allocation_method: "by_value",
    amount: "",
    currency: "VES",
    incurred_on: new Date().toISOString().slice(0, 10),
  });
  const [confirmando, setConfirmando] = useState(false);
  const [ultimo, setUltimo] = useState<LandedCostResult | null>(null);
  const [error, setError] = useState<unknown>(null);

  const recepcion = useQuery({
    queryKey: ["recepcion", empresa.id, receiptId],
    queryFn: () => llamar<GoodsReceiptDetail>(`/v1/goods-receipts/${receiptId}`),
  });

  async function aplicar(): Promise<void> {
    setError(null);
    try {
      const r = await llamar<LandedCostResult>("/v1/landed-costs", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          goods_receipt_id: receiptId,
          ...gasto,
        }),
      });
      setUltimo(r);
      setGasto({ ...gasto, concept: "", amount: "" });
      toast.success("Gasto aplicado al costo");
      await qc.invalidateQueries({ queryKey: ["recepcion", empresa.id, receiptId] });
    } catch (e) {
      setError(e);
      throw e;
    }
  }

  const rec = recepcion.data;

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-3xl">
        {rec === undefined ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            <DialogTitle>Costear la recepción Nº {rec.receipt.receipt_number ?? "—"}</DialogTitle>
            <DialogDescription>
              Flete, aduana y demás gastos se REPARTEN sobre las líneas y se congelan. La parte de
              lo ya vendido no encarece lo que queda: va a variación de costo del período
              (ADR-0040).
            </DialogDescription>

            <div className="mt-3 space-y-3">
              <Table>
                <THead>
                  <TR>
                    <TH>#</TH>
                    <TH className="text-right">Cantidad</TH>
                    <TH className="text-right">Costo unit.</TH>
                    <TH className="text-right">Landed acum.</TH>
                    <TH className="text-right">Peso unit.</TH>
                  </TR>
                </THead>
                <TBody>
                  {rec.lines.map((l) => (
                    <TR key={l.id}>
                      <TD>{l.line_number}</TD>
                      <TDNum>{mostrarCantidad(l.quantity)}</TDNum>
                      <TDNum>
                        {mostrarImporte({
                          amount: l.unit_cost_functional,
                          currency: rec.receipt.functional_currency,
                        })}
                      </TDNum>
                      <TDNum>
                        {mostrarImporte({
                          amount: l.landed_cost_functional,
                          currency: rec.receipt.functional_currency,
                        })}
                      </TDNum>
                      <TDNum>
                        {l.unit_weight !== null ? (
                          mostrarCantidad(l.unit_weight)
                        ) : (
                          <span
                            className="text-warning-soft-foreground"
                            title="Sin peso, el reparto por peso se rechaza"
                          >
                            sin peso
                          </span>
                        )}
                      </TDNum>
                    </TR>
                  ))}
                </TBody>
              </Table>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <FormField label="Concepto" required className="col-span-2">
                  {(a) => (
                    <Input
                      id={a.id}
                      placeholder="Flete, aduana…"
                      value={gasto.concept}
                      onChange={(e) => setGasto({ ...gasto, concept: e.target.value })}
                    />
                  )}
                </FormField>
                <FormField label="Reparto" required>
                  {(a) => (
                    <SimpleSelect
                      id={a.id}
                      value={gasto.allocation_method}
                      onValueChange={(v) => setGasto({ ...gasto, allocation_method: v })}
                      options={[
                        { value: "by_value", label: "Por valor" },
                        { value: "by_weight", label: "Por peso" },
                        { value: "by_units", label: "Por unidades" },
                      ]}
                    />
                  )}
                </FormField>
                <FormField label="Fecha del gasto" required>
                  {(a) => (
                    <DatePicker
                      id={a.id}
                      value={gasto.incurred_on}
                      onChange={(v) => setGasto({ ...gasto, incurred_on: v })}
                    />
                  )}
                </FormField>
                <FormField label="Importe" required className="col-span-2">
                  {(a) => (
                    <MoneyInput
                      id={a.id}
                      value={gasto.amount}
                      onChange={(v) => setGasto({ ...gasto, amount: v })}
                      currency={gasto.currency}
                    />
                  )}
                </FormField>
                <FormField label="Moneda" required>
                  {(a) => (
                    <SimpleSelect
                      id={a.id}
                      value={gasto.currency}
                      onValueChange={(v) => setGasto({ ...gasto, currency: v })}
                      options={[
                        { value: "VES", label: "VES" },
                        { value: "USD", label: "USD" },
                      ]}
                    />
                  )}
                </FormField>
              </div>

              {ultimo !== null && (
                <div className="rounded-md border border-accent/30 bg-accent-soft/50 px-3 py-2 text-[0.88rem]">
                  Repartido{" "}
                  <span className="font-mono">
                    {mostrarImporte({
                      amount: ultimo.functional_amount,
                      currency: ultimo.functional_currency,
                    })}
                  </span>
                  {" · "}variación del período{" "}
                  <span className="font-mono">{mostrarCantidad(ultimo.total_variance)}</span> — la
                  parte de unidades que ya habían salido, que por eso no encarece las que quedan.
                </div>
              )}

              {rec.landed_costs.length > 0 && (
                <ul className="space-y-1 text-[0.85rem] text-muted-foreground">
                  {rec.landed_costs.map((c) => (
                    <li key={c.id}>
                      {c.concept} ({c.allocation_method}) ·{" "}
                      <span className="font-mono">
                        {mostrarImporte({
                          amount: c.functional_amount,
                          currency: rec.receipt.functional_currency,
                        })}
                      </span>{" "}
                      · {c.incurred_on} · {c.status}
                    </li>
                  ))}
                </ul>
              )}

              {error !== null && <MensajeError error={error} />}

              <Button
                variant="primary"
                disabled={gasto.concept.trim() === "" || !importeValido(gasto.amount)}
                onClick={() => setConfirmando(true)}
              >
                Aplicar al costo…
              </Button>
            </div>

            <ConfirmDialog
              open={confirmando}
              onOpenChange={setConfirmando}
              title="Aplicar el gasto al costo"
              confirmLabel="Aplicar el gasto"
              onConfirm={aplicar}
            >
              El gasto se reparte y se <strong>congela</strong>. La parte de la mercancía ya vendida
              se registra como variación de costo del período — nunca encarece lo que queda.
            </ConfirmDialog>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Nueva orden ─────────────────────────────────────────────────────────────

interface LineaOrden {
  clave: string;
  producto: EntityOption | null;
  quantity: string;
  unit_price: string;
  unit_weight: string;
}

function NuevaOrden(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [proveedor, setProveedor] = useState<EntityOption | null>(null);
  const [almacenId, setAlmacenId] = useState("");
  const [moneda, setMoneda] = useState("USD");
  const [esperada, setEsperada] = useState("");
  const [lineas, setLineas] = useState<LineaOrden[]>([
    { clave: crypto.randomUUID(), producto: null, quantity: "", unit_price: "", unit_weight: "" },
  ]);
  const [error, setError] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);

  const almacenes = useQuery({
    queryKey: ["almacenes", empresa.id],
    queryFn: () => llamar<Warehouse[]>("/v1/warehouses"),
  });

  const listo =
    proveedor !== null &&
    almacenId !== "" &&
    lineas.some(
      (l) => l.producto !== null && l.quantity.trim() !== "" && l.unit_price.trim() !== "",
    );

  async function crear(): Promise<void> {
    setError(null);
    setOcupado(true);
    try {
      const r = await llamar<PurchaseOrder>("/v1/purchase-orders", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          supplier_id: proveedor?.id ?? "",
          warehouse_id: almacenId,
          currency: moneda,
          ...(esperada === "" ? {} : { expected_at: esperada }),
          lines: lineas
            .filter((l) => l.producto !== null && l.quantity.trim() !== "")
            .map((l) => ({
              product_id: l.producto?.id ?? "",
              quantity: l.quantity.trim(),
              unit_price: l.unit_price.trim(),
              ...(l.unit_weight.trim() === "" ? {} : { unit_weight: l.unit_weight.trim() }),
            })),
        }),
      });
      toast.success(
        `Orden ${r.order_number ?? ""} creada`,
        "Compromete; nada se mueve hasta recibir.",
      );
      setProveedor(null);
      setLineas([
        {
          clave: crypto.randomUUID(),
          producto: null,
          quantity: "",
          unit_price: "",
          unit_weight: "",
        },
      ]);
    } catch (e) {
      setError(e);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nueva orden de compra</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <CardDescription>
          La orden COMPROMETE, no mueve nada: el inventario y el costo se fijan al recibir, con la
          tasa de ese día. El peso unitario habilita el reparto de gastos por peso.
        </CardDescription>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <FormField label="Proveedor" required className="sm:col-span-2">
            {(a) => (
              <EntityPicker
                id={a.id}
                placeholder="Buscar proveedor…"
                value={proveedor}
                onChange={setProveedor}
                buscar={async (q) => {
                  const r = await llamar<{ items: Supplier[] }>(
                    `/v1/suppliers?search=${encodeURIComponent(q)}&per_page=8`,
                  );
                  return r.items.map((s) => ({
                    id: s.id,
                    label: s.legal_name,
                    detalle: s.supplier_kind === "extranjero" ? "extranjero" : (s.tax_id ?? ""),
                  }));
                }}
              />
            )}
          </FormField>
          <FormField label="Almacén de destino" required>
            {(a) => (
              <SimpleSelect
                id={a.id}
                value={almacenId === "" ? null : almacenId}
                onValueChange={setAlmacenId}
                placeholder="Elige…"
                options={(almacenes.data ?? []).map((w) => ({
                  value: w.id,
                  label: `${w.code} · ${w.name}`,
                }))}
              />
            )}
          </FormField>
          <FormField label="Moneda" required>
            {(a) => (
              <SimpleSelect
                id={a.id}
                value={moneda}
                onValueChange={setMoneda}
                options={[
                  { value: "USD", label: "USD" },
                  { value: "VES", label: "VES" },
                ]}
              />
            )}
          </FormField>
          <FormField label="Fecha esperada">
            {(a) => <DatePicker id={a.id} value={esperada} onChange={setEsperada} />}
          </FormField>
        </div>

        <div className="space-y-2">
          {lineas.map((l, i) => (
            <div key={l.clave} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <EntityPicker
                  placeholder="Producto…"
                  value={l.producto}
                  onChange={(v) =>
                    setLineas((ls) => ls.map((x, j) => (j === i ? { ...x, producto: v } : x)))
                  }
                  buscar={async (q) => {
                    const r = await llamar<{ items: Product[] }>(
                      `/v1/products?search=${encodeURIComponent(q)}&per_page=8`,
                    );
                    return r.items.map((p) => ({ id: p.id, label: p.name, detalle: p.sku }));
                  }}
                />
              </div>
              <Input
                aria-label="Cantidad"
                placeholder="Cant."
                inputMode="decimal"
                className="w-20 text-right font-mono"
                value={l.quantity}
                onChange={(e) =>
                  setLineas((ls) =>
                    ls.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)),
                  )
                }
              />
              <Input
                aria-label="Precio unitario"
                placeholder={`P. unit. ${moneda}`}
                inputMode="decimal"
                className="w-28 text-right font-mono"
                value={l.unit_price}
                onChange={(e) =>
                  setLineas((ls) =>
                    ls.map((x, j) => (j === i ? { ...x, unit_price: e.target.value } : x)),
                  )
                }
              />
              <Input
                aria-label="Peso unitario"
                placeholder="Peso (op.)"
                inputMode="decimal"
                className="w-24 text-right font-mono"
                value={l.unit_weight}
                onChange={(e) =>
                  setLineas((ls) =>
                    ls.map((x, j) => (j === i ? { ...x, unit_weight: e.target.value } : x)),
                  )
                }
              />
              <Button
                variant="ghost"
                size="iconSm"
                aria-label="Quitar línea"
                disabled={lineas.length <= 1}
                onClick={() => setLineas((ls) => ls.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setLineas((ls) => [
                ...ls,
                {
                  clave: crypto.randomUUID(),
                  producto: null,
                  quantity: "",
                  unit_price: "",
                  unit_weight: "",
                },
              ])
            }
          >
            <Plus /> Añadir línea
          </Button>
        </div>

        {error !== null && <MensajeError error={error} />}

        <Button variant="primary" disabled={!listo || ocupado} onClick={() => void crear()}>
          {ocupado ? "Creando…" : "Crear orden"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Cuentas por pagar ───────────────────────────────────────────────────────

function CuentasPorPagar(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const variaciones = useQuery({
    queryKey: ["variaciones-costo", empresa.id],
    queryFn: () =>
      llamar<{
        items: {
          id: string;
          amount_functional: string;
          account_code: string | null;
          occurred_on: string;
          reason: string | null;
        }[];
        currency: string;
      }>("/v1/landed-costs/variances"),
  });
  const [proveedor, setProveedor] = useState<EntityOption | null>(null);
  const [matching, setMatching] = useState<{ rows: MatchingRow[]; tol: string } | null>(null);
  const [notaDe, setNotaDe] = useState<SupplierInvoice | null>(null);
  const [error, setError] = useState<unknown>(null);

  const datos = useQuery({
    queryKey: ["cxp", empresa.id, proveedor?.id],
    enabled: proveedor !== null,
    queryFn: async () => {
      const [estado, facturas] = await Promise.all([
        llamar<SupplierStatement>(`/v1/suppliers/${proveedor?.id}/statement`),
        llamar<{ items: SupplierInvoice[] }>(`/v1/supplier-invoices?supplier_id=${proveedor?.id}`),
      ]);
      return { estado, facturas: facturas.items };
    },
  });

  async function verMatching(invoiceId: string): Promise<void> {
    setError(null);
    try {
      const r = await llamar<{ rows: MatchingRow[]; price_tolerance_pct: string }>(
        `/v1/purchases/matching?supplier_invoice_id=${invoiceId}`,
      );
      setMatching({ rows: r.rows, tol: r.price_tolerance_pct });
    } catch (e) {
      setError(e);
    }
  }

  return (
    <div className="space-y-4">
      <div className="max-w-md">
        <EntityPicker
          placeholder="Elige un proveedor para ver su cuenta…"
          value={proveedor}
          onChange={setProveedor}
          buscar={async (q) => {
            const r = await llamar<{ items: Supplier[] }>(
              `/v1/suppliers?search=${encodeURIComponent(q)}&per_page=8`,
            );
            return r.items.map((s) => ({
              id: s.id,
              label: s.legal_name,
              detalle: s.tax_id ?? "extranjero",
            }));
          }}
        />
      </div>

      {error !== null && <MensajeError error={error} />}

      {proveedor !== null && datos.data !== undefined && (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Pendiente por pagar</CardTitle>
              </CardHeader>
              <CardContent>
                <DualMoney
                  variant="kpi"
                  amount={datos.data.estado.total_outstanding}
                  currency={datos.data.estado.currency}
                />
                <p className="mt-2 text-[0.85rem] text-muted-foreground">
                  Retenido acumulado:{" "}
                  <span className="font-mono">
                    {mostrarImporte({
                      amount: datos.data.estado.total_retained,
                      currency: datos.data.estado.currency,
                    })}
                  </span>
                </p>
              </CardContent>
            </Card>
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Antigüedad</CardTitle>
                <span className="text-[0.8rem] text-muted-foreground">
                  al {datos.data.estado.aging.reference_date}
                </span>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-[0.85rem]">
                  {datos.data.estado.aging.buckets.map((b) => (
                    <span key={b.bucket} className="font-mono text-muted-foreground">
                      {b.bucket}:{" "}
                      <span className="text-foreground">
                        {mostrarImporte({ amount: b.amount, currency: datos.data.estado.currency })}
                      </span>{" "}
                      ({b.document_count})
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Facturas</CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-1">
              <Table>
                <THead>
                  <TR>
                    <TH>Documento</TH>
                    <TH>Control</TH>
                    <TH>Fecha</TH>
                    <TH>Estado</TH>
                    <TH className="text-right">Total</TH>
                    <TH className="text-right">Retenido</TH>
                    <TH>IVA</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {datos.data.facturas.map((f) => (
                    <TR key={f.id}>
                      <TD className="font-mono text-[0.84rem]">{f.supplier_document_number}</TD>
                      <TD className="font-mono text-[0.84rem]">
                        {f.supplier_control_number ?? f.supplier_document_ref ?? "—"}
                      </TD>
                      <TD>{f.invoice_date}</TD>
                      <TD>
                        <FiscalStatusBadge estado={f.status} />
                      </TD>
                      <TDNum>
                        {mostrarImporte({
                          amount: f.total_amount,
                          currency: f.transaction_currency,
                        })}
                      </TDNum>
                      <TDNum>
                        {mostrarImporte({
                          amount: f.retention_total,
                          currency: f.functional_currency,
                        })}
                      </TDNum>
                      <TD>
                        {/* Derivado del taxpayer_type de la empresa, no configurable. */}
                        <Badge tone={f.tax_is_recoverable ? "accent" : "warning"}>
                          {f.tax_is_recoverable ? "crédito" : "costo"}
                        </Badge>
                      </TD>
                      <TD>
                        <Button variant="ghost" size="sm" onClick={() => void verMatching(f.id)}>
                          Matching
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setNotaDe(f)}>
                          NC…
                        </Button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      {(variaciones.data?.items ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Variaciones de costo del período</CardTitle>
          </CardHeader>
          <CardContent>
            <CardDescription className="mb-2">
              La parte de flete/aduana que tocó mercancía YA VENDIDA: no encarece lo que queda — va
              al resultado del período (ADR-0040).
            </CardDescription>
            <ul className="space-y-1 text-[0.88rem]">
              {(variaciones.data?.items ?? []).map((v) => (
                <li key={v.id} className="flex justify-between gap-2 tabular-nums">
                  <span className="text-muted-foreground">{v.occurred_on}</span>
                  <span className="min-w-0 flex-1 truncate">{v.reason ?? "—"}</span>
                  <span className="font-mono">
                    {mostrarImporte({
                      amount: v.amount_functional,
                      currency: variaciones.data?.currency ?? "VES",
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {notaDe !== null && (
        <NotaCreditoProveedor
          factura={notaDe}
          onCerrar={(hecho) => {
            setNotaDe(null);
            if (hecho) void datos.refetch();
          }}
        />
      )}

      {matching !== null && (
        <Dialog open onOpenChange={(v) => !v && setMatching(null)}>
          <DialogContent className="max-w-3xl">
            <DialogTitle>Matching de tres vías</DialogTitle>
            <DialogDescription>
              Umbral de precio: {matching.tol} %. El precio admite el umbral acordado; la cantidad
              NO admite ninguno — una diferencia de cantidad es una recepción que falta o un error,
              no un redondeo.
            </DialogDescription>
            <div className="mt-3">
              <Table>
                <THead>
                  <TR>
                    <TH className="text-right">Pedido</TH>
                    <TH className="text-right">Recibido</TH>
                    <TH className="text-right">Facturado</TH>
                    <TH className="text-right">P. orden</TH>
                    <TH className="text-right">P. factura</TH>
                    <TH className="text-right">Δ precio</TH>
                  </TR>
                </THead>
                <TBody>
                  {matching.rows.map((r) => {
                    const fuera =
                      r.price_diff_pct !== null && Number(r.price_diff_pct) > Number(matching.tol);
                    return (
                      <TR key={r.invoice_line_id}>
                        <TDNum>
                          {r.qty_ordered !== null ? mostrarCantidad(r.qty_ordered) : "sin orden"}
                        </TDNum>
                        <TDNum>
                          {r.qty_received !== null
                            ? mostrarCantidad(r.qty_received)
                            : "sin recepción"}
                        </TDNum>
                        <TDNum>{mostrarCantidad(r.qty_invoiced)}</TDNum>
                        <TDNum>
                          {r.price_ordered !== null ? mostrarCantidad(r.price_ordered) : "—"}
                        </TDNum>
                        <TDNum>{mostrarCantidad(r.price_invoiced)}</TDNum>
                        <TDNum className={fuera ? "text-warning-soft-foreground" : ""}>
                          {r.price_diff_pct ?? "—"}
                          {fuera && " ⚠"}
                        </TDNum>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ── Reglas de retención ─────────────────────────────────────────────────────

function Retenciones(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const comprobantes = useQuery({
    queryKey: ["comprobantes-retencion", empresa.id],
    queryFn: () =>
      llamar<{
        items: {
          id: string;
          series: string;
          receipt_number: number | null;
          issued_at: string | null;
          retained_total: string;
          functional_currency: string;
        }[];
      }>("/v1/retention-receipts"),
  });
  const toast = useToast();
  const qc = useQueryClient();
  const [nueva, setNueva] = useState({
    jurisdiction: "VE",
    retention_code: "iva",
    concept_code: "",
    formula_kind: "rate",
    rate: "",
    subtrahend: "",
    minimum_exempt: "",
    effective_from: new Date().toISOString().slice(0, 10),
    legal_source: "",
  });
  const [confirmando, setConfirmando] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const catalogo = useQuery({
    queryKey: ["retenciones", empresa.id],
    queryFn: async () => {
      const [conceptos, reglas] = await Promise.all([
        llamar<RetentionConcept[]>("/v1/retention-concepts"),
        llamar<RetentionRule[]>("/v1/retention-rules"),
      ]);
      return { conceptos, reglas };
    },
  });

  async function cargarRegla(): Promise<void> {
    setError(null);
    try {
      await llamar("/v1/retention-rules", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          jurisdiction: nueva.jurisdiction,
          retention_code: nueva.retention_code,
          concept_code: nueva.concept_code,
          formula_kind: nueva.formula_kind,
          rate: nueva.rate,
          ...(nueva.formula_kind === "rate_minus_subtrahend"
            ? {
                subtrahend: nueva.subtrahend,
                ...(nueva.minimum_exempt === "" ? {} : { minimum_exempt: nueva.minimum_exempt }),
              }
            : {}),
          effective_from: nueva.effective_from,
          legal_source: nueva.legal_source,
        }),
      });
      toast.success("Regla cargada", "Desde su vigencia, la empresa puede retener.");
      setNueva({ ...nueva, rate: "", subtrahend: "", minimum_exempt: "", legal_source: "" });
      await qc.invalidateQueries({ queryKey: ["retenciones", empresa.id] });
    } catch (e) {
      setError(e);
      throw e;
    }
  }

  const reglas = catalogo.data?.reglas;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4">
          <p className="flex items-start gap-2 text-[0.9rem]">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>
              El catálogo <strong>nace vacío a propósito</strong> (ADR-0039): Ladino no trae ningún
              porcentaje escrito. Sin regla vigente no se retiene — la factura se detiene con
              RETENTION_RULE_MISSING diciendo qué falta. Cargar una regla es un acto administrativo:{" "}
              <strong>exige citar la norma</strong>. VALIDAR-SENIAT.
            </span>
          </p>
        </CardContent>
      </Card>

      {reglas !== undefined && (
        <Card>
          <CardHeader>
            <CardTitle>Reglas vigentes ({reglas.length})</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-1">
            {reglas.length === 0 ? (
              <p className="px-4 pb-3 text-[0.88rem] text-muted-foreground">
                Sin reglas cargadas: la empresa todavía no puede practicar retenciones.
              </p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Tributo</TH>
                    <TH>Concepto</TH>
                    <TH>Fórmula</TH>
                    <TH className="text-right">Tasa</TH>
                    <TH className="text-right">Sustraendo</TH>
                    <TH>Desde</TH>
                    <TH>Norma</TH>
                  </TR>
                </THead>
                <TBody>
                  {reglas.map((r) => (
                    <TR key={r.id}>
                      <TD className="uppercase">{r.retention_code}</TD>
                      <TD>{r.concept_code}</TD>
                      <TD className="text-[0.82rem] text-muted-foreground">{r.formula_kind}</TD>
                      <TDNum>{mostrarCantidad(r.rate)}</TDNum>
                      <TDNum>{r.subtrahend !== null ? mostrarCantidad(r.subtrahend) : "—"}</TDNum>
                      <TD>{r.effective_from}</TD>
                      <TD className="max-w-56 truncate whitespace-normal text-[0.82rem]">
                        {r.legal_source}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {(comprobantes.data?.items ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Comprobantes emitidos ({comprobantes.data?.items.length ?? 0})</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-[0.88rem]">
              {(comprobantes.data?.items ?? []).map((r) => (
                <li key={r.id} className="flex justify-between gap-2 tabular-nums">
                  <span className="font-mono">
                    {r.series}-{String(r.receipt_number ?? "")}
                  </span>
                  <span className="text-muted-foreground">{r.issued_at?.slice(0, 10) ?? "—"}</span>
                  <span className="font-mono">
                    {mostrarImporte({
                      amount: r.retained_total,
                      currency: r.functional_currency,
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Cargar regla</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <FormField label="Tributo" required>
              {(a) => (
                <SimpleSelect
                  id={a.id}
                  value={nueva.retention_code}
                  onValueChange={(v) => setNueva({ ...nueva, retention_code: v, concept_code: "" })}
                  options={[
                    { value: "iva", label: "IVA" },
                    { value: "islr", label: "ISLR" },
                  ]}
                />
              )}
            </FormField>
            <FormField label="Concepto" required>
              {(a) => (
                <SimpleSelect
                  id={a.id}
                  value={nueva.concept_code === "" ? null : nueva.concept_code}
                  onValueChange={(v) => setNueva({ ...nueva, concept_code: v })}
                  placeholder="Elige…"
                  options={(catalogo.data?.conceptos ?? [])
                    .filter((c) => c.retention_code === nueva.retention_code)
                    .map((c) => ({ value: c.code, label: c.name }))}
                />
              )}
            </FormField>
            <FormField label="Fórmula" required>
              {(a) => (
                <SimpleSelect
                  id={a.id}
                  value={nueva.formula_kind}
                  onValueChange={(v) => setNueva({ ...nueva, formula_kind: v })}
                  options={[
                    { value: "rate", label: "base × tasa" },
                    { value: "rate_minus_subtrahend", label: "base × tasa − sustraendo" },
                  ]}
                />
              )}
            </FormField>
            <FormField label="Tasa" required hint="0.75 = 75 %">
              {(a) => (
                <Input
                  id={a.id}
                  inputMode="decimal"
                  className="text-right font-mono"
                  value={nueva.rate}
                  onChange={(e) => setNueva({ ...nueva, rate: e.target.value })}
                />
              )}
            </FormField>
            {nueva.formula_kind === "rate_minus_subtrahend" && (
              <>
                <FormField label="Sustraendo" required>
                  {(a) => (
                    <Input
                      id={a.id}
                      inputMode="decimal"
                      className="text-right font-mono"
                      value={nueva.subtrahend}
                      onChange={(e) => setNueva({ ...nueva, subtrahend: e.target.value })}
                    />
                  )}
                </FormField>
                <FormField label="Mínimo exento">
                  {(a) => (
                    <Input
                      id={a.id}
                      inputMode="decimal"
                      className="text-right font-mono"
                      value={nueva.minimum_exempt}
                      onChange={(e) => setNueva({ ...nueva, minimum_exempt: e.target.value })}
                    />
                  )}
                </FormField>
              </>
            )}
            <FormField label="Vigente desde" required>
              {(a) => (
                <DatePicker
                  id={a.id}
                  value={nueva.effective_from}
                  onChange={(v) => setNueva({ ...nueva, effective_from: v })}
                />
              )}
            </FormField>
            <FormField
              label="Norma (obligatoria)"
              required
              className="col-span-2"
              hint="Gaceta, providencia… Una regla sin norma citada es una retención inventada."
            >
              {(a) => (
                <Input
                  id={a.id}
                  value={nueva.legal_source}
                  onChange={(e) => setNueva({ ...nueva, legal_source: e.target.value })}
                />
              )}
            </FormField>
          </div>

          {error !== null && <MensajeError error={error} />}

          <Button
            variant="primary"
            disabled={
              nueva.concept_code === "" ||
              nueva.rate.trim() === "" ||
              nueva.legal_source.trim() === ""
            }
            onClick={() => setConfirmando(true)}
          >
            Cargar regla…
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmando}
        onOpenChange={setConfirmando}
        title="Cargar la regla de retención"
        confirmLabel="Cargar la regla"
        onConfirm={cargarRegla}
      >
        {nueva.retention_code.toUpperCase()} · {nueva.concept_code} · tasa{" "}
        <span className="font-mono">{nueva.rate}</span> desde {nueva.effective_from}, con fuente «
        {nueva.legal_source}». Desde su vigencia,{" "}
        <strong>toda factura que aplique la retendrá</strong>; la regla se copia en cada retención
        practicada y cambiarla después no altera lo ya retenido.
      </ConfirmDialog>
    </div>
  );
}

/**
 * REGISTRAR LA FACTURA DEL PROVEEDOR contra su orden (Nivel B de la auditoría
 * de superficie): el detalle de orden la LISTABA sin poder registrarla — solo
 * existía la compra simple. Las líneas nacen de la orden y se ajustan a lo
 * que la factura de papel diga; el matching de tres vías las vigila después.
 */
function RegistrarFacturaProveedor({
  detalle,
  onCerrar,
}: {
  detalle: PurchaseOrderDetail;
  onCerrar: (hecho: boolean) => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [nroFactura, setNroFactura] = useState("");
  const [nroControl, setNroControl] = useState("");
  const [fecha, setFecha] = useState(new Date().toISOString().slice(0, 10));
  const [lineas, setLineas] = useState(
    detalle.lines.map((l) => ({
      product_id: l.product_id,
      description: l.description,
      quantity: l.quantity,
      unit_price: l.unit_price_transaction,
    })),
  );
  const [error, setError] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);

  const listo =
    nroFactura.trim() !== "" &&
    nroControl.trim() !== "" &&
    lineas.some((l) => l.quantity.trim() !== "" && l.unit_price.trim() !== "");

  async function registrar(): Promise<void> {
    setError(null);
    setOcupado(true);
    try {
      await llamar("/v1/supplier-invoices", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          supplier_id: detalle.order.supplier_id,
          purchase_order_id: detalle.order.id,
          supplier_document_number: nroFactura.trim(),
          supplier_control_number: nroControl.trim(),
          invoice_date: fecha,
          currency: detalle.order.transaction_currency,
          lines: lineas
            .filter((l) => l.quantity.trim() !== "" && l.unit_price.trim() !== "")
            .map((l) => ({
              product_id: l.product_id,
              quantity: l.quantity.trim().replace(",", "."),
              unit_price: l.unit_price.trim().replace(",", "."),
            })),
        }),
      });
      toast.success("Factura registrada", "Entró a cuentas por pagar con su IVA resuelto.");
      onCerrar(true);
    } catch (e) {
      setError(e);
      toast.error("No se pudo registrar la factura");
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar(false)}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>Registrar la factura del proveedor</DialogTitle>
        <DialogDescription>
          Copia los datos DE LA FACTURA DE PAPEL: sus números, su fecha y sus cantidades. El
          matching de tres vías comparará contra la orden y lo recibido.
        </DialogDescription>
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <FormField label="Nº de la factura" required>
              {(a) => (
                <Input
                  id={a.id}
                  value={nroFactura}
                  onChange={(e) => setNroFactura(e.target.value)}
                />
              )}
            </FormField>
            <FormField label="Nº de control" required>
              {(a) => (
                <Input
                  id={a.id}
                  value={nroControl}
                  onChange={(e) => setNroControl(e.target.value)}
                />
              )}
            </FormField>
            <FormField label="Fecha de la factura" required>
              {(a) => <DatePicker id={a.id} value={fecha} onChange={setFecha} />}
            </FormField>
          </div>
          <div className="space-y-2">
            {lineas.map((l, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[0.9rem]">{l.description}</span>
                <Input
                  aria-label={`Cantidad facturada de ${l.description}`}
                  inputMode="decimal"
                  className="w-24 text-right font-mono"
                  value={l.quantity}
                  onChange={(e) =>
                    setLineas((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)),
                    )
                  }
                />
                <Input
                  aria-label={`Precio facturado de ${l.description}`}
                  inputMode="decimal"
                  className="w-28 text-right font-mono"
                  value={l.unit_price}
                  onChange={(e) =>
                    setLineas((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, unit_price: e.target.value } : x)),
                    )
                  }
                />
              </div>
            ))}
            <p className="text-[0.8rem] text-faint-foreground">
              Precio unitario sin IVA, en {detalle.order.transaction_currency}: el impuesto lo
              resuelve el sistema con la regla vigente. Deja en blanco la cantidad de lo que esta
              factura no trae.
            </p>
          </div>
          {error !== null && <MensajeError error={error} />}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onCerrar(false)}>
            Cancelar
          </Button>
          <Button variant="primary" disabled={!listo || ocupado} onClick={() => void registrar()}>
            {ocupado ? "Registrando…" : "Registrar la factura"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * NOTA DE CRÉDITO DEL PROVEEDOR (Nivel B): nos rebajó la deuda —devolvimos
 * mercancía o corrigió su factura— y el papel llega con sus números. Las
 * líneas se copian del papel; el sistema resuelve impuesto y saldo.
 */
function NotaCreditoProveedor({
  factura,
  onCerrar,
}: {
  factura: SupplierInvoice;
  onCerrar: (hecho: boolean) => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [nroNota, setNroNota] = useState("");
  const [fecha, setFecha] = useState(new Date().toISOString().slice(0, 10));
  const [motivo, setMotivo] = useState("");
  const [lineas, setLineas] = useState<
    { producto: EntityOption | null; quantity: string; unit_price: string }[]
  >([{ producto: null, quantity: "", unit_price: "" }]);
  const [error, setError] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);

  const validas = lineas.filter(
    (l) => l.producto !== null && l.quantity.trim() !== "" && l.unit_price.trim() !== "",
  );
  const listo = nroNota.trim() !== "" && motivo.trim().length >= 3 && validas.length > 0;

  async function registrar(): Promise<void> {
    setError(null);
    setOcupado(true);
    try {
      await llamar("/v1/supplier-credit-notes", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          supplier_invoice_id: factura.id,
          supplier_document_number: nroNota.trim(),
          note_date: fecha,
          reason: motivo.trim(),
          currency: factura.transaction_currency,
          lines: validas.map((l) => ({
            product_id: l.producto!.id,
            quantity: l.quantity.trim().replace(",", "."),
            unit_price: l.unit_price.trim().replace(",", "."),
          })),
        }),
      });
      toast.success("Nota de crédito registrada", "La deuda con el proveedor bajó.");
      onCerrar(true);
    } catch (e) {
      setError(e);
      toast.error("No se pudo registrar la nota");
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar(false)}>
      <DialogContent className="max-w-xl">
        <DialogTitle>Nota de crédito sobre {factura.supplier_document_number}</DialogTitle>
        <DialogDescription>
          Copia los datos del papel del proveedor. Rebaja lo que se debe de ESA factura.
        </DialogDescription>
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <FormField label="Nº de la nota" required>
              {(a) => (
                <Input id={a.id} value={nroNota} onChange={(e) => setNroNota(e.target.value)} />
              )}
            </FormField>
            <FormField label="Fecha" required>
              {(a) => <DatePicker id={a.id} value={fecha} onChange={setFecha} />}
            </FormField>
          </div>
          <FormField label="Motivo" required>
            {(a) => (
              <Input
                id={a.id}
                placeholder="Devolución de mercancía, corrección de precio…"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
              />
            )}
          </FormField>
          <div className="space-y-2">
            {lineas.map((l, i) => (
              <div key={i} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <EntityPicker
                    placeholder="Producto…"
                    value={l.producto}
                    onChange={(v) =>
                      setLineas((prev) => prev.map((x, j) => (j === i ? { ...x, producto: v } : x)))
                    }
                    buscar={async (q) => {
                      const r = await llamar<{ items: Product[] }>(
                        `/v1/products?search=${encodeURIComponent(q)}&per_page=8`,
                      );
                      return r.items.map((pr) => ({ id: pr.id, label: pr.name, detalle: pr.sku }));
                    }}
                  />
                </div>
                <Input
                  aria-label="Cantidad"
                  placeholder="Cant."
                  inputMode="decimal"
                  className="w-20 text-right font-mono"
                  value={l.quantity}
                  onChange={(e) =>
                    setLineas((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)),
                    )
                  }
                />
                <Input
                  aria-label="Precio unitario"
                  placeholder="P. unit."
                  inputMode="decimal"
                  className="w-24 text-right font-mono"
                  value={l.unit_price}
                  onChange={(e) =>
                    setLineas((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, unit_price: e.target.value } : x)),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="iconSm"
                  aria-label="Quitar línea"
                  disabled={lineas.length <= 1}
                  onClick={() => setLineas((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setLineas((prev) => [...prev, { producto: null, quantity: "", unit_price: "" }])
              }
            >
              <Plus /> Otra línea
            </Button>
          </div>
          {error !== null && <MensajeError error={error} />}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onCerrar(false)}>
            Cancelar
          </Button>
          <Button variant="primary" disabled={!listo || ocupado} onClick={() => void registrar()}>
            {ocupado ? "Registrando…" : "Registrar la nota"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
