import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus, Tags } from "lucide-react";
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
import { Badge } from "../../ui/badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../ui/dialog.js";
import { useToast } from "../../ui/toast.js";
import { mostrarCantidad, mostrarImporte } from "../../money.js";
import { MensajeError } from "../ventas/comunes.js";
import { errorDePersona } from "../../lib.js";
import type { PriceList, PriceItem, Product } from "../../lib.js";
import { fechaHoraLocal } from "../../fechas.js";

/**
 * Listas de precios — Fase B. La regla que esta pantalla ENSEÑA en vez de
 * esconder: un precio no se edita ni se borra (ADR-0032, append-only). Cargar
 * una vigencia nueva CIERRA la anterior en ese instante, y el historial de la
 * tabla es la prueba. La confirmación lo dice antes de escribir.
 */
export function Precios(): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const [seleccionada, setSeleccionada] = useState<PriceList | null>(null);
  const [creando, setCreando] = useState(false);
  const qc = useQueryClient();

  const listas = useQuery({
    queryKey: ["listas", empresa.id],
    queryFn: () => llamar<PriceList[]>("/v1/price-lists"),
  });
  const ajustes = useQuery({
    queryKey: ["ajustes", empresa.id],
    queryFn: () => llamar<{ sells_wholesale: boolean }>("/v1/company-settings"),
  });
  const alMayor = ajustes.data?.sells_wholesale === true;

  return (
    <div>
      <PageHeader
        title="Listas de precios"
        description="Los precios se ponen en dólares y se mantienen solos: la caja convierte a bolívares con la tasa BCV del día, y el recibo o la factura sale siempre en bolívares. La columna en Bs es la conversión de hoy, como referencia."
        actions={
          puede("price_list.manage") ? (
            <Button variant="primary" onClick={() => setCreando(true)}>
              <Plus /> Nueva lista
            </Button>
          ) : undefined
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Listas</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 px-2 pb-2">
            {(listas.data ?? []).map((l) => (
              <button
                key={l.id}
                onClick={() => setSeleccionada(l)}
                className={`w-full rounded-sm px-2 py-1.5 text-left text-[0.9rem] transition-colors ${
                  seleccionada?.id === l.id
                    ? "bg-accent-soft font-medium text-accent-soft-foreground"
                    : "hover:bg-surface-muted"
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate">{l.name}</span>
                  <Badge tone={l.status === "active" ? "accent" : "neutral"}>
                    {l.currency_code}
                  </Badge>
                </span>
                {l.is_caja_default === true && (
                  <Badge tone="accent" className="mt-1">
                    Predeterminada · la usa la caja
                  </Badge>
                )}
                {/* Heurística por NOMBRE: la lista no lleva un flag de «al
                    mayor» del servidor (solo `is_caja_default`). Cuando
                    exista el dato, se lee de la fila y esta regex se va. */}
                {alMayor && l.is_caja_default !== true && /mayor/i.test(l.name) && (
                  <Badge tone="info" className="mt-1">
                    Al mayor · clientes marcados
                  </Badge>
                )}
              </button>
            ))}
            {listas.data !== undefined && listas.data.length === 0 && (
              <p className="px-2 py-3 text-[0.85rem] text-muted-foreground">
                Sin listas todavía — sin lista no hay precio y sin precio no hay venta.
              </p>
            )}
          </CardContent>
        </Card>

        <div className="lg:col-span-3">
          {seleccionada === null ? (
            <Card>
              <CardContent className="py-10 text-center text-[0.9rem] text-muted-foreground">
                <Tags className="mx-auto mb-2 size-6 text-faint-foreground" />
                Elige una lista para ver su historial de vigencias y cargar precios.
              </CardContent>
            </Card>
          ) : (
            <PreciosDeLista
              lista={seleccionada}
              esPredeterminada={
                listas.data?.find((l) => l.id === seleccionada.id)?.is_caja_default === true
              }
              onPredeterminadaCambiada={() =>
                void qc.invalidateQueries({ queryKey: ["listas", empresa.id] })
              }
            />
          )}
        </div>
      </div>

      {creando && (
        <NuevaLista
          onCerrar={(hecha) => {
            setCreando(false);
            if (hecha) void qc.invalidateQueries({ queryKey: ["listas", empresa.id] });
          }}
        />
      )}
    </div>
  );
}

/**
 * El maestro ENTERO de productos, página a página (el endpoint tope a 100
 * por página): `/v1/price-lists/:id/prices` devuelve solo `product_id`, así
 * que el SKU y el nombre se resuelven aquí. Antes se pedía una sola página de
 * 100 y el producto 101 salía como un uuid en la tabla.
 */
async function todosLosProductos(
  llamar: <T>(path: string) => Promise<T>,
): Promise<Pick<Product, "id" | "sku" | "name">[]> {
  const POR_PAGINA = 100;
  const todos: Pick<Product, "id" | "sku" | "name">[] = [];
  let pagina = 1;
  for (;;) {
    const r = await llamar<{ items: Product[]; total: number }>(
      `/v1/products?per_page=${POR_PAGINA}&page=${pagina}`,
    );
    todos.push(...r.items.map((p) => ({ id: p.id, sku: p.sku, name: p.name })));
    if (r.items.length === 0 || todos.length >= r.total) return todos;
    pagina += 1;
  }
}

function NuevaLista({ onCerrar }: { onCerrar: (hecha: boolean) => void }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [nombre, setNombre] = useState("");
  // ADR-0046: los precios se anclan en dólares. La lista nace en USD, siempre;
  // el documento sale en Bs a la tasa del día — no hay decisión que ofrecer.
  const moneda = "USD";
  const [error, setError] = useState<unknown>(null);
  const [guardando, setGuardando] = useState(false);

  async function crear(): Promise<void> {
    setError(null);
    setGuardando(true);
    try {
      await llamar("/v1/price-lists", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id, name: nombre, currency_code: moneda }),
      });
      toast.success("Lista creada", `${nombre} (${moneda})`);
      onCerrar(true);
    } catch (e) {
      setError(e);
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar(false)}>
      <DialogContent>
        <DialogTitle>Nueva lista de precios</DialogTitle>
        <DialogDescription>
          Los precios se ponen en dólares y se mantienen solos cuando la tasa cambia: la caja
          convierte a bolívares al día, y el documento sale siempre en bolívares.
        </DialogDescription>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <FormField label="Nombre" required>
            {(a) => <Input id={a.id} value={nombre} onChange={(e) => setNombre(e.target.value)} />}
          </FormField>
          <FormField label="Moneda" hint="Siempre en dólares: es el ancla de los precios.">
            {(a) => <Input id={a.id} value="USD — Dólares" disabled readOnly />}
          </FormField>
        </div>
        {error !== null && (
          <div className="mt-3">
            <MensajeError error={error} />
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onCerrar(false)} disabled={guardando}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={guardando || nombre.trim() === ""}
            onClick={() => void crear()}
          >
            Crear lista
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreciosDeLista({
  lista,
  esPredeterminada,
  onPredeterminadaCambiada,
}: {
  lista: PriceList;
  esPredeterminada: boolean;
  onPredeterminadaCambiada: () => void;
}): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  const [producto, setProducto] = useState<EntityOption | null>(null);
  const [importe, setImporte] = useState("");
  const [desde, setDesde] = useState("");
  const [confirmando, setConfirmando] = useState(false);
  const [confirmandoDefault, setConfirmandoDefault] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const precios = useQuery({
    queryKey: ["precios-lista", empresa.id, lista.id],
    queryFn: async () => {
      const [r, prods] = await Promise.all([
        llamar<{
          items: PriceItem[];
          rate: { rate: string; rate_date: string; source: string } | null;
        }>(`/v1/price-lists/${lista.id}/prices`),
        todosLosProductos(llamar),
      ]);
      const skuDe = new Map(prods.map((p) => [p.id, `${p.sku} · ${p.name}`]));
      return {
        rate: r.rate,
        filas: r.items.map((i) => ({ ...i, producto: skuDe.get(i.product_id) ?? i.product_id })),
      };
    },
  });
  const tasa = precios.data?.rate ?? null;
  const gestiona = puede("price_list.manage");

  async function hacerPredeterminada(): Promise<void> {
    try {
      await llamar("/v1/company-settings", {
        method: "PUT",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ default_price_list_id: lista.id }),
      });
      toast.success("Lista predeterminada", "Las próximas ventas de caja usarán esta lista.");
      onPredeterminadaCambiada();
      void qc.invalidateQueries({ queryKey: ["ajustes", empresa.id] });
    } catch (e) {
      toast.error("No se pudo cambiar la predeterminada");
      setError(e);
    }
  }

  type Fila = PriceItem & { producto: string };
  const columnas = useMemo<ColumnDef<Fila, unknown>[]>(
    () => [
      { id: "producto", header: "Producto", accessorKey: "producto" },
      {
        // ADR-0046: las DOS columnas — el precio ancla (USD) y su conversión.
        id: "importe",
        header: () => <span className="block text-right">Precio ({lista.currency_code})</span>,
        accessorKey: "amount",
        enableSorting: false,
        cell: (c) => (
          <span className="block text-right tabular-nums">
            {mostrarImporte({ amount: c.row.original.amount, currency: c.row.original.currency })}
          </span>
        ),
      },
      {
        // La CONVERSIÓN la calcula el servidor con la tasa BCV de HOY —
        // también para filas históricas (la tasa se ancla al documento, no al
        // precio), y el encabezado lo dice. Sin tasa: «sin tasa del día».
        id: "equivalente",
        header: () => (
          <span className="block text-right">
            {lista.currency_code === "VES" ? "En dólares" : "En bolívares"}
            {tasa !== null ? (
              <span
                className="block text-[0.72rem] font-normal text-muted-foreground"
                title={`Tasa ${tasa.rate} · ${tasa.source} · ${tasa.rate_date}. Referencia de HOY, también para vigencias históricas.`}
              >
                al BCV de hoy ({mostrarCantidad(tasa.rate)})
              </span>
            ) : (
              <span className="block text-[0.72rem] font-normal text-warning-soft-foreground">
                — sin tasa del día
              </span>
            )}
          </span>
        ),
        enableSorting: false,
        cell: (c) =>
          c.row.original.equivalent_amount != null && c.row.original.equivalent_currency != null ? (
            <span className="block text-right text-muted-foreground tabular-nums">
              {mostrarImporte({
                amount: c.row.original.equivalent_amount,
                currency: c.row.original.equivalent_currency,
              })}
            </span>
          ) : (
            <span className="block text-right text-muted-foreground">—</span>
          ),
      },
      {
        id: "desde",
        header: "Desde",
        accessorFn: (i) => fechaHoraLocal(i.effective_from),
      },
      {
        id: "hasta",
        header: "Hasta",
        enableSorting: false,
        cell: (c) =>
          c.row.original.effective_to === null ? (
            <Badge tone="accent">Vigente</Badge>
          ) : (
            <span className="text-muted-foreground">
              {fechaHoraLocal(c.row.original.effective_to)}
            </span>
          ),
      },
    ],
    [tasa, lista.currency_code],
  );

  async function cargarPrecio(): Promise<void> {
    setError(null);
    // Una fecha escrita por la persona es la MEDIANOCHE de Caracas de ese día, no la de UTC.
    const cuando =
      desde === "" ? new Date().toISOString() : new Date(`${desde}T00:00:00-04:00`).toISOString();
    try {
      await llamar(`/v1/price-lists/${lista.id}/prices`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          product_id: producto?.id ?? "",
          amount: importe.trim(),
          effective_from: cuando,
        }),
      });
      toast.success("Precio cargado", "La vigencia anterior, si la había, quedó cerrada.");
      setImporte("");
      setDesde("");
      await qc.invalidateQueries({ queryKey: ["precios-lista", empresa.id, lista.id] });
    } catch (e) {
      setError(e);
      toast.error("No se pudo cargar el precio");
    }
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>
              Cargar precio en {lista.name} ({lista.currency_code})
            </CardTitle>
            {esPredeterminada && <Badge tone="accent">Predeterminada · la usa la caja</Badge>}
          </div>
          {!esPredeterminada && lista.status === "active" && puede("company.settings.manage") && (
            <Button variant="secondary" size="sm" onClick={() => setConfirmandoDefault(true)}>
              Hacer predeterminada
            </Button>
          )}
          {tasa === null && (
            <p className="text-[0.82rem] text-warning-soft-foreground">
              Sin tasa del día: la columna de equivalencia no puede calcularse.{" "}
              <Link to="/admin/facturacion-fiscal" className="underline">
                Cargar la tasa
              </Link>
            </p>
          )}
        </CardHeader>
        <CardContent>
          {!gestiona && (
            <p className="mb-3 text-[0.85rem] text-muted-foreground">
              Cargar precios exige el permiso de listas de precios: aquí solo se consultan.
            </p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <FormField label="Producto" required>
              {(a) => (
                <EntityPicker
                  id={a.id}
                  placeholder="SKU o nombre…"
                  value={producto}
                  onChange={setProducto}
                  disabled={!gestiona}
                  buscar={async (q) => {
                    const r = await llamar<{ items: Product[] }>(
                      `/v1/products?search=${encodeURIComponent(q)}&per_page=8`,
                    );
                    return r.items.map((p) => ({ id: p.id, label: p.name, detalle: p.sku }));
                  }}
                />
              )}
            </FormField>
            <FormField label={`Importe (${lista.currency_code})`} required>
              {(a) => (
                <MoneyInput
                  id={a.id}
                  value={importe}
                  onChange={setImporte}
                  currency={lista.currency_code}
                  disabled={!gestiona}
                />
              )}
            </FormField>
            <FormField label="Vigente desde" hint="Vacío = ahora mismo.">
              {(a) => (
                <Input
                  id={a.id}
                  type="datetime-local"
                  value={desde}
                  disabled={!gestiona}
                  onChange={(e) => setDesde(e.target.value)}
                />
              )}
            </FormField>
          </div>
          {error !== null && (
            <div className="mt-3">
              <MensajeError error={error} />
            </div>
          )}
          <div className="mt-3">
            <Button
              variant="primary"
              disabled={!gestiona || producto === null || !importeValido(importe)}
              onClick={() => setConfirmando(true)}
            >
              Cargar precio…
            </Button>
          </div>
        </CardContent>
      </Card>

      <DataTable
        columns={columnas}
        data={precios.data?.filas}
        error={precios.error === null ? null : errorDePersona(precios.error)}
        onRetry={() => void precios.refetch()}
        density="compact"
        exportCsv={{ filename: `precios-${lista.name}.csv` }}
        empty={{
          title: "Sin precios cargados",
          description:
            "El primer precio de cada producto abre su historial de vigencias — que nunca se edita, solo crece.",
        }}
      />

      <ConfirmDialog
        open={confirmandoDefault}
        onOpenChange={setConfirmandoDefault}
        title="Hacer predeterminada esta lista"
        confirmLabel="Hacer predeterminada"
        onConfirm={hacerPredeterminada}
      >
        <strong>Las próximas ventas de caja usarán esta lista</strong> ({lista.name},{" "}
        {lista.currency_code}): es la que /vender aplica al Consumidor final y a cualquier cliente
        sin lista preferida. Los clientes con preferida propia no cambian, y los documentos ya
        emitidos tampoco.
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmando}
        onOpenChange={setConfirmando}
        title="Cargar el precio"
        confirmLabel="Cargar el precio"
        onConfirm={cargarPrecio}
      >
        {producto?.label}:{" "}
        <span className="font-mono">
          {importe} {lista.currency_code}
        </span>{" "}
        desde {desde === "" ? "ahora mismo" : desde.replace("T", " ")}. Si hay un precio abierto
        anterior, <strong>su vigencia se cierra en ese instante</strong> — un precio no se edita ni
        se borra: el historial es la prueba (ADR-0032).
      </ConfirmDialog>
    </div>
  );
}
