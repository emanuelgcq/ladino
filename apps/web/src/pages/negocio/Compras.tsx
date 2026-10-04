import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, Paperclip, Plus, Receipt, ShoppingCart } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { errorDePersona, vistaDeGasto, type VistaDeGasto } from "../../lib.js";
import { mostrarCantidad, mostrarImporte } from "../../money.js";
import { tieneRif } from "../../app/rif.js";
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
  importeLimpio,
  importeValido,
  leerImporte,
  type EntityOption,
} from "../../components/forms.js";
import { GASTO_CON_FACTURA, PRECIO_DE_LA_FACTURA } from "../../components/capa-fiscal/textos.js";
import { ConfirmarSobregiro, esSinSaldo } from "../../components/sobregiro.js";
import {
  FORMAS_DE_COMPRA,
  esFormaDeCompra,
  decidirCuenta,
  type FormaDePago,
  type CandidatasDeInstrumento,
} from "../../components/formas-de-pago.js";
import { HacerPedido } from "../../components/HacerPedido.js";
import { fechaRelativa } from "./comunes.js";
import { fechaLocal, hoyLocal } from "../../fechas.js";
import {
  RetencionIvaCampos,
  cuerpoRetencionIva,
  eleccionCompleta,
  type EleccionRetencion,
} from "../../components/RetencionIva.js";

/**
 * COMPRAS Y GASTOS (Fase C, PARTE 10): lo que el negocio paga. Dos mundos en
 * una pantalla — la COMPRA de mercancía (con la factura del proveedor, entra
 * al depósito y a la deuda) y el GASTO que no es mercancía (alquiler, luz,
 * nómina: sale de una cuenta y va a contabilidad solo). Todo importe lo
 * calcula el servidor; los totales de la factura llegan con su impuesto puesto.
 */

/** F-06: por qué no se pudo leer el precio que la persona tecleó (sin tocar, no hay motivo). */
function motivoDelPrecio(tecleado: string | undefined): string | undefined {
  if (tecleado === undefined) return undefined;
  const leido = leerImporte(tecleado);
  return leido.ok ? undefined : leido.motivo;
}

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
  /** null si la factura no está asentada (borrador o anulada). */
  balance: string | null;
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
/** El valor, cuando lleva `ms` sin cambiar: para no pedir al servidor una vez por pulsación. */
function useDebounced<T>(valor: T, ms: number): T {
  const [v, setV] = useState(valor);
  useEffect(() => {
    const t = setTimeout(() => setV(valor), ms);
    return () => clearTimeout(t);
  }, [valor, ms]);
  return v;
}

function FilaDeResumen({
  rotulo,
  valor,
  fuerte = false,
}: {
  rotulo: string;
  valor: string;
  fuerte?: boolean;
}): React.JSX.Element {
  return (
    <>
      <dt className={fuerte ? "font-medium" : "text-muted-foreground"}>{rotulo}</dt>
      <dd className={`text-right font-mono ${fuerte ? "font-medium" : ""}`}>{valor}</dd>
    </>
  );
}

/** Lo que responde `POST /v1/expenses`: con factura (H-09) trae sus cifras ya calculadas. */
interface GastoRegistrado {
  amount: string;
  currency: string;
  functional_currency: string;
  invoice?: {
    currency: string;
    tax_amount: string;
    total_amount: string;
    retention_total: string;
  } | null;
}
interface Cuenta {
  id: string;
  name: string;
  currency: string;
  is_active: boolean;
  is_system: boolean;
}

/** Lo recibido que todavía no tiene factura (ADR-0066 §8). */
interface RecepcionPendiente {
  id: string;
  received_on: string;
  age_days: number;
  supplier_id: string;
  supplier_name: string;
  delivery_note_ref: string | null;
  quantity_received: string;
  quantity_invoiced: string;
  pending_amount: string;
}

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
  const navigate = useNavigate();
  const qc = useQueryClient();
  // ADR-0048: el GASTO revela la estructura de costos — es del administrador.
  // El encargado entra por la mercancía: su pestaña inicial es Compras y la
  // de Gastos ni se le enseña.
  const puedeGastos = puede("expense.read");
  const puedeComprar = puede("purchase.invoice.register");
  // Pedir es un acto de compras; recibir es uno del depósito. Quien puede lo uno no siempre
  // puede lo otro, y el botón lo respeta (ADR-0066, entrega iii).
  const puedePedir = puede("purchase.order.manage");
  // H-10: «Lo que debo → Ver qué debo» llega con `?ver=compras`: lo que se debe son las
  // facturas de proveedores, no los gastos. Sin el parámetro, la pestaña de siempre.
  const [parametros] = useSearchParams();
  const pedida = parametros.get("ver");
  const [pestana, setPestana] = useState<"gastos" | "compras" | "falta">(
    pedida === "compras" || pedida === "falta"
      ? pedida
      : pedida === "gastos" && puedeGastos
        ? "gastos"
        : puedeGastos
          ? "gastos"
          : "compras",
  );
  const [enganchando, setEnganchando] = useState<RecepcionPendiente | null>(null);
  const [nuevoGasto, setNuevoGasto] = useState(false);
  const [nuevoPedido, setNuevoPedido] = useState(false);
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

  /**
   * «FALTA LA FACTURA» (ADR-0066 §8): lo que entró al depósito y todavía no tiene su factura.
   * Sin esta lista, la cuenta «mercancía recibida por facturar» crece sin que nadie la mire.
   */
  const pendientes = useQuery({
    queryKey: ["recepciones-sin-factura", empresa.id],
    queryFn: () => llamar<{ items: RecepcionPendiente[] }>("/v1/goods-receipts?pending_invoice=1"),
  });
  const cuantasFaltan = pendientes.data?.items.length ?? 0;

  const pestanas = [
    ...(puedeGastos ? ([["gastos", "Gastos"]] as const) : []),
    ["compras", "Compras a proveedores"],
    ["falta", cuantasFaltan > 0 ? `Falta la factura (${cuantasFaltan})` : "Falta la factura"],
  ] as const;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">Compras y gastos</h1>
        <div className="flex-1" />
        {puedePedir && (
          <Button variant="secondary" onClick={() => setNuevoPedido(true)}>
            <ClipboardList /> Hacer un pedido
          </Button>
        )}
        {puedeComprar && (
          <Button variant="secondary" onClick={() => void navigate("/admin/llego-mercancia")}>
            <ShoppingCart /> Llegó mercancía
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

      {pestana === "gastos" && puedeGastos ? (
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
      ) : pestana === "compras" ? (
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
                Cuando te llegue mercancía, regístrala en «Llegó mercancía»: entra al depósito y
                queda claro cuánto le debes a cada proveedor.
              </p>
              {puedeComprar && (
                <Button
                  variant="primary"
                  className="mt-4"
                  onClick={() => void navigate("/admin/llego-mercancia")}
                >
                  <ShoppingCart /> Llegó mercancía
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
                    {/* `balance` llega null si la factura no está asentada (borrador o anulada:
                        platform.supplier_invoice_balance solo responde por posted/paid). */}
                    {f.balance === null ? null : esCero(f.balance) ||
                      compararImportes(f.balance, "0") < 0 ? (
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
      ) : null}

      {pestana === "falta" && (
        <div role="tabpanel" id="compras-panel-falta" aria-labelledby="compras-tab-falta">
          {pendientes.isPending ? (
            <ListaCargando />
          ) : pendientes.isError ? (
            <ErrorDeLista error={pendientes.error} onReintentar={() => void pendientes.refetch()} />
          ) : cuantasFaltan === 0 ? (
            <Card className="p-8 text-center">
              <Receipt className="mx-auto size-8 text-faint-foreground" />
              <p className="mt-2 font-medium">No falta ninguna factura</p>
              <p className="mx-auto mt-1 max-w-sm text-[0.9rem] text-muted-foreground">
                Todo lo que entró al depósito tiene su factura registrada.
              </p>
            </Card>
          ) : (
            <div className="space-y-2">
              {pendientes.data.items.map((r) => (
                <Card key={r.id} className="flex flex-wrap items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{r.supplier_name}</p>
                    <p className="text-[0.85rem] text-muted-foreground">
                      Llegó el {fechaLocal(r.received_on)}
                      {r.delivery_note_ref === null ? "" : ` · ${r.delivery_note_ref}`} ·{" "}
                      {r.age_days === 0
                        ? "hoy"
                        : r.age_days === 1
                          ? "hace 1 día"
                          : `hace ${r.age_days} días`}
                    </p>
                  </div>
                  {r.age_days >= 30 && (
                    <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[0.78rem] text-warning-soft-foreground">
                      Lleva más de un mes
                    </span>
                  )}
                  {puedeComprar && (
                    <Button variant="secondary" size="sm" onClick={() => setEnganchando(r)}>
                      Ya llegó la factura
                    </Button>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {enganchando !== null && (
        <EngancharFactura
          recepcion={enganchando}
          onCerrar={() => setEnganchando(null)}
          onHecho={() => {
            setEnganchando(null);
            void pendientes.refetch();
            recargar();
          }}
        />
      )}

      {nuevoGasto && <RegistrarGasto onCerrar={() => setNuevoGasto(false)} onListo={recargar} />}
      <HacerPedido abierto={nuevoPedido} onCerrar={() => setNuevoPedido(false)} />
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
  const { empresa, llamar, puede } = useSesion();
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
  // H-09: con factura fiscal el gasto es una compra de servicio. La pantalla recoge lo que trae
  // el papel; el impuesto, lo retenido y lo que sale de la cuenta los calcula el servidor.
  const [conFactura, setConFactura] = useState(false);
  const [proveedor, setProveedor] = useState<EntityOption | null>(null);
  // La moneda IMPRESA en la factura (ADR-0080): en ella van las bases y así entra al libro. No
  // es la de la cuenta: si difieren, el pago cruza a la tasa del día y el resumen lo dice.
  const [monedaFactura, setMonedaFactura] = useState("VES");
  const [numero, setNumero] = useState("");
  const [control, setControl] = useState("");
  const [fechaFactura, setFechaFactura] = useState(hoyLocal());
  const [bases, setBases] = useState<Record<string, string>>({});
  const [retencion, setRetencion] = useState<EleccionRetencion>({ tipo: "normal" });
  // El proveedor se BUSCA en el servidor: la lista de cien dejaba fuera al 101. Solo los que
  // tienen su documento cargado: la factura fiscal de un proveedor nacional lo exige.
  const buscarProveedor = useCallback(
    async (q: string): Promise<EntityOption[]> => {
      const r = await llamar<{ items: Proveedor[] }>(
        `/v1/suppliers?per_page=50${q === "" ? "" : `&search=${encodeURIComponent(q)}`}`,
      );
      return r.items
        .filter((x) => x.tax_id !== null)
        .map((x) => ({ id: x.id, label: x.legal_name, detalle: x.tax_id ?? "" }));
    },
    [llamar],
  );
  const categorias = useQuery({
    queryKey: ["tax-categories"],
    enabled: conFactura,
    queryFn: () => llamar<{ code: string; name: string }[]>("/v1/tax-categories"),
  });
  const lineasDeFactura = Object.entries(bases)
    .map(([code, base]) => ({ tax_category_code: code, base: importeLimpio(base) }))
    .filter((l) => l.base !== "");
  const facturaLista =
    proveedor !== null &&
    numero.trim() !== "" &&
    control.trim() !== "" &&
    /^\d{4}-\d{2}-\d{2}$/.test(fechaFactura) &&
    lineasDeFactura.length > 0 &&
    lineasDeFactura.every((l) => importeValido(l.base)) &&
    eleccionCompleta(retencion);
  const categoriaDeLaVista = categoria === "otro" ? otraCategoria.trim() : (categoria ?? "");
  const cuerpoDeFactura = {
    supplier_id: proveedor?.id ?? null,
    currency: monedaFactura,
    document_number: numero.trim(),
    control_number: control.trim(),
    invoice_date: fechaFactura,
    lines: lineasDeFactura,
    ...cuerpoRetencionIva(retencion),
  };
  // ANTES DE CONFIRMAR, LAS CONSECUENCIAS: el servidor registra la factura en una transacción
  // que deshace y devuelve sus cifras. La pantalla solo las enseña; sin ellas no se confirma.
  // Cada vista previa registra y deshace una factura en el servidor: no se pide una por
  // pulsación. Se ESPERA a que la persona deje de escribir, y la petición anterior se cancela
  // (la señal de TanStack Query aborta el `fetch` cuando la clave cambia).
  const cuerpoDeLaVista = JSON.stringify({
    company_id: empresa.id,
    category: categoriaDeLaVista,
    account_id: cuenta,
    invoice: cuerpoDeFactura,
  });
  const cuerpoEnReposo = useDebounced(cuerpoDeLaVista, 400);
  const vistaPedible =
    conFactura && facturaLista && cuenta !== null && categoriaDeLaVista.length >= 2;
  const previa = useQuery({
    queryKey: ["gasto-previa", cuerpoEnReposo],
    enabled: vistaPedible && cuerpoEnReposo === cuerpoDeLaVista,
    retry: false,
    queryFn: async ({ signal }): Promise<VistaDeGasto> =>
      vistaDeGasto(
        await llamar<Parameters<typeof vistaDeGasto>[0]>("/v1/expenses/preview", {
          method: "POST",
          body: cuerpoEnReposo,
          signal,
        }),
      ),
  });
  // Las cifras que se enseñan son SOLO las del cuerpo que está escrito ahora: mientras la
  // persona teclea (o espera el reposo), no hay resumen y no se confirma.
  const vista = vistaPedible && cuerpoEnReposo === cuerpoDeLaVista ? previa.data : undefined;

  // LAS CUENTAS. Con `treasury.read`, las de siempre. Quien SOLO registra gastos no ve el dinero
  // (ADR-0048) y esa lectura le daba 403: elige entre las candidatas, que no traen saldos.
  const veElDinero = puede("treasury.read");
  const cuentas = useQuery({
    queryKey: ["cuentas", empresa.id],
    enabled: veElDinero,
    queryFn: () => llamar<{ accounts: Cuenta[] }>("/v1/treasury/accounts"),
  });
  const candidatas = useQuery({
    queryKey: ["cuentas-candidatas", empresa.id],
    enabled: !veElDinero,
    queryFn: () =>
      llamar<{ instruments: { accounts: { id: string; name: string; currency: string }[] }[] }>(
        "/v1/treasury/accounts/candidates",
      ),
  });
  const activas: { id: string; name: string; currency: string }[] = veElDinero
    ? (cuentas.data?.accounts ?? []).filter((c) => c.is_active && !c.is_system)
    : [
        ...new Map(
          (candidatas.data?.instruments ?? []).flatMap((i) => i.accounts).map((c) => [c.id, c]),
        ).values(),
      ];
  const monedaCuenta = activas.find((c) => c.id === cuenta)?.currency ?? "VES";

  const categoriaFinal = categoria === "otro" ? otraCategoria.trim() : (categoria ?? "");
  const listo =
    categoriaFinal.length >= 2 &&
    cuenta !== null &&
    (conFactura ? facturaLista && vista !== undefined : importeValido(monto));

  // Sobregiro: el servidor rechaza con 409 el gasto que deja la cuenta en negativo y aquí se
  // pregunta antes de reenviarlo confirmado (ADR-0062 §4; QA 2026-09-15, h. 71).
  const [sinSaldo, setSinSaldo] = useState<string | null>(null);

  const registrar = useMutation({
    mutationFn: async (forzar: string | null) => {
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
      return llamar<GastoRegistrado>("/v1/expenses", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          category: categoriaFinal,
          ...(descripcion.trim() === "" ? {} : { description: descripcion.trim() }),
          account_id: cuenta,
          // H-09: con factura NO se manda el importe: lo calcula el servidor.
          ...(conFactura ? { invoice: cuerpoDeFactura } : { amount: importeLimpio(monto) }),
          ...(recurrente ? { is_recurring: true } : {}),
          ...(forzar !== null ? { allow_negative_balance: true, overdraft_reason: forzar } : {}),
          ...(attachment === undefined ? {} : { attachment_path: attachment }),
        }),
      });
    },
    onSuccess: (g) => {
      // H-09: las cifras de la factura vienen del servidor, ya calculadas; aquí solo se enseñan.
      const f = g.invoice ?? null;
      toast.success(
        "Gasto registrado",
        f === null
          ? `${categoriaFinal} quedó anotado y salió de tu cuenta.`
          : GASTO_CON_FACTURA.hecho({
              total: mostrarImporte({ amount: f.total_amount, currency: f.currency }),
              iva: mostrarImporte({ amount: f.tax_amount, currency: f.currency }),
              retenido: esCero(f.retention_total)
                ? null
                : mostrarImporte({ amount: f.retention_total, currency: g.functional_currency }),
              sale: mostrarImporte({ amount: g.amount, currency: g.currency }),
            }),
      );
      onListo();
      onCerrar();
    },
    onError: (e) => {
      const falta = esSinSaldo(e);
      if (falta !== null) {
        setSinSaldo(falta);
        return;
      }
      toast.error("No se pudo registrar", errorDePersona(e));
    },
  });

  return (
    <>
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
              {!conFactura && (
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
              )}
            </div>
            <div>
              <p className="pb-1.5 text-[0.88rem] font-medium" id="gasto-factura-titulo">
                {GASTO_CON_FACTURA.pregunta}
              </p>
              <div className="flex gap-1.5" role="group" aria-labelledby="gasto-factura-titulo">
                {[false, true].map((v) => (
                  <button
                    key={String(v)}
                    type="button"
                    aria-pressed={conFactura === v}
                    onClick={() => setConFactura(v)}
                    className={`rounded-full border px-3 py-1.5 text-[0.85rem] ${
                      conFactura === v
                        ? "border-accent bg-accent-soft text-accent-soft-foreground"
                        : "border-border hover:bg-surface-muted"
                    }`}
                  >
                    {v ? GASTO_CON_FACTURA.con : GASTO_CON_FACTURA.sin}
                  </button>
                ))}
              </div>
            </div>
            {conFactura && (
              <div className="space-y-3 rounded-md border border-border p-3">
                <p className="text-[0.8rem] text-muted-foreground">
                  {GASTO_CON_FACTURA.ayudaCon(tieneRif(empresa))}
                </p>
                <FormField
                  label={GASTO_CON_FACTURA.proveedor}
                  required
                  hint={GASTO_CON_FACTURA.ayudaProveedor}
                >
                  {(p) => (
                    <EntityPicker
                      id={p.id}
                      value={proveedor}
                      onChange={setProveedor}
                      buscar={buscarProveedor}
                      placeholder="Busca el proveedor…"
                    />
                  )}
                </FormField>
                <div className="grid grid-cols-2 gap-2">
                  <FormField label={GASTO_CON_FACTURA.numero} required>
                    {(p) => (
                      <Input {...p} value={numero} onChange={(e) => setNumero(e.target.value)} />
                    )}
                  </FormField>
                  <FormField label={GASTO_CON_FACTURA.control} required>
                    {(p) => (
                      <Input {...p} value={control} onChange={(e) => setControl(e.target.value)} />
                    )}
                  </FormField>
                </div>
                <FormField
                  label={GASTO_CON_FACTURA.moneda}
                  required
                  hint={GASTO_CON_FACTURA.ayudaMoneda}
                >
                  {(p) => (
                    <SimpleSelect
                      id={p.id}
                      value={monedaFactura}
                      onValueChange={setMonedaFactura}
                      options={[
                        { value: "VES", label: "Bolívares (Bs.)" },
                        { value: "USD", label: "Dólares (USD)" },
                      ]}
                    />
                  )}
                </FormField>
                <FormField label={GASTO_CON_FACTURA.fecha} required>
                  {(p) => (
                    <Input
                      {...p}
                      type="date"
                      value={fechaFactura}
                      max={hoyLocal()}
                      onChange={(e) => setFechaFactura(e.target.value)}
                    />
                  )}
                </FormField>
                <div>
                  <p className="text-[0.88rem] font-medium">{GASTO_CON_FACTURA.bases}</p>
                  <p className="pb-1.5 text-[0.78rem] text-muted-foreground">
                    {GASTO_CON_FACTURA.ayudaBases}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {(categorias.data ?? []).map((cat) => (
                      <FormField key={cat.code} label={cat.name}>
                        {(p) => (
                          <MoneyInput
                            {...p}
                            value={bases[cat.code] ?? ""}
                            onChange={(v) => setBases((b) => ({ ...b, [cat.code]: v }))}
                            currency={monedaFactura === "VES" ? "Bs." : monedaFactura}
                          />
                        )}
                      </FormField>
                    ))}
                  </div>
                </div>
                <RetencionIvaCampos valor={retencion} onCambio={setRetencion} cuentaId={cuenta} />
                <div
                  className="rounded-md bg-surface-muted px-3 py-2 text-[0.86rem]"
                  data-testid="gasto-con-factura-resumen"
                  aria-live="polite"
                >
                  <p className="pb-1 font-medium">{GASTO_CON_FACTURA.resumenTitulo}</p>
                  {vista === undefined ? (
                    previa.isError && cuerpoEnReposo === cuerpoDeLaVista ? (
                      <p role="alert" className="text-destructive-soft-foreground">
                        {errorDePersona(previa.error)}
                      </p>
                    ) : (
                      <p className="text-muted-foreground">
                        {vistaPedible ? "Calculando…" : GASTO_CON_FACTURA.resumenFalta}
                      </p>
                    )
                  ) : (
                    <>
                      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
                        {vista.lines.map((l) => (
                          <FilaDeResumen
                            key={l.tax_category_code}
                            rotulo={GASTO_CON_FACTURA.resumenBase(
                              (categorias.data ?? []).find((x) => x.code === l.tax_category_code)
                                ?.name ?? l.tax_category_code,
                            )}
                            valor={mostrarImporte({ amount: l.base, currency: vista.currency })}
                          />
                        ))}
                        <FilaDeResumen
                          rotulo={GASTO_CON_FACTURA.resumenImpuesto}
                          valor={mostrarImporte({
                            amount: vista.tax_amount,
                            currency: vista.currency,
                          })}
                        />
                        <FilaDeResumen
                          rotulo={GASTO_CON_FACTURA.resumenTotal}
                          valor={mostrarImporte({
                            amount: vista.total_amount,
                            currency: vista.currency,
                          })}
                        />
                        {!esCero(vista.retention_total) && (
                          <FilaDeResumen
                            rotulo={GASTO_CON_FACTURA.resumenRetenido}
                            valor={mostrarImporte({
                              amount: vista.retention_total,
                              currency: vista.retention_currency,
                            })}
                          />
                        )}
                        <FilaDeResumen
                          fuerte
                          rotulo={GASTO_CON_FACTURA.resumenSale}
                          valor={mostrarImporte({
                            amount: vista.amount,
                            currency: vista.account_currency,
                          })}
                        />
                      </dl>
                      {vista.tasa !== null &&
                        vista.tasaFecha !== null &&
                        vista.tasaMoneda !== null && (
                          <p className="pt-1 text-[0.78rem] text-muted-foreground">
                            {GASTO_CON_FACTURA.resumenTasa({
                              fecha: fechaLocal(vista.tasaFecha),
                              tasa: mostrarCantidad(vista.tasa),
                              divisa: vista.tasaMoneda,
                            })}
                          </p>
                        )}
                      <p className="pt-1 text-[0.78rem] text-muted-foreground">
                        {vista.tax_is_recoverable
                          ? GASTO_CON_FACTURA.resumenCredito
                          : GASTO_CON_FACTURA.resumenCosto}
                      </p>
                      {vista.sinSaldo !== null && (
                        <p role="alert" className="pt-1 text-destructive-soft-foreground">
                          {vista.sinSaldo}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
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
            {/* H-08: el campo estaba `hidden` y no se alcanzaba con el teclado. Ahora sigue en
                el orden de tabulación (solo oculto a la vista) y el rótulo enseña su foco. */}
            <label className="flex cursor-pointer items-center gap-2 rounded-md text-[0.88rem] text-muted-foreground focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
              <Paperclip className="size-4" />
              {adjunto === null ? "Adjuntar el comprobante (foto o PDF, hasta 6 MB)" : adjunto.name}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                className="sr-only"
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
              onClick={() => registrar.mutate(null)}
            >
              {registrar.isPending ? "Guardando…" : "Registrar gasto"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {sinSaldo !== null && (
        <ConfirmarSobregiro
          mensaje={sinSaldo}
          onCancelar={() => setSinSaldo(null)}
          onConfirmar={async (porQue) => {
            await registrar.mutateAsync(porQue);
            setSinSaldo(null);
          }}
        />
      )}
    </>
  );
}

/*
 * Aquí vivía «Registrar compra», el formulario de un paso que pedía dos números de factura
 * OBLIGATORIOS y no admitía una compra sin factura. Se retiró con ADR-0066: la mercancía entra
 * por una sola puerta —«Llegó mercancía»— que pregunta el hecho y deja que el servidor decida
 * cómo se registra. Esta pantalla conserva todo lo demás: gastos, historial, lo que debo y el
 * pago de facturas.
 */
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
  const [monto, setMonto] = useState(factura.balance ?? "");
  const [forma, setForma] = useState<string | null>(null);
  const [cuenta, setCuenta] = useState<string | null>(null);
  // Sobregiro: sin saldo se pregunta antes de dejar la cuenta en negativo (ADR-0062 §4).
  const [sinSaldo, setSinSaldo] = useState<string | null>(null);

  /**
   * De dónde sale el dinero: las formas CONFIGURADAS mandan su cuenta, igual que al registrar
   * la compra. Antes solo se elegía la FORMA y el pago salía de «Sin asignar», que quedaba
   * en negativo (QA de pantalla 2026-09-15, h. 77). Sin ninguna configurada, siguen las base y
   * el servidor resuelve la cuenta propia de esa familia (ADR-0062 §1).
   */
  const formas = useQuery({
    queryKey: ["formas-pago", empresa.id],
    queryFn: () => llamar<{ methods: FormaDePago[] }>("/v1/payment-methods"),
  });
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

  /**
   * DE QUÉ CUENTA SALE (ADR-0067 §1). Elegir solo la forma dejaba que el servidor dedujera la
   * cuenta, y con dos bancos «la más antigua» es un desempate, no una regla: en producción eso
   * puso 122 transferencias en Mercantil y ni un bolívar en Banesco.
   */
  const candidatas = useQuery({
    queryKey: ["cuentas-candidatas", empresa.id],
    staleTime: 60_000,
    retry: false,
    queryFn: () =>
      llamar<{ instruments: CandidatasDeInstrumento[] }>("/v1/treasury/accounts/candidates"),
  });
  const configuradaElegida = (formas.data?.methods ?? []).find((f) => f.id === forma);
  const instrumentoElegido = configuradaElegida?.kind ?? forma;
  const deCuenta = useMemo(
    () =>
      decidirCuenta(candidatas.data?.instruments.find((i) => i.instrument === instrumentoElegido)),
    [candidatas.data, instrumentoElegido],
  );
  const cuentaDelPago =
    configuradaElegida?.account_id ?? (deCuenta.que === "elegir" ? cuenta : deCuenta.cuentaUnica);
  const faltaElegirCuenta = deCuenta.que === "elegir" && cuenta === null;

  const pagar = useMutation({
    mutationFn: (forzar: string | null) => {
      const configurada = configuradaElegida;
      const tipoDePago = configurada?.kind ?? forma;
      if (tipoDePago === null || !esFormaDeCompra(tipoDePago)) {
        return Promise.reject(new Error("Esa forma no sirve para pagar a un proveedor."));
      }
      return llamar("/v1/supplier-payments", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          supplier_invoice_id: factura.id,
          gross_amount: importeLimpio(monto),
          currency: factura.transaction_currency,
          instrument: tipoDePago,
          ...(cuentaDelPago == null ? {} : { account_id: cuentaDelPago }),
          ...(forzar !== null ? { allow_negative_balance: true, overdraft_reason: forzar } : {}),
        }),
      });
    },
    onSuccess: () => {
      toast.success("Pago registrado", `La deuda con ${proveedor} bajó.`);
      onPagada();
    },
    onError: (e) => {
      const falta = esSinSaldo(e);
      if (falta !== null) {
        setSinSaldo(falta);
        return;
      }
      toast.error("No se pudo pagar", errorDePersona(e));
    },
  });

  return (
    <>
      <Dialog open onOpenChange={(v) => !v && onCerrar()}>
        <DialogContent className="max-w-sm">
          <DialogTitle>Pagar a {proveedor}</DialogTitle>
          <DialogDescription>
            Factura {factura.supplier_document_number} — debes{" "}
            {/* Este diálogo solo se abre desde una fila con saldo (asentada): null no llega. */}
            {factura.balance === null
              ? "—"
              : mostrarImporte({ amount: factura.balance, currency: factura.transaction_currency })}
            . Puede ser un abono: lo que pagues se resta.
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
            <FormField
              label="¿Con qué pagas?"
              required
              hint="Si la forma tiene cuenta configurada, el dinero sale de ESA cuenta."
            >
              {(p) => (
                <SimpleSelect
                  id={p.id}
                  value={forma}
                  onValueChange={(v) => {
                    setForma(v);
                    setCuenta(null);
                  }}
                  placeholder={formas.isPending ? "Cargando…" : "Elige…"}
                  options={opcionesDePago}
                />
              )}
            </FormField>
            {forma !== null && deCuenta.que === "elegir" && (
              <FormField
                label="¿De qué cuenta sale?"
                required
                hint="Tienes más de una: dinos cuál, para que el saldo de cada una diga la verdad."
              >
                {(p) => (
                  <SimpleSelect
                    id={p.id}
                    value={cuenta}
                    onValueChange={setCuenta}
                    options={deCuenta.opciones.map((c) => ({ value: c.id, label: c.name }))}
                    placeholder="Elige…"
                  />
                )}
              </FormField>
            )}
            {/* Solo con la consulta respondida: mientras carga no se afirma dónde va a caer. */}
            {forma !== null && candidatas.isSuccess && deCuenta.que === "ninguna" && (
              <p className="rounded-md bg-muted p-3 text-[0.88rem] sm:col-span-2">
                No tienes una cuenta de ese tipo, así que el pago va a quedar en «Sin asignar» hasta
                que lo repartas. Puedes crear la cuenta en <strong>Mi dinero</strong>.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onCerrar}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              disabled={
                forma === null || faltaElegirCuenta || !importeValido(monto) || pagar.isPending
              }
              onClick={() => pagar.mutate(null)}
            >
              {pagar.isPending ? "Pagando…" : "Registrar pago"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {sinSaldo !== null && (
        <ConfirmarSobregiro
          mensaje={sinSaldo}
          onCancelar={() => setSinSaldo(null)}
          onConfirmar={async (porQue) => {
            await pagar.mutateAsync(porQue);
            setSinSaldo(null);
          }}
        />
      )}
    </>
  );
}

/**
 * «YA LLEGÓ LA FACTURA»: engancha la factura del proveedor a lo que YA entró al depósito. No
 * vuelve a mover existencia —eso pasó el día de la recepción— y devuelve a cero la cuenta
 * «mercancía recibida por facturar». Si el precio de la factura difiere del de la recepción, el
 * servidor revaloriza el inventario (ADR-0060 §2).
 */
/** «100.00000000» es como lo guarda la base; «100» es como se escribe. Solo texto. */
function sinCeros(q: string): string {
  return q.includes(".") ? q.replace(/\.?0+$/, "") : q;
}

function EngancharFactura({
  recepcion,
  onCerrar,
  onHecho,
}: {
  recepcion: RecepcionPendiente;
  onCerrar: () => void;
  onHecho: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [numero, setNumero] = useState("");
  const [control, setControl] = useState("");
  // ADR-0072 §3 (H7): la exclusión o el 100 %, solo si la empresa es agente.
  const [retencion, setRetencion] = useState<EleccionRetencion>({ tipo: "normal" });
  /**
   * D-06 (ola 3): el precio DE LA FACTURA, por línea y sin impuesto. Por omisión, el de la recepción;
   * si el proveedor facturó otro, se escribe aquí y el SERVIDOR revaloriza el inventario por la
   * diferencia (ajuste de valor en los movimientos, no de cantidad; ADR-0060 §2). La pantalla no
   * calcula la diferencia: manda el precio y nada más.
   */
  const [precios, setPrecios] = useState<Record<string, string>>({});
  const detalle = useQuery({
    queryKey: ["recepcion", recepcion.id],
    queryFn: () =>
      llamar<{
        receipt: { transaction_currency: string };
        lines: {
          id: string;
          product_id: string;
          quantity: string;
          unit_price_transaction: string;
        }[];
      }>(`/v1/goods-receipts/${recepcion.id}`),
  });

  const enganchar = useMutation({
    mutationFn: () =>
      llamar("/v1/supplier-invoices", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          supplier_id: recepcion.supplier_id,
          supplier_document_number: numero.trim(),
          ...(control.trim() === "" ? {} : { supplier_control_number: control.trim() }),
          invoice_date: recepcion.received_on,
          currency: detalle.data?.receipt.transaction_currency ?? "VES",
          ...cuerpoRetencionIva(retencion),
          lines: (detalle.data?.lines ?? []).map((l) => ({
            goods_receipt_line_id: l.id,
            product_id: l.product_id,
            quantity: l.quantity,
            // F-06: lo tecleado pasa por el lector; lo que no se tocó viaja como lo dio el servidor.
            unit_price:
              precios[l.id] === undefined
                ? l.unit_price_transaction
                : importeLimpio(precios[l.id] ?? ""),
          })),
        }),
      }),
    onSuccess: () => {
      toast.success("Factura registrada", "Lo que recibiste ya está facturado.");
      onHecho();
    },
    onError: (e) => toast.error("No se pudo registrar la factura", errorDePersona(e)),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Ya llegó la factura</DialogTitle>
        <DialogDescription>
          De {recepcion.supplier_name}, por lo que entró el {fechaLocal(recepcion.received_on)}. La
          mercancía no se mueve otra vez: solo queda facturada.
        </DialogDescription>
        <div className="space-y-3 pt-2">
          <FormField label="N° de la factura" required hint="Como viene en el papel.">
            {(p) => <Input {...p} value={numero} onChange={(e) => setNumero(e.target.value)} />}
          </FormField>
          <FormField label="N° de control" hint="El que trae impreso, si lo trae.">
            {(p) => <Input {...p} value={control} onChange={(e) => setControl(e.target.value)} />}
          </FormField>
          {(detalle.data?.lines ?? []).map((l, i) => (
            <FormField
              key={l.id}
              label={PRECIO_DE_LA_FACTURA(i + 1, sinCeros(l.quantity))}
              hint="Si el proveedor facturó otro precio, escríbelo: el costo del inventario se ajusta."
              error={motivoDelPrecio(precios[l.id])}
            >
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  value={precios[l.id] ?? sinCeros(l.unit_price_transaction)}
                  onChange={(e) => setPrecios((prev) => ({ ...prev, [l.id]: e.target.value }))}
                />
              )}
            </FormField>
          ))}
          <RetencionIvaCampos valor={retencion} onCambio={setRetencion} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={
              numero.trim() === "" ||
              !eleccionCompleta(retencion) ||
              Object.values(precios).some((v) => !importeValido(v)) ||
              detalle.isPending ||
              enganchar.isPending
            }
            onClick={() => enganchar.mutate()}
          >
            {enganchar.isPending ? "Registrando…" : "Registrar la factura"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
