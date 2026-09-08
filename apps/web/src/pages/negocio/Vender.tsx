import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Banknote,
  CreditCard,
  MessageCircle,
  Minus,
  Plus,
  Printer,
  Search,
  ShoppingCart,
  Trash2,
  User,
  X,
} from "lucide-react";
import { useSesion } from "../../app/session.js";
import { errorDePersona, API_URL } from "../../lib.js";
import { cotizarPos, type CotizacionPos } from "../../pos.js";
import {
  aNube,
  crearSincronizador,
  escribirCuentasLocales,
  leerCuentasLocales,
  siguienteEtiqueta,
  type ClientePos,
  type CuentaAbierta,
} from "../../pos-cuentas.js";
import { supabase } from "../../lib.js";
import { mostrarImporte, mostrarCantidad } from "../../money.js";
import { compararImportes } from "../../components/decimal-compare.js";
import { Button } from "../../ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "../../ui/dialog.js";
import { Input } from "../../ui/input.js";
import { SimpleSelect } from "../../ui/select.js";
import { useToast } from "../../ui/toast.js";
import { FormField, MoneyInput, importeValido } from "../../components/forms.js";
import { formatearDocumento } from "./comunes.js";

/**
 * VENDER: el punto de venta. La venta EMPIEZA POR LA CÉDULA — es el flujo
 * real de una caja venezolana: se pide el documento, se busca exacto, y si no
 * está se crea al cliente ahí mismo sin salir de la pantalla. «Consumidor
 * final» dejó de ser el default: es un escape explícito que el dueño puede
 * apagar en Configuración (y el dominio lo respalda: quickSale lo rechaza).
 *
 * TODO importe lo dice el servidor: el carrito se cotiza con debounce en
 * /v1/pos/quote, el vuelto lo calcula /v1/pos/change, y la venta entera es
 * UNA transacción en /v1/pos/sales con el id de venta como llave — repetir el
 * clic no repite la factura.
 *
 * VARIAS CUENTAS A LA VEZ (orden del dueño, 2026-09-08): la cajera lleva
 * fichas — «Cuenta 1», «Vecina Carmen» — y cada una se guarda sola: en el
 * disco de la caja EN CADA TOQUE (síncrono: la capa antiapagón) y en la nube
 * al instante, coalescido (pos-cuentas.ts). Una cuenta solo se cierra al
 * COBRARSE — el servidor borra su fila en la transacción de la venta — o
 * descartándola a propósito con confirmación.
 *
 * Teclado, sin ratón: cédula → Enter → (si es nuevo: nombre → Tab → teléfono
 * → Enter) → buscar producto → Enter agrega → F2 abre Cobrar → Enter cobra.
 */

interface ProductoFila {
  id: string;
  sku: string;
  name: string;
  kind: "good" | "service";
  barcode: string | null;
  image_url?: string | null;
  price_amount?: string | null;
  price_currency?: string | null;
  price_equivalent_amount?: string | null;
  price_equivalent_currency?: string | null;
  stock_quantity?: string | null;
}
interface ClienteFila {
  id: string;
  legal_name: string;
  tax_id: string | null;
  phone: string | null;
}
interface FormaDePago {
  id: string;
  name: string;
  kind: string;
  account_id: string;
  is_active: boolean;
}
interface Venta {
  document: {
    id: string;
    kind: string;
    series: string;
    document_number: number | null;
    status: string;
    functional_currency: string;
  };
  payments: { payment: Record<string, string> }[];
  change: { amount: string; currency: string } | null;
  document_status: string;
  /** Lo que quedó debiendo, en moneda funcional. "0.00000000" = pagada. */
  balance: string;
}

function useDebounced<T>(valor: T, ms: number, salto?: unknown): T {
  const [v, setV] = useState(valor);
  // Al cambiar el «salto» (la cuenta activa), el valor pasa SIN esperar: la
  // ficha recién abierta no debe cotizar 300 ms con las líneas de la anterior.
  useEffect(() => {
    setV(valor);
  }, [salto]);
  useEffect(() => {
    const t = setTimeout(() => setV(valor), ms);
    return () => clearTimeout(t);
  }, [valor, ms]);
  return v;
}

function cuentaNueva(existentes: CuentaAbierta[]): CuentaAbierta {
  return {
    id: crypto.randomUUID(),
    etiqueta: siguienteEtiqueta(existentes),
    cliente: null,
    sinIdentificar: false,
    lineas: [],
  };
}

export function Vender(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [busqueda, setBusqueda] = useState("");
  const buscarRef = useRef<HTMLInputElement>(null);

  // ── Las CUENTAS ABIERTAS: varias a la vez, cada una con su cliente ────────
  // Nacen del disco de la caja (síncrono: lo que el apagón no se llevó) y se
  // completan con la nube al montar. Cada toque escribe el disco EN EL ACTO
  // y dispara la nube coalescida — ver pos-cuentas.ts.
  const [cuentas, setCuentas] = useState<CuentaAbierta[]>(() => {
    const locales = leerCuentasLocales(empresa.id);
    return locales.length > 0 ? locales : [cuentaNueva([])];
  });
  const [activaId, setActivaId] = useState<string>("");
  const activa = cuentas.find((c) => c.id === activaId) ?? cuentas[0]!;
  const [descartando, setDescartando] = useState<CuentaAbierta | null>(null);

  const sincronizador = useMemo(
    () =>
      crearSincronizador(
        (cuenta) =>
          llamar(`/v1/pos/carts/${cuenta.id}`, {
            method: "PUT",
            body: JSON.stringify({
              company_id: empresa.id,
              label: cuenta.label,
              customer_id: cuenta.customer_id,
              lines: cuenta.lines,
            }),
          }).then(() => undefined),
        (id) => llamar(`/v1/pos/carts/${id}`, { method: "DELETE" }).then(() => undefined),
      ),
    [llamar, empresa.id],
  );

  /** TODA mutación de cuentas pasa por aquí: estado + disco síncrono + nube. */
  function tocar(id: string, cambio: (c: CuentaAbierta) => CuentaAbierta): void {
    const siguientes = cuentas.map((c) => (c.id === id ? cambio(c) : c));
    setCuentas(siguientes);
    escribirCuentasLocales(empresa.id, siguientes);
    const cambiada = siguientes.find((c) => c.id === id);
    if (cambiada) sincronizador.guardar(aNube(cambiada));
  }

  function abrirCuenta(): void {
    const nueva = cuentaNueva(cuentas);
    const siguientes = [...cuentas, nueva];
    setCuentas(siguientes);
    escribirCuentasLocales(empresa.id, siguientes);
    setActivaId(nueva.id);
    // Vacía no viaja a la nube: viajará con su primer producto o cliente.
  }

  function quitarCuenta(id: string, avisarNube: boolean): void {
    const restantes = cuentas.filter((c) => c.id !== id);
    const siguientes = restantes.length > 0 ? restantes : [cuentaNueva([])];
    setCuentas(siguientes);
    escribirCuentasLocales(empresa.id, siguientes);
    if (avisarNube) sincronizador.borrar(id);
    if (activa.id === id) setActivaId(siguientes[0]!.id);
  }

  // La lista de la nube, una vez al montar: lo de allá que aquí no está,
  // entra (venía de otro día o de otra caja); lo local manda sobre lo suyo y
  // se reempuja — es el que quedó huérfano si el apagón cortó la subida.
  const nube = useQuery({
    queryKey: ["pos-cuentas", empresa.id],
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    queryFn: () =>
      llamar<{
        items: {
          id: string;
          label: string;
          customer_id: string | null;
          lines: { product_id: string; qty: string }[];
        }[];
      }>("/v1/pos/carts"),
  });
  const fusionado = useRef(false);
  useEffect(() => {
    if (fusionado.current || !nube.data) return;
    fusionado.current = true;
    const entrantes = nube.data.items
      .filter((s) => !cuentas.some((c) => c.id === s.id))
      .map((s): CuentaAbierta => ({
        id: s.id,
        etiqueta: s.label,
        cliente:
          s.customer_id === null
            ? null
            : { id: s.customer_id, legal_name: s.label, tax_id: null, phone: null },
        sinIdentificar: false,
        lineas: s.lines.map((l) => ({
          product_id: l.product_id,
          qty: Number(l.qty),
          nombre: "", // lo dirá la cotización al abrir la ficha
        })),
      }));
    // La «Cuenta 1» recién nacida y vacía no estorba… salvo que ya venga algo.
    const base =
      entrantes.length > 0
        ? cuentas.filter((c) => c.lineas.length > 0 || c.cliente !== null)
        : cuentas;
    const siguientes = base.length + entrantes.length > 0 ? [...base, ...entrantes] : cuentas;
    if (siguientes !== cuentas) {
      setCuentas(siguientes);
      escribirCuentasLocales(empresa.id, siguientes);
      if (activa.lineas.length === 0 && activa.cliente === null && !base.includes(activa)) {
        setActivaId(siguientes[0]!.id);
      }
    }
    for (const c of base) {
      if (c.lineas.length > 0 || c.cliente !== null) sincronizador.guardar(aNube(c));
    }
    // El nombre completo del cliente restaurado (cédula y teléfono para el
    // chip) se trae aparte; si falla, la etiqueta ya dice quién es.
    for (const s of entrantes) {
      if (s.cliente === null) continue;
      void llamar<ClientePos>(`/v1/customers/${s.cliente.id}`)
        .then((cli) => {
          setCuentas((prev) => {
            const conNombre = prev.map((c) => (c.id === s.id ? { ...c, cliente: cli } : c));
            escribirCuentasLocales(empresa.id, conNombre);
            return conNombre;
          });
        })
        .catch(() => undefined);
    }
  }, [nube.data]);

  const [cobrando, setCobrando] = useState(false);
  const [venta, setVenta] = useState<Venta | null>(null);
  // El nombre del que quedó debiendo, capturado al vender: la ficha de la
  // cuenta ya murió cuando el diálogo de éxito lo enseña.
  const [deudor, setDeudor] = useState<string | null>(null);
  const qc = useQueryClient();
  const q = useDebounced(busqueda.trim(), 200);

  const productos = useQuery({
    queryKey: ["pos-productos", empresa.id, q],
    queryFn: () =>
      llamar<{ items: ProductoFila[] }>(
        `/v1/products?only_active=1&with_price=1&with_stock=1&per_page=60${q === "" ? "" : `&search=${encodeURIComponent(q)}`}`,
      ),
  });
  const ajustes = useQuery({
    queryKey: ["ajustes", empresa.id],
    staleTime: 5 * 60_000,
    queryFn: () =>
      llamar<{
        block_sale_without_stock: boolean;
        allow_unidentified_sales: boolean;
        default_warehouse_id: string | null;
      }>("/v1/company-settings"),
  });
  const setupFiscal = useQuery({
    queryKey: ["empezar-fiscal", empresa.id],
    staleTime: 5 * 60_000,
    queryFn: () => llamar<{ current_regime: string | null }>("/v1/fiscal/setup"),
  });
  // Modo recibos (migración 37): el POS es el MISMO; cambia el documento.
  const modoRecibos = setupFiscal.data?.current_regime === "sin_facturacion";

  const depositos = useQuery({
    queryKey: ["depositos", empresa.id],
    staleTime: 5 * 60_000,
    queryFn: () => llamar<{ id: string; name: string }[]>("/v1/warehouses"),
  });

  const deposito = ajustes.data?.default_warehouse_id ?? depositos.data?.[0]?.id ?? null;

  // La cotización de la cuenta ACTIVA (solo ella: N fichas, UNA cotización),
  // SIEMPRE del servidor, con debounce — y sin debounce al cambiar de ficha.
  const lineas = useMemo(
    () => activa.lineas.map((l) => ({ product_id: l.product_id, quantity: String(l.qty) })),
    [activa],
  );
  const lineasDebounced = useDebounced(lineas, 300, activa.id);
  const cotizacion = useQuery({
    queryKey: [
      "pos-quote",
      empresa.id,
      activa.id,
      activa.cliente?.id ?? "mostrador",
      lineasDebounced,
    ],
    enabled: lineasDebounced.length > 0,
    // El «mientras llega» solo vale dentro de la MISMA ficha: los totales de
    // una cuenta jamás se pintan un instante sobre la otra.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === activa.id ? prev : undefined),
    queryFn: () =>
      cotizarPos(llamar, {
        company_id: empresa.id,
        ...(activa.cliente === null ? {} : { customer_id: activa.cliente.id }),
        lines: lineasDebounced,
      }),
  });

  function agregar(p: ProductoFila): void {
    if (!p.price_amount) {
      toast.warning("Ese producto no tiene precio", "Pónselo en Productos antes de venderlo.");
      return;
    }
    const sinExistencia = p.kind === "good" && compararImportes(p.stock_quantity ?? "0", "0") <= 0;
    if (sinExistencia && ajustes.data?.block_sale_without_stock) {
      toast.warning("Sin existencia", "Registra la entrada de mercancía antes de venderlo.");
      return;
    }
    tocar(activa.id, (c) => {
      const ya = c.lineas.find((l) => l.product_id === p.id);
      return {
        ...c,
        lineas: ya
          ? c.lineas.map((l) => (l.product_id === p.id ? { ...l, qty: l.qty + 1 } : l))
          : [...c.lineas, { product_id: p.id, qty: 1, nombre: p.name }],
      };
    });
  }

  function cambiarQty(productId: string, delta: number): void {
    tocar(activa.id, (c) => ({
      ...c,
      lineas: c.lineas
        .map((l) => (l.product_id === productId ? { ...l, qty: l.qty + delta } : l))
        .filter((l) => l.qty > 0),
    }));
  }

  // Enter en la búsqueda: agrega la coincidencia EXACTA de código de barras, o
  // la primera de la lista — es el gesto del lector.
  function onEnterBusqueda(): void {
    const items = productos.data?.items ?? [];
    const porBarras = items.find((p) => p.barcode !== null && p.barcode === busqueda.trim());
    const elegido = porBarras ?? items[0];
    if (elegido) {
      agregar(elegido);
      setBusqueda("");
    }
  }

  const clienteResuelto = modoRecibos || activa.cliente !== null || activa.sinIdentificar;

  // En modo recibos no hay cédula que pedir primero: el foco va a la búsqueda.
  useEffect(() => {
    if (modoRecibos) buscarRef.current?.focus();
  }, [modoRecibos]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2" && activa.lineas.length > 0 && clienteResuelto) {
        e.preventDefault();
        setCobrando(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activa.lineas.length, clienteResuelto]);

  const items = productos.data?.items ?? [];

  return (
    <div className="space-y-2">
      {modoRecibos && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-surface-muted/50 px-3 py-1.5 text-[0.82rem] text-muted-foreground">
          Estás vendiendo con recibos.{" "}
          <a href="/empezar" className="text-accent-soft-foreground underline">
            Con tu RIF puedes facturar →
          </a>
        </div>
      )}
      <div className="flex min-h-[calc(100vh-8rem)] gap-4">
        {/* ── La cuadrícula ──────────────────────────────────────────────── */}
        <div className="min-w-0 flex-1 space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint-foreground" />
            <Input
              ref={buscarRef}
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onEnterBusqueda();
                }
              }}
              placeholder="Busca o pasa el lector de código de barras…"
              className="h-11 pl-9 text-[1rem]"
              aria-label="Buscar productos para vender"
            />
          </div>
          {productos.isLoading ? (
            <p className="text-muted-foreground">Cargando…</p>
          ) : items.length === 0 ? (
            <p className="py-12 text-center text-muted-foreground">
              {q === "" ? "No hay productos activos para vender." : "Nada con ese nombre o código."}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
              {items.map((p) => (
                <TarjetaPos key={p.id} producto={p} onAgregar={() => agregar(p)} />
              ))}
            </div>
          )}
        </div>

        {/* ── El carrito ─────────────────────────────────────────────────── */}
        <aside className="flex w-96 shrink-0 flex-col rounded-lg border border-border bg-surface">
          {/* Las FICHAS: una por cuenta abierta. Cada una guarda sola — en el
              disco de la caja al instante y en la nube detrás — y solo se
              cierra al cobrarse (o descartándola a propósito). */}
          <div
            className="flex items-center gap-1 overflow-x-auto border-b border-border p-1.5"
            role="tablist"
            aria-label="Cuentas abiertas"
          >
            {cuentas.map((c) => {
              const esActiva = c.id === activa.id;
              return (
                <span
                  key={c.id}
                  className={`flex shrink-0 items-center gap-0.5 rounded-md ${
                    esActiva ? "bg-accent-soft" : "hover:bg-surface-muted"
                  }`}
                >
                  <button
                    role="tab"
                    aria-selected={esActiva}
                    className={`max-w-40 truncate py-1.5 pl-2.5 text-[0.82rem] font-medium ${
                      esActiva ? "text-accent-soft-foreground" : "text-muted-foreground"
                    } ${cuentas.length > 1 ? "pr-0.5" : "pr-2.5"}`}
                    onClick={() => setActivaId(c.id)}
                  >
                    {c.cliente?.legal_name ?? c.etiqueta}
                    {c.lineas.length > 0 && (
                      <span className="ml-1 tabular-nums opacity-70">{c.lineas.length}</span>
                    )}
                  </button>
                  {cuentas.length > 1 && (
                    <button
                      className="rounded p-1 text-faint-foreground hover:text-foreground"
                      aria-label={`Cerrar ${c.cliente?.legal_name ?? c.etiqueta}`}
                      onClick={() => {
                        if (c.lineas.length > 0 || c.cliente !== null) setDescartando(c);
                        else quitarCuenta(c.id, true);
                      }}
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </span>
              );
            })}
            <button
              className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-surface-muted hover:text-foreground"
              aria-label="Abrir otra cuenta"
              title="Otra cuenta en espera"
              onClick={abrirCuenta}
            >
              <Plus className="size-4" />
            </button>
          </div>
          <IdentificarCliente
            key={activa.id}
            opcional={modoRecibos}
            cliente={activa.cliente}
            sinIdentificar={activa.sinIdentificar}
            permiteSinIdentificar={ajustes.data?.allow_unidentified_sales ?? true}
            onCliente={(c) => {
              tocar(activa.id, (x) => ({ ...x, cliente: c, sinIdentificar: false }));
              buscarRef.current?.focus();
            }}
            onSinIdentificar={() => {
              tocar(activa.id, (x) => ({ ...x, cliente: null, sinIdentificar: true }));
              buscarRef.current?.focus();
            }}
            onCambiar={() => {
              tocar(activa.id, (x) => ({ ...x, cliente: null, sinIdentificar: false }));
            }}
          />
          <div className="min-h-0 flex-1 overflow-y-auto px-3">
            {activa.lineas.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center py-16 text-center text-muted-foreground">
                <ShoppingCart className="size-8 text-faint-foreground" />
                <p className="mt-2 text-[0.95rem]">Toca un producto para empezar</p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {activa.lineas.map((l) => {
                  const cot = cotizacion.data?.lines.find((x) => x.product_id === l.product_id);
                  return (
                    <li key={l.product_id} className="flex items-center gap-2 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[0.92rem] font-medium">
                          {/* La restaurada de la nube trae solo la intención:
                              el nombre lo pone la cotización al llegar. */}
                          {l.nombre !== "" ? l.nombre : (cot?.description ?? "…")}
                        </p>
                        <p className="text-[0.8rem] text-muted-foreground tabular-nums">
                          {cot
                            ? `${
                                cotizacion.data!.currency !== cotizacion.data!.functional_currency
                                  ? `${mostrarImporte({ amount: cot.unit_price, currency: cotizacion.data!.currency })} · `
                                  : ""
                              }${mostrarImporte({ amount: cot.precio_bs, currency: cotizacion.data!.functional_currency })} c/u`
                            : "…"}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="iconSm"
                          aria-label={`Quitar uno de ${l.nombre !== "" ? l.nombre : "este producto"}`}
                          onClick={() => cambiarQty(l.product_id, -1)}
                        >
                          {l.qty === 1 ? <Trash2 /> : <Minus />}
                        </Button>
                        <span className="w-7 text-center text-[0.95rem] font-medium tabular-nums">
                          {l.qty}
                        </span>
                        <Button
                          variant="ghost"
                          size="iconSm"
                          aria-label={`Agregar uno de ${l.nombre !== "" ? l.nombre : "este producto"}`}
                          onClick={() => cambiarQty(l.product_id, 1)}
                        >
                          <Plus />
                        </Button>
                      </div>
                      <span className="w-20 text-right text-[0.92rem] font-medium tabular-nums">
                        {cot
                          ? mostrarImporte({
                              amount: cot.total_bs,
                              currency: cotizacion.data!.functional_currency,
                            })
                          : "…"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="space-y-2 border-t border-border p-3">
            {cotizacion.data && activa.lineas.length > 0 && (
              <>
                <div className="flex justify-between text-[0.88rem] text-muted-foreground">
                  <span>Sin impuesto</span>
                  <span className="tabular-nums">
                    {mostrarImporte({
                      amount: cotizacion.data.subtotal_bs,
                      currency: cotizacion.data.functional_currency,
                    })}
                  </span>
                </div>
                <div className="flex justify-between text-[0.88rem] text-muted-foreground">
                  <span>IVA</span>
                  <span className="tabular-nums">
                    {mostrarImporte({
                      amount: cotizacion.data.impuesto_bs,
                      currency: cotizacion.data.functional_currency,
                    })}
                  </span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-[1rem] font-semibold">Total</span>
                  <span className="text-xl font-semibold tabular-nums">
                    {mostrarImporte({
                      amount: cotizacion.data.functional_total,
                      currency: cotizacion.data.functional_currency,
                    })}
                  </span>
                </div>
                {cotizacion.data.currency !== cotizacion.data.functional_currency && (
                  <p className="text-right text-[0.82rem] text-muted-foreground tabular-nums">
                    ={" "}
                    {mostrarImporte({
                      amount: cotizacion.data.total,
                      currency: cotizacion.data.currency,
                    })}{" "}
                    a la tasa de hoy ({mostrarCantidad(cotizacion.data.tasa)})
                  </p>
                )}
              </>
            )}
            <Button
              variant="primary"
              size="lg"
              className="h-12 w-full text-[1.05rem]"
              disabled={
                activa.lineas.length === 0 ||
                !cotizacion.data ||
                deposito === null ||
                !clienteResuelto
              }
              onClick={() => setCobrando(true)}
            >
              Cobrar {activa.lineas.length > 0 && clienteResuelto ? "· F2" : ""}
            </Button>
            {activa.lineas.length > 0 && !clienteResuelto && (
              <p className="text-center text-[0.8rem] text-warning-soft-foreground">
                Primero di quién compra: la cédula arriba, o «Venta sin identificar».
              </p>
            )}
            {deposito === null && (
              <p className="text-center text-[0.8rem] text-warning-soft-foreground">
                Falta un depósito para descontar la mercancía. Configúralo en Empezar.
              </p>
            )}
          </div>
        </aside>

        {cobrando && cotizacion.data && deposito !== null && (
          <Cobrar
            cotizacion={cotizacion.data}
            lineas={lineas}
            clienteId={activa.cliente?.id ?? null}
            cartId={activa.id}
            deposito={deposito}
            onCerrar={() => setCobrando(false)}
            clienteNombre={activa.sinIdentificar ? null : (activa.cliente?.legal_name ?? null)}
            onVendida={(v) => {
              setCobrando(false);
              setVenta(v);
              setDeudor(activa.cliente?.legal_name ?? null);
              // La cuenta cobrada MUERE: el servidor la borró en la MISMA
              // transacción de la venta (cart_id); aquí solo cae la ficha.
              quitarCuenta(activa.id, false);
              // «Me deben» de Inicio y Mi dinero se refresca al instante: la
              // venta fiada es deuda desde ya.
              void qc.invalidateQueries({ queryKey: ["negocio-resumen", empresa.id] });
            }}
          />
        )}
        {descartando !== null && (
          <Dialog open onOpenChange={(v) => !v && setDescartando(null)}>
            <DialogContent className="max-w-sm">
              <DialogTitle>¿Descartar esta cuenta?</DialogTitle>
              <div className="space-y-3 pt-1">
                <p className="text-[0.92rem] text-muted-foreground">
                  «{descartando.cliente?.legal_name ?? descartando.etiqueta}»
                  {descartando.lineas.length > 0
                    ? ` tiene ${String(descartando.lineas.length)} producto${descartando.lineas.length === 1 ? "" : "s"} anotado${descartando.lineas.length === 1 ? "" : "s"}. Se pierden — nada se cobra ni se descuenta.`
                    : " se cierra sin cobrar nada."}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="secondary" onClick={() => setDescartando(null)} autoFocus>
                    Volver
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => {
                      quitarCuenta(descartando.id, true);
                      setDescartando(null);
                    }}
                  >
                    Descartar
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        )}
        {venta !== null && (
          <VentaLista
            venta={venta}
            deudor={deudor}
            onNueva={() => {
              setVenta(null);
              setDeudor(null);
              // La venta nueva empieza como todas: por la cédula. El foco se
              // difiere: al cerrarse, el diálogo restaura el foco al elemento
              // anterior y pisaría este si se pusiera en el mismo tick.
              requestAnimationFrame(() =>
                setTimeout(() => document.getElementById("pos-cedula")?.focus(), 0),
              );
            }}
          />
        )}
      </div>
    </div>
  );
}

function TarjetaPos({
  producto,
  onAgregar,
}: {
  producto: ProductoFila;
  onAgregar: () => void;
}): React.JSX.Element {
  const sinExistencia =
    producto.kind === "good" && compararImportes(producto.stock_quantity ?? "0", "0") <= 0;
  return (
    <button
      onClick={onAgregar}
      className="group relative overflow-hidden rounded-lg border border-border bg-surface text-left transition-transform focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.98]"
    >
      {producto.image_url ? (
        <img
          src={producto.image_url}
          alt=""
          loading="lazy"
          className="aspect-square w-full object-cover"
        />
      ) : (
        <div
          className="flex aspect-square w-full items-center justify-center bg-accent-soft text-3xl font-semibold text-accent-soft-foreground"
          aria-hidden
        >
          {producto.name.slice(0, 1).toUpperCase()}
        </div>
      )}
      {sinExistencia && (
        <span className="absolute left-2 top-2 rounded-full bg-warning-soft px-2 py-0.5 text-[0.7rem] font-medium text-warning-soft-foreground">
          Sin existencia
        </span>
      )}
      <div className="p-2">
        <p className="truncate text-[0.88rem] font-medium leading-tight">{producto.name}</p>
        <p className="text-[0.92rem] font-semibold tabular-nums">
          {producto.price_amount && producto.price_currency
            ? mostrarImporte({ amount: producto.price_amount, currency: producto.price_currency })
            : "Sin precio"}
        </p>
        {/* Las dos monedas también en la cuadrícula: el equivalente en Bs lo
            calcula el servidor con la tasa de hoy; sin tasa no se enseña nada. */}
        {producto.price_equivalent_amount && producto.price_equivalent_currency ? (
          <p className="text-[0.78rem] text-muted-foreground tabular-nums">
            {mostrarImporte({
              amount: producto.price_equivalent_amount,
              currency: producto.price_equivalent_currency,
            })}
          </p>
        ) : null}
      </div>
    </button>
  );
}

const PREFIJOS = ["V", "E", "J", "G", "P"].map((p) => ({ value: p, label: p }));

/** Qué tipo de cliente crea cada prefijo. La persona nunca ve estas palabras. */
function tipoDePrefijo(prefijo: string): { persona: string; contribuyente: string } {
  if (prefijo === "J") return { persona: "juridica", contribuyente: "ordinario" };
  if (prefijo === "G") return { persona: "gobierno", contribuyente: "ordinario" };
  if (prefijo === "P") return { persona: "extranjera", contribuyente: "no_domiciliado" };
  return { persona: "natural", contribuyente: "consumidor_final" };
}

/**
 * El PRIMER paso de la venta: la cédula o el RIF. Busca exacto contra el
 * servidor; si el cliente no está, se crea aquí mismo con el mini-formulario
 * — el tipo de persona se infiere del prefijo, y a una empresa (J/G) se le
 * pide dirección: una factura a una empresa lleva domicilio fiscal.
 */
function IdentificarCliente({
  opcional = false,
  cliente,
  sinIdentificar,
  permiteSinIdentificar,
  onCliente,
  onSinIdentificar,
  onCambiar,
}: {
  /** Modo recibos: identificar sirve para fiar, no lo exige la ley (13.7 es de facturas). */
  opcional?: boolean;
  cliente: ClienteFila | null;
  sinIdentificar: boolean;
  permiteSinIdentificar: boolean;
  onCliente: (c: ClienteFila) => void;
  onSinIdentificar: () => void;
  onCambiar: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [prefijo, setPrefijo] = useState<string | null>("V");
  const [digitos, setDigitos] = useState("");
  const [nuevo, setNuevo] = useState(false);
  // En modo recibos el campo arranca plegado: identificar es opcional.
  const [mostrarCampo, setMostrarCampo] = useState(!opcional);
  const [nombre, setNombre] = useState("");
  const [telefono, setTelefono] = useState("");
  const [direccion, setDireccion] = useState("");

  const esEmpresa = prefijo === "J" || prefijo === "G";
  const documento = `${prefijo ?? "V"}${digitos.trim().toUpperCase()}`;

  // El cajero teclea la letra al inicio y el prefijo se pone solo:
  // «J401234567» en el campo pone J en el selector y deja los dígitos.
  function alEscribir(v: string): void {
    const limpio = v.trim().toUpperCase();
    const letra = limpio.charAt(0);
    if (/^[VEJGP]$/.test(letra)) {
      setPrefijo(letra);
      setDigitos(limpio.slice(1).replace(/[^0-9A-Z]/g, ""));
    } else {
      setDigitos(limpio.replace(/[^0-9A-Z]/g, ""));
    }
  }

  const buscar = useMutation({
    mutationFn: () =>
      llamar<ClienteFila>(`/v1/customers/lookup?document=${encodeURIComponent(documento)}`),
    onSuccess: (c) => {
      setNuevo(false);
      setDigitos(""); // la próxima venta arranca con el campo limpio
      onCliente(c);
    },
    onError: (e) => {
      // 404 limpio = no está: se abre el alta inline. Cualquier otro error se dice.
      if ((e as { status?: number }).status === 404) {
        setNuevo(true);
      } else {
        toast.error("No se pudo buscar", errorDePersona(e));
      }
    },
  });

  const crear = useMutation({
    mutationFn: () => {
      const tipo = tipoDePrefijo(prefijo ?? "V");
      return llamar<ClienteFila>("/v1/customers", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          tax_id: documento,
          legal_name: nombre.trim(),
          person_type_code: tipo.persona,
          taxpayer_type_code: tipo.contribuyente,
          ...(telefono.trim() === "" ? {} : { phone: telefono.trim() }),
          ...(direccion.trim() === "" ? {} : { fiscal_address: direccion.trim() }),
        }),
      });
    },
    onSuccess: (c) => {
      toast.success("Cliente guardado");
      setNuevo(false);
      setNombre("");
      setTelefono("");
      setDireccion("");
      setDigitos("");
      onCliente(c);
    },
    onError: (e) => toast.error("No se pudo guardar", errorDePersona(e)),
  });

  const listoParaCrear =
    nombre.trim().length > 0 &&
    digitos.trim().length > 0 &&
    (!esEmpresa || direccion.trim() !== "");

  // Identificado (o decidido): el chip con «Cambiar».
  if (cliente !== null || sinIdentificar) {
    return (
      <div className="border-b border-border p-3">
        <div className="flex items-center gap-2 rounded-md bg-accent-soft px-2.5 py-2">
          <User className="size-4 shrink-0 text-accent-soft-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[0.92rem] font-medium">
              {cliente !== null ? cliente.legal_name : "Venta sin identificar"}
            </p>
            <p className="truncate text-[0.8rem] text-muted-foreground tabular-nums">
              {cliente !== null
                ? [
                    cliente.tax_id === null ? null : formatearDocumento(cliente.tax_id),
                    cliente.phone,
                  ]
                    .filter((x) => x !== null && x !== "")
                    .join(" · ")
                : "Consumidor final"}
            </p>
          </div>
          <button
            className="shrink-0 text-[0.8rem] text-accent-soft-foreground hover:underline"
            onClick={onCambiar}
          >
            Cambiar
          </button>
        </div>
      </div>
    );
  }

  // Modo recibos, plegado: identificar sirve para fiar, no lo exige la ley.
  if (!mostrarCampo) {
    return (
      <div className="border-b border-border px-3 py-2">
        <button
          className="text-[0.85rem] text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => setMostrarCampo(true)}
        >
          <User className="mr-1 inline size-3.5" /> Poner cliente (opcional)
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 border-b border-border p-3">
      <div className="flex items-end gap-1.5">
        <SimpleSelect
          id="pos-prefijo"
          value={prefijo}
          onValueChange={setPrefijo}
          options={PREFIJOS}
          ariaLabel="Tipo de documento"
          className="w-16"
        />
        <Input
          id="pos-cedula"
          autoFocus
          value={digitos}
          onChange={(e) => alEscribir(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && digitos.trim() !== "") {
              e.preventDefault();
              buscar.mutate();
            }
          }}
          placeholder="12345678"
          inputMode="numeric"
          aria-label="Cédula o RIF del cliente"
          className="h-11 flex-1 text-[1rem] tabular-nums"
        />
        <Button
          variant="secondary"
          className="h-11"
          disabled={digitos.trim() === "" || buscar.isPending}
          onClick={() => buscar.mutate()}
          aria-label="Buscar cliente por documento"
        >
          <Search />
        </Button>
      </div>
      <p className="text-[0.8rem] text-muted-foreground">Cédula o RIF del cliente</p>

      {nuevo && (
        <div className="space-y-2 rounded-md border border-border bg-surface-muted/40 p-2.5">
          <p className="text-[0.85rem]">
            <span className="font-medium tabular-nums">{formatearDocumento(documento)}</span> no
            está registrado. Se guarda ahora mismo:
          </p>
          <FormField label="Nombre completo" required>
            {(p) => (
              <Input
                {...p}
                autoFocus
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                className="h-9"
              />
            )}
          </FormField>
          <FormField label="Teléfono">
            {(p) => (
              <Input
                {...p}
                value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && listoParaCrear && !crear.isPending) {
                    e.preventDefault();
                    crear.mutate();
                  }
                }}
                placeholder="0414-1234567"
                className="h-9"
              />
            )}
          </FormField>
          <FormField
            label="Dirección"
            {...(esEmpresa
              ? { required: true, hint: "Una factura a una empresa lleva su domicilio fiscal." }
              : {})}
          >
            {(p) => (
              <Input
                {...p}
                value={direccion}
                onChange={(e) => setDireccion(e.target.value)}
                className="h-9"
              />
            )}
          </FormField>
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={!listoParaCrear || crear.isPending}
              onClick={() => crear.mutate()}
            >
              Guardar y seguir
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setNuevo(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {permiteSinIdentificar && !nuevo && (
        <button
          className="text-[0.8rem] text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => {
            setDigitos("");
            onSinIdentificar();
          }}
        >
          Venta sin identificar
        </button>
      )}
    </div>
  );
}

const ETIQUETA_FORMA: Record<string, string> = {
  efectivo_bs: "Efectivo Bs.",
  efectivo_usd: "Efectivo USD",
  pago_movil: "Pago móvil",
  transferencia: "Transferencia",
  punto_venta: "Punto de venta",
  tarjeta: "Tarjeta",
  zelle: "Zelle",
  usdt: "USDT",
  cashea: "Cashea",
  otro: "Otra",
};
const MONEDA_FORMA: Record<string, string> = {
  efectivo_bs: "VES",
  efectivo_usd: "USD",
  pago_movil: "VES",
  transferencia: "VES",
  punto_venta: "VES",
  tarjeta: "VES",
  zelle: "USD",
  usdt: "USD",
  cashea: "VES",
  otro: "VES",
};

/**
 * Las formas que se OFRECEN SIEMPRE, configuradas o no (decisión del dueño,
 * 2026-09-05): el cobro registra la forma de pago + referencia desde hoy; la
 * cuenta la refina una forma configurada, y sin ella el dinero cae en
 * «Sin asignar» hasta que se conecten las APIs (POS, pago móvil, Cashea…).
 */
const FORMAS_BASE = [
  "efectivo_bs",
  "efectivo_usd",
  "punto_venta",
  "pago_movil",
  "transferencia",
  "zelle",
  "usdt",
  "cashea",
] as const;

interface PagoElegido {
  instrument: string;
  currency: string;
  amount: string;
  reference?: string;
  account_id?: string;
}

function Cobrar({
  cotizacion,
  lineas,
  clienteId,
  cartId,
  deposito,
  onCerrar,
  onVendida,
  clienteNombre,
}: {
  cotizacion: CotizacionPos;
  lineas: { product_id: string; quantity: string }[];
  clienteId: string | null;
  /** La cuenta abierta que este cobro CIERRA: el servidor la borra en la
      misma transacción de la venta. */
  cartId: string;
  deposito: string;
  onCerrar: () => void;
  onVendida: (v: Venta) => void;
  /** null = mostrador. Fiar exige nombre: sin cliente no hay a quién cobrarle. */
  clienteNombre: string | null;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [pagos, setPagos] = useState<PagoElegido[]>([]);
  // El paso de confirmación del FIADO: la consecuencia dicha antes de emitir.
  const [fiando, setFiando] = useState(false);
  // El id de VENTA del cliente: nace con la pantalla de cobro y es la llave
  // de idempotencia — reintentar el botón no emite dos facturas.
  const saleId = useRef(crypto.randomUUID());

  const formas = useQuery({
    queryKey: ["formas-pago", empresa.id],
    staleTime: 60_000,
    queryFn: () => llamar<{ methods: FormaDePago[] }>("/v1/payment-methods"),
  });

  // Las formas que se OFRECEN: las configuradas del negocio (con su cuenta)
  // más TODAS las formas base que ninguna configurada cubra.
  const botones = useMemo(() => {
    const configuradas = (formas.data?.methods ?? []).filter((f) => f.is_active);
    const base: {
      clave: string;
      etiqueta: string;
      instrument: string;
      currency: string;
      account_id?: string;
    }[] = configuradas.map((f) => ({
      clave: f.id,
      etiqueta: f.name,
      instrument: f.kind,
      currency: MONEDA_FORMA[f.kind] ?? "VES",
      account_id: f.account_id,
    }));
    for (const inst of FORMAS_BASE) {
      if (!configuradas.some((f) => f.kind === inst)) {
        base.push({
          clave: inst,
          etiqueta: ETIQUETA_FORMA[inst]!,
          instrument: inst,
          currency: MONEDA_FORMA[inst]!,
        });
      }
    }
    return base;
  }, [formas.data]);

  const exactoEn = (currency: string): string | null => {
    if (currency === cotizacion.currency) return cotizacion.total;
    if (currency === cotizacion.functional_currency) return cotizacion.functional_total;
    return null;
  };

  function elegirForma(b: (typeof botones)[number]): void {
    if (pagos.length >= 2) {
      toast.warning("Máximo dos formas de pago", "Quita una para agregar otra.");
      return;
    }
    const indice = pagos.length;
    const exacto = indice === 0 ? (exactoEn(b.currency) ?? "") : "";
    setPagos((prev) => [
      ...prev,
      {
        instrument: b.instrument,
        currency: b.currency,
        amount: exacto,
        ...(b.account_id === undefined ? {} : { account_id: b.account_id }),
      },
    ]);
    // El foco cae en el monto recién puesto: con el exacto prellenado, el
    // siguiente Enter ya cobra — el flujo de teclado completo sin ratón.
    requestAnimationFrame(() => document.getElementById(`pos-pago-${indice}`)?.focus());
  }

  const vender = useMutation({
    mutationFn: () =>
      llamar<Venta>("/v1/pos/sales", {
        method: "POST",
        headers: { "Idempotency-Key": saleId.current },
        body: JSON.stringify({
          company_id: empresa.id,
          warehouse_id: deposito,
          cart_id: cartId,
          ...(clienteId === null ? {} : { customer_id: clienteId }),
          lines: lineas,
          payments: pagos.map((p) => ({
            instrument: p.instrument,
            currency: p.currency,
            amount: p.amount.trim().replace(",", "."),
            ...(p.reference === undefined || p.reference.trim() === ""
              ? {}
              : { reference: p.reference.trim() }),
            ...(p.account_id === undefined ? {} : { account_id: p.account_id }),
          })),
        }),
      }),
    onSuccess: (v) => onVendida(v),
    onError: (e) => toast.error("No se pudo cobrar", errorDePersona(e)),
  });

  const pagosValidos = pagos.every((p) => importeValido(p.amount.trim().replace(",", ".")));
  const listo = pagos.length > 0 && pagosValidos;
  // FIAR: solo con cliente identificado (el dominio lo respalda: una venta de
  // mostrador con saldo se rechaza). Con pagos puestos, fía EL RESTO — el
  // dominio ya deja el saldo pendiente cuando lo pagado no alcanza.
  const puedeFiar = clienteNombre !== null && pagosValidos && lineas.length > 0;

  if (fiando) {
    return (
      <Dialog open onOpenChange={(v) => !v && setFiando(false)}>
        <DialogContent className="max-w-md">
          <DialogTitle>Fiar esta venta</DialogTitle>
          <div className="space-y-4 pt-1">
            <p className="text-[0.95rem]">
              Se registra la venta por{" "}
              <span className="font-semibold tabular-nums">
                {mostrarImporte({
                  amount: cotizacion.functional_total,
                  currency: cotizacion.functional_currency,
                })}
              </span>{" "}
              y <span className="font-semibold">{clienteNombre}</span> queda debiendo{" "}
              {pagos.length === 0 ? "el total" : "el resto (lo pagado se abona ahora)"}. Lo cobras
              después desde Clientes o Mi dinero.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={() => setFiando(false)}>
                Volver
              </Button>
              <Button
                variant="primary"
                autoFocus
                disabled={vender.isPending}
                onClick={() => vender.mutate()}
              >
                {vender.isPending ? "Registrando…" : "Fiar y registrar"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Cobrar</DialogTitle>
        <div
          className="space-y-4 pt-1"
          onKeyDown={(e) => {
            // Enter fuera de un botón = confirmar, si ya se puede. Los botones
            // conservan su Enter propio (elegir forma, quitar, etc.).
            if (
              e.key === "Enter" &&
              !(e.target instanceof HTMLButtonElement) &&
              listo &&
              !vender.isPending
            ) {
              e.preventDefault();
              vender.mutate();
            }
          }}
        >
          <div className="rounded-lg bg-surface-muted p-3 text-center">
            <p className="text-[0.85rem] text-muted-foreground">Total a cobrar</p>
            <p className="text-3xl font-semibold tabular-nums">
              {mostrarImporte({
                amount: cotizacion.functional_total,
                currency: cotizacion.functional_currency,
              })}
            </p>
            {cotizacion.currency !== cotizacion.functional_currency && (
              <p className="text-[0.85rem] text-muted-foreground tabular-nums">
                = {mostrarImporte({ amount: cotizacion.total, currency: cotizacion.currency })}
              </p>
            )}
          </div>

          {pagos.length < 2 && (
            <div>
              <p className="pb-1.5 text-[0.88rem] font-medium">
                {pagos.length === 0 ? "¿Cómo te pagan?" : "¿Y el resto?"}
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {botones.map((b) => (
                  <Button
                    key={b.clave}
                    variant="secondary"
                    className="h-11 justify-start"
                    onClick={() => elegirForma(b)}
                  >
                    {b.instrument.startsWith("efectivo") ? <Banknote /> : <CreditCard />}
                    <span className="truncate">{b.etiqueta}</span>
                  </Button>
                ))}
              </div>
            </div>
          )}

          {pagos.map((p, i) => (
            <PagoFila
              key={i}
              indice={i}
              pago={p}
              cotizacion={cotizacion}
              onCambiar={(amount) =>
                setPagos((prev) => prev.map((x, j) => (j === i ? { ...x, amount } : x)))
              }
              onReferencia={(reference) =>
                setPagos((prev) => prev.map((x, j) => (j === i ? { ...x, reference } : x)))
              }
              onQuitar={() => setPagos((prev) => prev.filter((_, j) => j !== i))}
            />
          ))}

          <Button
            variant="primary"
            size="lg"
            className="h-12 w-full text-[1.05rem]"
            disabled={!listo || vender.isPending}
            onClick={() => vender.mutate()}
          >
            {vender.isPending ? "Cobrando…" : "Confirmar venta"}
          </Button>

          {/* FIAR: el botón secundario — la puerta que faltaba (el backend ya
              sabía). Con consumidor final va deshabilitado y se dice por qué. */}
          <Button
            variant="secondary"
            className="w-full"
            disabled={!puedeFiar || vender.isPending}
            title={clienteNombre === null ? "Para fiar, identifica al cliente" : undefined}
            onClick={() => setFiando(true)}
          >
            {pagos.length === 0 ? "Fiar" : "Fiar el resto"}
          </Button>
          {clienteNombre === null && (
            <p className="text-center text-[0.78rem] text-muted-foreground">
              Para fiar, identifica al cliente.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PagoFila({
  indice,
  pago,
  cotizacion,
  onCambiar,
  onReferencia,
  onQuitar,
}: {
  indice: number;
  pago: PagoElegido;
  cotizacion: CotizacionPos;
  onCambiar: (v: string) => void;
  onReferencia: (v: string) => void;
  onQuitar: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const limpio = pago.amount.trim().replace(",", ".");
  const esEfectivo = pago.instrument.startsWith("efectivo");
  const debounced = useDebounced(limpio, 350);

  // El vuelto EN VIVO, del servidor: solo efectivo da vuelto.
  const totalReferencia =
    pago.currency === cotizacion.functional_currency
      ? cotizacion.functional_total
      : cotizacion.currency === pago.currency
        ? cotizacion.total
        : cotizacion.functional_total;
  const vuelto = useQuery({
    queryKey: ["pos-change", empresa.id, debounced, pago.currency],
    enabled: esEfectivo && importeValido(debounced) && debounced === limpio,
    staleTime: 30_000,
    queryFn: () =>
      llamar<{ change: string; change_currency: string }>(
        `/v1/pos/change?total=${totalReferencia}&currency=${pago.currency === cotizacion.functional_currency ? cotizacion.functional_currency : cotizacion.currency}&tendered=${debounced}&tendered_currency=${pago.currency}`,
      ),
  });

  const cambio = vuelto.data ? compararImportes(vuelto.data.change, "0") : null;

  return (
    <div className="space-y-1 rounded-md border border-border p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[0.88rem] font-medium">
          {ETIQUETA_FORMA[pago.instrument] ?? pago.instrument}
        </span>
        <Button variant="ghost" size="iconSm" aria-label="Quitar esta forma" onClick={onQuitar}>
          <X />
        </Button>
      </div>
      <MoneyInput
        id={`pos-pago-${indice}`}
        value={pago.amount}
        onChange={onCambiar}
        currency={pago.currency === "VES" ? "Bs." : pago.currency}
        ariaDescribedby={undefined}
        ariaInvalid={undefined}
      />
      {/* Todo lo que no es efectivo trae un comprobante: la referencia
          acompaña al pago desde hoy, la API del método llegará después. */}
      {!esEfectivo && (
        <Input
          aria-label="Referencia del pago"
          className="font-mono"
          placeholder="Referencia (opcional)"
          value={pago.reference ?? ""}
          onChange={(e) => onReferencia(e.target.value)}
        />
      )}
      {esEfectivo && cambio !== null && cambio > 0 && (
        <p className="text-[0.88rem] text-success-soft-foreground tabular-nums">
          Vuelto:{" "}
          {mostrarImporte({ amount: vuelto.data!.change, currency: vuelto.data!.change_currency })}
        </p>
      )}
      {esEfectivo && cambio !== null && cambio < 0 && (
        <p className="text-[0.88rem] text-muted-foreground tabular-nums">
          Falta:{" "}
          {mostrarImporte({
            amount: vuelto.data!.change.replace("-", ""),
            currency: vuelto.data!.change_currency,
          })}
        </p>
      )}
    </div>
  );
}

function VentaLista({
  venta,
  deudor,
  onNueva,
}: {
  venta: Venta;
  deudor: string | null;
  onNueva: () => void;
}): React.JSX.Element {
  const { empresa } = useSesion();
  const toast = useToast();
  const esRecibo = venta.document.kind === "receipt";
  const numero = `${venta.document.series}-${String(venta.document.document_number ?? "").padStart(8, "0")}`;
  // Con saldo, la venta quedó FIADA: el número lo dijo el servidor (funcional).
  const fiada = compararImportes(venta.balance, "0") > 0;

  async function abrirPdf(): Promise<void> {
    // El PDF exige el Bearer: se baja con fetch y se abre como blob.
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const r = await fetch(`${API_URL}/v1/documents/${venta.document.id}/pdf`, {
      headers: { Authorization: `Bearer ${token}`, "X-Company-Id": empresa.id },
    });
    if (!r.ok) {
      toast.error("No se pudo abrir el PDF", "Vuelve a intentar en un momento.");
      return;
    }
    const url = URL.createObjectURL(await r.blob());
    window.open(url, "_blank", "noopener");
  }

  const textoWhatsApp = encodeURIComponent(
    `Tu compra en ${empresa.legal_name}: ${venta.document.kind === "receipt" ? "recibo" : "factura"} ${numero}. ¡Gracias!`,
  );

  return (
    <Dialog open onOpenChange={(v) => !v && onNueva()}>
      <DialogContent className="max-w-sm text-center">
        <DialogTitle className="text-center">
          {fiada ? "Venta registrada" : esRecibo ? "Venta registrada" : "¡Venta lista!"}
        </DialogTitle>
        <div className="space-y-3 pt-2">
          <p className="text-[0.95rem] text-muted-foreground">
            {esRecibo ? "Recibo" : "Factura"} {numero}
          </p>
          {fiada && (
            <div className="rounded-lg bg-warning-soft p-4">
              <p className="text-[0.85rem] text-warning-soft-foreground">
                {deudor ?? "El cliente"} queda debiendo
              </p>
              <p className="text-3xl font-semibold text-warning-soft-foreground tabular-nums">
                {mostrarImporte({
                  amount: venta.balance,
                  currency: venta.document.functional_currency,
                })}
              </p>
              <p className="pt-1 text-[0.8rem] text-warning-soft-foreground">
                Lo cobras después desde Clientes o Mi dinero.
              </p>
            </div>
          )}
          {venta.change !== null && (
            <div className="rounded-lg bg-success-soft p-4">
              <p className="text-[0.85rem] text-success-soft-foreground">Vuelto</p>
              <p className="text-3xl font-semibold text-success-soft-foreground tabular-nums">
                {mostrarImporte({
                  amount: venta.change.amount,
                  currency: venta.change.currency,
                })}
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => void abrirPdf()}>
              <Printer /> Imprimir
            </Button>
            <a
              href={`https://wa.me/?text=${textoWhatsApp}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button variant="secondary" className="w-full">
                <MessageCircle /> WhatsApp
              </Button>
            </a>
          </div>
          <Button variant="primary" size="lg" className="h-12 w-full" onClick={onNueva} autoFocus>
            Nueva venta
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
