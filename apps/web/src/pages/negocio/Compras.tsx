import { useCallback, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip, Plus, Receipt, ShoppingCart, Trash2 } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { errorDePersona } from "../../lib.js";
import { mostrarImporte } from "../../money.js";
import { compararImportes, esCero } from "../../components/decimal-compare.js";
import { Button } from "../../ui/button.js";
import { Card, Skeleton } from "../../ui/card.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../ui/dialog.js";
import { Input } from "../../ui/input.js";
import { SimpleSelect } from "../../ui/select.js";
import { Switch } from "../../ui/switch.js";
import { useToast } from "../../ui/toast.js";
import {
  EntityPicker,
  FormField,
  MoneyInput,
  importeValido,
  type EntityOption,
} from "../../components/forms.js";
import { fechaRelativa } from "./comunes.js";

/**
 * COMPRAS Y GASTOS (Fase C, PARTE 10): lo que el negocio paga. Dos mundos en
 * una pantalla — la COMPRA de mercancía (con la factura del proveedor, entra
 * al depósito y a la deuda) y el GASTO que no es mercancía (alquiler, luz,
 * nómina: sale de una cuenta y va a contabilidad solo). Todo importe lo
 * calcula el servidor; los totales de la factura llegan con su IVA puesto.
 */

interface Proveedor {
  id: string;
  legal_name: string;
  tax_id: string | null;
}
interface FacturaProveedor {
  id: string;
  supplier_id: string;
  supplier_document_number: string;
  invoice_date: string;
  status: string;
  total_amount: string;
  transaction_currency: string;
  balance: string;
}
interface Gasto {
  id: string;
  category: string;
  description: string | null;
  paid_at: string;
  amount: string;
  currency: string;
  is_recurring: boolean;
}
interface Cuenta {
  id: string;
  name: string;
  currency: string;
  is_active: boolean;
  is_system: boolean;
}
interface ProductoFila {
  id: string;
  sku: string;
  name: string;
  kind: "good" | "service";
}
interface FormaDePago {
  id: string;
  name: string;
  kind: string;
  account_id: string;
  is_active: boolean;
}

const CANT_RE = /^\d{1,16}(\.\d{1,8})?$/;
const POR_PAGINA = 20;
const CATEGORIAS_GASTO = [
  "Alquiler",
  "Luz",
  "Agua",
  "Internet",
  "Nómina",
  "Flete",
  "Publicidad",
  "Mantenimiento",
];

/**
 * Con qué se le PAGA a un proveedor: el `PurchaseInstrument` de
 * packages/schemas. Es un subconjunto de las formas de COBRO configurables:
 * «Cashea» cobra, pero no paga a un proveedor, y una forma configurada con un
 * tipo fuera de esta lista no se ofrece aquí.
 */
const FORMAS_DE_COMPRA = [
  { value: "transferencia", label: "Transferencia", moneda: "VES" },
  { value: "pago_movil", label: "Pago móvil", moneda: "VES" },
  { value: "efectivo_bs", label: "Efectivo Bs.", moneda: "VES" },
  { value: "efectivo_usd", label: "Efectivo USD", moneda: "USD" },
  { value: "zelle", label: "Zelle", moneda: "USD" },
  { value: "usdt", label: "USDT", moneda: "USD" },
  { value: "punto_venta", label: "Punto de venta", moneda: "VES" },
  { value: "tarjeta", label: "Tarjeta", moneda: "VES" },
  { value: "otro", label: "Otra", moneda: "VES" },
] as const;
type FormaDeCompra = (typeof FORMAS_DE_COMPRA)[number]["value"];
const ES_FORMA_DE_COMPRA = new Set<string>(FORMAS_DE_COMPRA.map((i) => i.value));
function esFormaDeCompra(kind: string): kind is FormaDeCompra {
  return ES_FORMA_DE_COMPRA.has(kind);
}
function monedaDeForma(kind: string): string {
  return FORMAS_DE_COMPRA.find((i) => i.value === kind)?.moneda ?? "VES";
}

const MONEDAS_COMPRA = [
  { value: "VES", label: "Bolívares (Bs.)" },
  { value: "USD", label: "Dólares (USD)" },
];

/** La misma cara para todo listado que no pudo cargar: el motivo y el reintento. */
function ErrorDeLista({
  error,
  onReintentar,
}: {
  error: unknown;
  onReintentar: () => void;
}): React.JSX.Element {
  return (
    <Card className="py-8 text-center" role="alert">
      <p className="font-medium">No se pudo cargar</p>
      <p className="mx-auto mt-1 max-w-sm text-[0.9rem] text-muted-foreground">
        {errorDePersona(error)}
      </p>
      <Button variant="secondary" className="mt-4" onClick={onReintentar}>
        Reintentar
      </Button>
    </Card>
  );
}

function ListaCargando(): React.JSX.Element {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Cargando">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

export function ComprasNegocio(): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const qc = useQueryClient();
  // ADR-0048: el GASTO revela la estructura de costos — es del administrador.
  // El encargado entra por la mercancía: su pestaña inicial es Compras y la
  // de Gastos ni se le enseña.
  const puedeGastos = puede("expense.read");
  const puedeComprar = puede("purchase.invoice.register");
  const [pestana, setPestana] = useState<"gastos" | "compras">(puedeGastos ? "gastos" : "compras");
  const [nuevoGasto, setNuevoGasto] = useState(false);
  const [nuevaCompra, setNuevaCompra] = useState(false);
  const [pagando, setPagando] = useState<FacturaProveedor | null>(null);
  const puedePagar = puede("purchase.payment.register");

  // PAGINADO DE VERDAD (auditoría 2026-09-11): antes se pedía la primera
  // página y el `total` del servidor se tiraba. Se acumulan páginas, como en
  // Productos, y la pantalla dice cuántas hay de cuántas.
  const gastos = useInfiniteQuery({
    queryKey: ["gastos", empresa.id],
    enabled: puedeGastos,
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      llamar<{ items: Gasto[]; total: number }>(
        `/v1/expenses?per_page=${POR_PAGINA}&page=${pageParam}`,
      ),
    getNextPageParam: (ultima, todas) => {
      const cargados = todas.reduce((n, p) => n + p.items.length, 0);
      return cargados < ultima.total ? todas.length + 1 : undefined;
    },
  });
  const facturas = useInfiniteQuery({
    queryKey: ["facturas-prov", empresa.id],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      llamar<{ items: FacturaProveedor[]; total: number }>(
        `/v1/supplier-invoices?per_page=${POR_PAGINA}&page=${pageParam}`,
      ),
    getNextPageParam: (ultima, todas) => {
      const cargados = todas.reduce((n, p) => n + p.items.length, 0);
      return cargados < ultima.total ? todas.length + 1 : undefined;
    },
  });
  const proveedores = useQuery({
    queryKey: ["proveedores", empresa.id],
    queryFn: () => llamar<{ items: Proveedor[] }>("/v1/suppliers?per_page=100"),
  });

  const recargar = () => {
    void qc.invalidateQueries({ queryKey: ["gastos", empresa.id] });
    void qc.invalidateQueries({ queryKey: ["facturas-prov", empresa.id] });
    void qc.invalidateQueries({ queryKey: ["proveedores", empresa.id] });
    void qc.invalidateQueries({ queryKey: ["negocio-resumen", empresa.id] });
  };

  const nombreProveedor = useMemo(() => {
    const m = new Map((proveedores.data?.items ?? []).map((p) => [p.id, p.legal_name]));
    return (id: string) => m.get(id) ?? "Proveedor";
  }, [proveedores.data]);

  const listaGastos = gastos.data?.pages.flatMap((p) => p.items) ?? [];
  const totalGastos = gastos.data?.pages[0]?.total ?? 0;
  const listaFacturas = facturas.data?.pages.flatMap((p) => p.items) ?? [];
  const totalFacturas = facturas.data?.pages[0]?.total ?? 0;

  const pestanas = [
    ...(puedeGastos ? ([["gastos", "Gastos"]] as const) : []),
    ["compras", "Compras a proveedores"],
  ] as const;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">Compras y gastos</h1>
        <div className="flex-1" />
        {puedeComprar && (
          <Button variant="secondary" onClick={() => setNuevaCompra(true)}>
            <ShoppingCart /> Registrar compra
          </Button>
        )}
        {puedeGastos && (
          <Button variant="primary" onClick={() => setNuevoGasto(true)}>
            <Plus /> Registrar gasto
          </Button>
        )}
      </div>

      <div className="flex gap-1 border-b border-border" role="tablist" aria-label="Qué ver">
        {pestanas.map(([clave, etiqueta]) => (
          <button
            key={clave}
            id={`compras-tab-${clave}`}
            role="tab"
            aria-selected={pestana === clave}
            aria-controls={`compras-panel-${clave}`}
            tabIndex={pestana === clave ? 0 : -1}
            onClick={() => setPestana(clave)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              const i = pestanas.findIndex(([c]) => c === clave);
              const destino =
                pestanas[
                  (i + (e.key === "ArrowRight" ? 1 : -1) + pestanas.length) % pestanas.length
                ];
              if (destino !== undefined) {
                e.preventDefault();
                setPestana(destino[0]);
                document.getElementById(`compras-tab-${destino[0]}`)?.focus();
              }
            }}
            className={`border-b-2 px-3 py-2 text-[0.92rem] ${
              pestana === clave
                ? "border-accent font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {etiqueta}
          </button>
        ))}
      </div>

      {pestana === "gastos" ? (
        <div role="tabpanel" id="compras-panel-gastos" aria-labelledby="compras-tab-gastos">
          {gastos.isPending ? (
            <ListaCargando />
          ) : gastos.isError ? (
            <ErrorDeLista error={gastos.error} onReintentar={() => void gastos.refetch()} />
          ) : listaGastos.length === 0 ? (
            <Card className="py-12 text-center">
              <Receipt className="mx-auto size-8 text-faint-foreground" />
              <p className="mt-2 font-medium">Todavía no hay gastos registrados</p>
              <p className="mx-auto mt-1 max-w-sm text-[0.9rem] text-muted-foreground">
                El alquiler, la luz, la nómina: anotarlos aquí es lo que hace que «Lo que gané» diga
                la verdad.
              </p>
              <Button variant="primary" className="mt-4" onClick={() => setNuevoGasto(true)}>
                <Plus /> Registrar gasto
              </Button>
            </Card>
          ) : (
            <>
              <div className="divide-y divide-border rounded-md border border-border bg-surface">
                {listaGastos.map((g) => (
                  <div key={g.id} className="flex items-center gap-3 px-3 py-2.5 text-[0.9rem]">
                    <span className="w-20 shrink-0 text-[0.82rem] text-muted-foreground">
                      {fechaRelativa(g.paid_at)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      <strong>{g.category}</strong>
                      {g.description !== null && (
                        <span className="text-muted-foreground"> — {g.description}</span>
                      )}
                      {g.is_recurring && (
                        <span className="ml-1.5 rounded-full bg-surface-muted px-1.5 py-0.5 text-[0.7rem] text-muted-foreground">
                          todos los meses
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 font-medium tabular-nums">
                      {mostrarImporte({ amount: g.amount, currency: g.currency })}
                    </span>
                  </div>
                ))}
              </div>
              <PieDePaginas
                mostrados={listaGastos.length}
                total={totalGastos}
                hayMas={gastos.hasNextPage}
                cargando={gastos.isFetchingNextPage}
                onMas={() => void gastos.fetchNextPage()}
              />
            </>
          )}
        </div>
      ) : (
        <div role="tabpanel" id="compras-panel-compras" aria-labelledby="compras-tab-compras">
          {facturas.isPending ? (
            <ListaCargando />
          ) : facturas.isError ? (
            <ErrorDeLista error={facturas.error} onReintentar={() => void facturas.refetch()} />
          ) : listaFacturas.length === 0 ? (
            <Card className="py-12 text-center">
              <ShoppingCart className="mx-auto size-8 text-faint-foreground" />
              <p className="mt-2 font-medium">Sin compras registradas</p>
              <p className="mx-auto mt-1 max-w-sm text-[0.9rem] text-muted-foreground">
                Cuando llegue mercancía con su factura, regístrala aquí: entra al depósito y queda
                claro cuánto le debes a cada proveedor.
              </p>
              {puedeComprar && (
                <Button variant="primary" className="mt-4" onClick={() => setNuevaCompra(true)}>
                  <ShoppingCart /> Registrar compra
                </Button>
              )}
            </Card>
          ) : (
            <>
              <div className="divide-y divide-border rounded-md border border-border bg-surface">
                {listaFacturas.map((f) => (
                  <div key={f.id} className="flex items-center gap-3 px-3 py-2.5 text-[0.9rem]">
                    <span className="w-20 shrink-0 text-[0.82rem] text-muted-foreground">
                      {fechaRelativa(f.invoice_date)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      <strong>{nombreProveedor(f.supplier_id)}</strong>
                      <span className="text-muted-foreground">
                        {" "}
                        · Factura {f.supplier_document_number}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {mostrarImporte({ amount: f.total_amount, currency: f.transaction_currency })}
                    </span>
                    {esCero(f.balance) || compararImportes(f.balance, "0") < 0 ? (
                      <span className="shrink-0 text-[0.8rem] text-success-soft-foreground">
                        Pagada
                      </span>
                    ) : (
                      <>
                        <span className="shrink-0 text-[0.8rem] text-warning-soft-foreground tabular-nums">
                          Debo{" "}
                          {mostrarImporte({ amount: f.balance, currency: f.transaction_currency })}
                        </span>
                        {puedePagar && (
                          <Button variant="secondary" size="sm" onClick={() => setPagando(f)}>
                            Pagar
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
              <PieDePaginas
                mostrados={listaFacturas.length}
                total={totalFacturas}
                hayMas={facturas.hasNextPage}
                cargando={facturas.isFetchingNextPage}
                onMas={() => void facturas.fetchNextPage()}
              />
            </>
          )}
        </div>
      )}

      {nuevoGasto && <RegistrarGasto onCerrar={() => setNuevoGasto(false)} onListo={recargar} />}
      {pagando !== null && (
        <PagarFactura
          factura={pagando}
          proveedor={nombreProveedor(pagando.supplier_id)}
          onCerrar={() => setPagando(null)}
          onPagada={() => {
            setPagando(null);
            recargar();
          }}
        />
      )}
      {nuevaCompra && (
        <RegistrarCompra
          proveedores={proveedores.data?.items ?? []}
          onCerrar={() => setNuevaCompra(false)}
          onListo={recargar}
        />
      )}
    </div>
  );
}

function PieDePaginas({
  mostrados,
  total,
  hayMas,
  cargando,
  onMas,
}: {
  mostrados: number;
  total: number;
  hayMas: boolean;
  cargando: boolean;
  onMas: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-center gap-3 pt-3">
      <span className="text-[0.86rem] text-muted-foreground">
        Mostrando {mostrados} de {total}
      </span>
      {hayMas && (
        <Button variant="secondary" onClick={onMas} disabled={cargando}>
          {cargando ? "Cargando…" : "Mostrar más"}
        </Button>
      )}
    </div>
  );
}

function RegistrarGasto({
  onCerrar,
  onListo,
}: {
  onCerrar: () => void;
  onListo: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [categoria, setCategoria] = useState<string | null>(null);
  const [otraCategoria, setOtraCategoria] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [cuenta, setCuenta] = useState<string | null>(null);
  const [monto, setMonto] = useState("");
  const [recurrente, setRecurrente] = useState(false);
  const [adjunto, setAdjunto] = useState<File | null>(null);
  // La RUTA del comprobante ya subido. La API exige subirlo ANTES de crear el
  // gasto; si el gasto falla después, la ruta se conserva y el reintento la
  // reusa en vez de subir el archivo otra vez (auditoría 2026-09-11).
  const [adjuntoSubido, setAdjuntoSubido] = useState<{ archivo: File; ruta: string } | null>(null);

  const cuentas = useQuery({
    queryKey: ["cuentas", empresa.id],
    queryFn: () => llamar<{ accounts: Cuenta[] }>("/v1/treasury/accounts"),
  });
  const activas = (cuentas.data?.accounts ?? []).filter((c) => c.is_active && !c.is_system);
  const monedaCuenta = activas.find((c) => c.id === cuenta)?.currency ?? "VES";

  const categoriaFinal = categoria === "otro" ? otraCategoria.trim() : (categoria ?? "");
  const listo =
    categoriaFinal.length >= 2 && cuenta !== null && importeValido(monto.trim().replace(",", "."));

  const registrar = useMutation({
    mutationFn: async () => {
      let attachment: string | undefined;
      if (adjunto !== null) {
        if (adjuntoSubido !== null && adjuntoSubido.archivo === adjunto) {
          attachment = adjuntoSubido.ruta;
        } else {
          const form = new FormData();
          form.append("file", adjunto);
          const r = await llamar<{ attachment_path: string }>("/v1/expenses/attachment", {
            method: "POST",
            body: form,
          });
          attachment = r.attachment_path;
          setAdjuntoSubido({ archivo: adjunto, ruta: r.attachment_path });
        }
      }
      return llamar("/v1/expenses", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          category: categoriaFinal,
          ...(descripcion.trim() === "" ? {} : { description: descripcion.trim() }),
          account_id: cuenta,
          amount: monto.trim().replace(",", "."),
          ...(recurrente ? { is_recurring: true } : {}),
          ...(attachment === undefined ? {} : { attachment_path: attachment }),
        }),
      });
    },
    onSuccess: () => {
      toast.success("Gasto registrado", `${categoriaFinal} quedó anotado y salió de tu cuenta.`);
      onListo();
      onCerrar();
    },
    onError: (e) => toast.error("No se pudo registrar", errorDePersona(e)),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Registrar gasto</DialogTitle>
        <DialogDescription>Lo que pagas y no es mercancía para vender.</DialogDescription>
        <div className="space-y-3 pt-2">
          <div>
            <p className="pb-1.5 text-[0.88rem] font-medium" id="gasto-categoria-titulo">
              ¿Qué pagaste?
            </p>
            <div
              className="flex flex-wrap gap-1.5"
              role="group"
              aria-labelledby="gasto-categoria-titulo"
            >
              {CATEGORIAS_GASTO.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  aria-pressed={categoria === cat}
                  onClick={() => setCategoria(cat)}
                  className={`rounded-full border px-3 py-1.5 text-[0.85rem] ${
                    categoria === cat
                      ? "border-accent bg-accent-soft text-accent-soft-foreground"
                      : "border-border hover:bg-surface-muted"
                  }`}
                >
                  {cat}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={categoria === "otro"}
                onClick={() => setCategoria("otro")}
                className={`rounded-full border px-3 py-1.5 text-[0.85rem] ${
                  categoria === "otro"
                    ? "border-accent bg-accent-soft text-accent-soft-foreground"
                    : "border-border hover:bg-surface-muted"
                }`}
              >
                Otro…
              </button>
            </div>
            {categoria === "otro" && (
              <Input
                className="mt-2"
                value={otraCategoria}
                onChange={(e) => setOtraCategoria(e.target.value)}
                placeholder="¿Qué fue?"
                aria-label="Categoría del gasto"
                autoFocus
              />
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <FormField label="¿De qué cuenta salió?" required>
              {(p) => (
                <SimpleSelect
                  id={p.id}
                  value={cuenta}
                  onValueChange={setCuenta}
                  options={activas.map((c) => ({
                    value: c.id,
                    label: `${c.name} (${c.currency === "VES" ? "Bs." : c.currency})`,
                  }))}
                  placeholder={activas.length === 0 ? "Crea una cuenta en Mi dinero" : "Elige…"}
                />
              )}
            </FormField>
            <FormField label="¿Cuánto?" required>
              {(p) => (
                <MoneyInput
                  {...p}
                  value={monto}
                  onChange={setMonto}
                  currency={monedaCuenta === "VES" ? "Bs." : monedaCuenta}
                />
              )}
            </FormField>
          </div>
          <FormField label="Algo más que anotar">
            {(p) => (
              <Input
                {...p}
                value={descripcion}
                onChange={(e) => setDescripcion(e.target.value)}
                placeholder="Alquiler de septiembre"
              />
            )}
          </FormField>
          <label className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
            <span className="text-[0.9rem]">
              Se paga todos los meses
              <span className="block text-[0.78rem] text-muted-foreground">
                Para recordártelo cuando toque.
              </span>
            </span>
            <Switch
              checked={recurrente}
              onCheckedChange={setRecurrente}
              aria-label="Se paga todos los meses"
            />
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-[0.88rem] text-muted-foreground">
            <Paperclip className="size-4" />
            {adjunto === null ? "Adjuntar el comprobante (foto o PDF)" : adjunto.name}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              className="hidden"
              onChange={(e) => setAdjunto(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={!listo || registrar.isPending}
            onClick={() => registrar.mutate()}
          >
            {registrar.isPending ? "Guardando…" : "Registrar gasto"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface LineaCompra {
  /** Identidad ESTABLE de la fila: la clave de React no puede ser el índice. */
  id: string;
  producto: EntityOption | null;
  cantidad: string;
  precio: string;
}

function lineaVacia(): LineaCompra {
  return { id: crypto.randomUUID(), producto: null, cantidad: "", precio: "" };
}

function RegistrarCompra({
  proveedores,
  onCerrar,
  onListo,
}: {
  proveedores: Proveedor[];
  onCerrar: () => void;
  onListo: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [proveedor, setProveedor] = useState<string | null>(null);
  const [creandoProveedor, setCreandoProveedor] = useState(false);
  const [nuevoNombre, setNuevoNombre] = useState("");
  const [nuevoRif, setNuevoRif] = useState("");
  const [nroFactura, setNroFactura] = useState("");
  const [nroControl, setNroControl] = useState("");
  const [lineas, setLineas] = useState<LineaCompra[]>(() => [lineaVacia()]);
  const [pagarAhora, setPagarAhora] = useState(false);
  const [forma, setForma] = useState<string | null>(null);
  // La moneda de la factura del proveedor: la de los precios unitarios. Por
  // defecto sigue a la forma de pago elegida (Zelle → USD) y la persona puede
  // cambiarla.
  const [moneda, setMoneda] = useState("VES");
  const qc = useQueryClient();

  // El catálogo NO se trae entero (antes: `per_page=100` y los demás no
  // existían): cada línea busca en el servidor por nombre o código. Solo
  // bienes — un servicio no entra a un depósito.
  const buscarProducto = useCallback(
    async (q: string): Promise<EntityOption[]> => {
      const r = await llamar<{ items: ProductoFila[] }>(
        `/v1/products?only_active=1&per_page=50${q === "" ? "" : `&search=${encodeURIComponent(q)}`}`,
      );
      return r.items
        .filter((p) => p.kind === "good")
        .map((p) => ({ id: p.id, label: p.name, detalle: p.sku }));
    },
    [llamar],
  );
  const formas = useQuery({
    queryKey: ["formas-pago", empresa.id],
    enabled: pagarAhora,
    queryFn: () => llamar<{ methods: FormaDePago[] }>("/v1/payment-methods"),
  });
  const ajustes = useQuery({
    queryKey: ["ajustes", empresa.id],
    staleTime: 5 * 60_000,
    queryFn: () => llamar<{ default_warehouse_id: string | null }>("/v1/company-settings"),
  });
  const depositos = useQuery({
    queryKey: ["depositos", empresa.id],
    staleTime: 5 * 60_000,
    queryFn: () => llamar<{ id: string; name: string }[]>("/v1/warehouses"),
  });
  const deposito = ajustes.data?.default_warehouse_id ?? depositos.data?.[0]?.id ?? null;
  const buscandoDeposito = ajustes.isPending || depositos.isPending;

  /**
   * Las formas con las que se paga: las CONFIGURADAS cuyo tipo sea un
   * forma de pago de compra (con su cuenta), más las base que ninguna
   * configurada cubra — la misma regla que los botones de Cobrar.
   */
  const opcionesDePago = useMemo(() => {
    const configuradas = (formas.data?.methods ?? []).filter(
      (f) => f.is_active && esFormaDeCompra(f.kind),
    );
    const cubiertos = new Set(configuradas.map((f) => f.kind));
    return [
      ...configuradas.map((f) => ({ value: f.id, label: f.name })),
      ...FORMAS_DE_COMPRA.filter((i) => !cubiertos.has(i.value)).map((i) => ({
        value: i.value,
        label: i.label,
      })),
    ];
  }, [formas.data]);

  function elegirForma(v: string): void {
    setForma(v);
    const configurada = (formas.data?.methods ?? []).find((f) => f.id === v);
    setMoneda(monedaDeForma(configurada?.kind ?? v));
  }

  const crearProveedor = useMutation({
    mutationFn: () =>
      llamar<{ id: string }>("/v1/suppliers", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        // El tipo de persona y de contribuyente los INFIERE el servidor del
        // prefijo del RIF: la pantalla no decide nada tributario.
        body: JSON.stringify({
          company_id: empresa.id,
          legal_name: nuevoNombre.trim(),
          tax_id: nuevoRif.trim() === "" ? null : nuevoRif.trim().toUpperCase(),
          supplier_kind: "nacional",
        }),
      }),
    onSuccess: (r) => {
      toast.success("Proveedor agregado");
      setProveedor(r.id);
      setCreandoProveedor(false);
      void qc.invalidateQueries({ queryKey: ["proveedores", empresa.id] });
    },
    onError: (e) => toast.error("No se pudo agregar el proveedor", errorDePersona(e)),
  });

  const lineasValidas = lineas.filter(
    (l) =>
      l.producto !== null &&
      CANT_RE.test(l.cantidad.trim().replace(",", ".")) &&
      !esCero(l.cantidad) &&
      importeValido(l.precio.trim().replace(",", ".")),
  );
  const listo =
    proveedor !== null &&
    deposito !== null &&
    nroFactura.trim() !== "" &&
    nroControl.trim() !== "" &&
    lineasValidas.length > 0 &&
    lineasValidas.length === lineas.filter((l) => l.producto !== null).length &&
    (!pagarAhora || forma !== null);

  const registrar = useMutation({
    mutationFn: () => {
      const configurada = (formas.data?.methods ?? []).find((f) => f.id === forma);
      // La forma configurada manda su forma de pago Y su cuenta; una forma base
      // manda solo la forma de pago. Nada fuera del enum sale de aquí.
      const pago =
        !pagarAhora || forma === null
          ? null
          : configurada !== undefined
            ? esFormaDeCompra(configurada.kind)
              ? { instrument: configurada.kind, account_id: configurada.account_id }
              : null
            : esFormaDeCompra(forma)
              ? { instrument: forma }
              : null;
      if (pagarAhora && pago === null) {
        return Promise.reject(new Error("Esa forma no sirve para pagar a un proveedor."));
      }
      return llamar("/v1/purchases/simple", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          supplier_id: proveedor,
          warehouse_id: deposito,
          currency: moneda,
          supplier_document_number: nroFactura.trim(),
          supplier_control_number: nroControl.trim(),
          lines: lineasValidas.map((l) => ({
            product_id: l.producto!.id,
            quantity: l.cantidad.trim().replace(",", "."),
            unit_price: l.precio.trim().replace(",", "."),
          })),
          ...(pago === null ? {} : { payment: pago }),
        }),
      });
    },
    onSuccess: () => {
      toast.success(
        "Compra registrada",
        pagarAhora
          ? "La mercancía entró y la factura quedó pagada."
          : "La mercancía entró; la factura queda por pagar.",
      );
      onListo();
      onCerrar();
    },
    onError: (e) => toast.error("No se pudo registrar la compra", errorDePersona(e)),
  });

  const etiquetaMoneda = moneda === "VES" ? "Bs." : moneda;

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-lg">
        <DialogTitle>Registrar compra</DialogTitle>
        <DialogDescription>
          Mercancía con la factura del proveedor: entra al depósito y a lo que debes.
        </DialogDescription>
        <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1 pt-2">
          {!creandoProveedor ? (
            <div className="flex items-end gap-2">
              <FormField label="Proveedor" required className="flex-1">
                {(p) => (
                  <SimpleSelect
                    id={p.id}
                    value={proveedor}
                    onValueChange={setProveedor}
                    options={proveedores.map((s) => ({ value: s.id, label: s.legal_name }))}
                    placeholder="Elige el proveedor…"
                  />
                )}
              </FormField>
              <Button variant="secondary" onClick={() => setCreandoProveedor(true)}>
                <Plus /> Nuevo
              </Button>
            </div>
          ) : (
            <div className="space-y-2 rounded-md border border-border p-3">
              <FormField label="Nombre del proveedor" required>
                {(p) => (
                  <Input
                    {...p}
                    value={nuevoNombre}
                    onChange={(e) => setNuevoNombre(e.target.value)}
                    autoFocus
                  />
                )}
              </FormField>
              <FormField label="RIF" required hint="El de la factura que te entregó.">
                {(p) => (
                  <Input {...p} value={nuevoRif} onChange={(e) => setNuevoRif(e.target.value)} />
                )}
              </FormField>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setCreandoProveedor(false)}>
                  Cancelar
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={
                    nuevoNombre.trim() === "" || nuevoRif.trim() === "" || crearProveedor.isPending
                  }
                  onClick={() => crearProveedor.mutate()}
                >
                  Agregar
                </Button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <FormField label="N° de la factura" required>
              {(p) => (
                <Input {...p} value={nroFactura} onChange={(e) => setNroFactura(e.target.value)} />
              )}
            </FormField>
            <FormField
              label="N° impreso de la factura"
              required
              hint="El que trae impresa la factura del proveedor."
            >
              {(p) => (
                <Input {...p} value={nroControl} onChange={(e) => setNroControl(e.target.value)} />
              )}
            </FormField>
          </div>

          <FormField label="Moneda de la factura" required hint="La de los precios que trae.">
            {(p) => (
              <SimpleSelect
                id={p.id}
                value={moneda}
                onValueChange={setMoneda}
                options={MONEDAS_COMPRA}
              />
            )}
          </FormField>

          <div className="space-y-2">
            <p className="text-[0.88rem] font-medium">¿Qué llegó?</p>
            {lineas.map((l, i) => (
              <div key={l.id} className="flex items-start gap-2">
                <div className="flex-1">
                  <label htmlFor={`compra-producto-${l.id}`} className="sr-only">
                    Producto de la línea {i + 1}
                  </label>
                  <EntityPicker
                    id={`compra-producto-${l.id}`}
                    value={l.producto}
                    onChange={(v) =>
                      setLineas((prev) =>
                        prev.map((x) => (x.id === l.id ? { ...x, producto: v } : x)),
                      )
                    }
                    buscar={buscarProducto}
                    placeholder="Producto…"
                  />
                </div>
                <Input
                  inputMode="decimal"
                  value={l.cantidad}
                  onChange={(e) =>
                    setLineas((prev) =>
                      prev.map((x) => (x.id === l.id ? { ...x, cantidad: e.target.value } : x)),
                    )
                  }
                  placeholder="Cant."
                  className="w-20"
                  aria-label={`Cantidad de la línea ${i + 1}`}
                />
                <div className="w-32">
                  <label htmlFor={`compra-precio-${l.id}`} className="sr-only">
                    Precio de la línea {i + 1}
                  </label>
                  <MoneyInput
                    id={`compra-precio-${l.id}`}
                    value={l.precio}
                    onChange={(v) =>
                      setLineas((prev) =>
                        prev.map((x) => (x.id === l.id ? { ...x, precio: v } : x)),
                      )
                    }
                    currency={etiquetaMoneda}
                  />
                </div>
                {lineas.length > 1 && (
                  <Button
                    variant="ghost"
                    size="iconSm"
                    aria-label={`Quitar la línea ${i + 1}`}
                    onClick={() => setLineas((prev) => prev.filter((x) => x.id !== l.id))}
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLineas((prev) => [...prev, lineaVacia()])}
            >
              <Plus /> Otro producto
            </Button>
            <p className="text-[0.8rem] text-faint-foreground">
              El precio es por unidad y sin IVA: el impuesto lo pone el sistema con la regla
              vigente.
            </p>
          </div>

          <label className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
            <span className="text-[0.9rem]">
              La pagué completa ya
              <span className="block text-[0.78rem] text-muted-foreground">
                Si no, queda en «lo que debo» hasta que la pagues.
              </span>
            </span>
            <Switch
              checked={pagarAhora}
              onCheckedChange={setPagarAhora}
              aria-label="La pagué completa"
            />
          </label>
          {pagarAhora && (
            <FormField label="¿Con qué la pagaste?" required>
              {(p) => (
                <SimpleSelect
                  id={p.id}
                  value={forma}
                  onValueChange={elegirForma}
                  options={opcionesDePago}
                  placeholder={formas.isPending ? "Cargando…" : "Elige…"}
                />
              )}
            </FormField>
          )}

          {deposito === null && !buscandoDeposito && (
            <p role="alert" className="text-[0.85rem] text-warning-soft-foreground">
              Falta un depósito: lo configura quien administra el negocio (Administración →
              Inventario). Sin él, la mercancía no tiene dónde entrar.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={!listo || registrar.isPending}
            onClick={() => registrar.mutate()}
          >
            {registrar.isPending ? "Registrando…" : "Registrar compra"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * PAGAR una factura de proveedor que quedó debiendo (ADR-0049, Nivel B de la
 * auditoría de superficie): antes solo se podía pagar EN el momento de
 * registrarla, y una deuda pendiente no tenía botón. El servidor calcula el
 * saldo y las retenciones; aquí solo se dice cuánto y con qué.
 */
function PagarFactura({
  factura,
  proveedor,
  onCerrar,
  onPagada,
}: {
  factura: FacturaProveedor;
  proveedor: string;
  onCerrar: () => void;
  onPagada: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [monto, setMonto] = useState(factura.balance);
  const [forma, setForma] = useState<string | null>("transferencia");

  const pagar = useMutation({
    mutationFn: () =>
      llamar("/v1/supplier-payments", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          supplier_invoice_id: factura.id,
          gross_amount: monto.trim().replace(",", "."),
          currency: factura.transaction_currency,
          instrument: forma,
        }),
      }),
    onSuccess: () => {
      toast.success("Pago registrado", `La deuda con ${proveedor} bajó.`);
      onPagada();
    },
    onError: (e) => toast.error("No se pudo pagar", errorDePersona(e)),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-sm">
        <DialogTitle>Pagar a {proveedor}</DialogTitle>
        <DialogDescription>
          Factura {factura.supplier_document_number} — debes{" "}
          {mostrarImporte({ amount: factura.balance, currency: factura.transaction_currency })}.
          Puede ser un abono: lo que pagues se resta.
        </DialogDescription>
        <div className="space-y-3 pt-2">
          <FormField label="¿Cuánto pagas?" required>
            {(p) => (
              <MoneyInput
                {...p}
                value={monto}
                onChange={setMonto}
                currency={
                  factura.transaction_currency === "VES" ? "Bs." : factura.transaction_currency
                }
              />
            )}
          </FormField>
          <FormField label="¿Con qué pagas?" required>
            {(p) => (
              <SimpleSelect
                id={p.id}
                value={forma}
                onValueChange={setForma}
                options={FORMAS_DE_COMPRA.map((f) => ({ value: f.value, label: f.label }))}
              />
            )}
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={
              forma === null || !importeValido(monto.trim().replace(",", ".")) || pagar.isPending
            }
            onClick={() => pagar.mutate()}
          >
            {pagar.isPending ? "Pagando…" : "Registrar pago"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
