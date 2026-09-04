import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
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
  };
  payments: { payment: Record<string, string> }[];
  change: { amount: string; currency: string } | null;
  document_status: string;
}

function useDebounced<T>(valor: T, ms: number): T {
  const [v, setV] = useState(valor);
  useEffect(() => {
    const t = setTimeout(() => setV(valor), ms);
    return () => clearTimeout(t);
  }, [valor, ms]);
  return v;
}

export function Vender(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [busqueda, setBusqueda] = useState("");
  const buscarRef = useRef<HTMLInputElement>(null);
  const [carrito, setCarrito] = useState<Map<string, { producto: ProductoFila; qty: number }>>(
    new Map(),
  );
  const [cliente, setCliente] = useState<ClienteFila | null>(null);
  // «Venta sin identificar»: una DECISIÓN explícita del cajero, no un default.
  const [sinIdentificar, setSinIdentificar] = useState(false);
  const [cobrando, setCobrando] = useState(false);
  const [venta, setVenta] = useState<Venta | null>(null);
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

  // La cotización del carrito: SIEMPRE del servidor, con debounce.
  const lineas = useMemo(
    () =>
      [...carrito.values()].map((l) => ({
        product_id: l.producto.id,
        quantity: String(l.qty),
      })),
    [carrito],
  );
  const lineasDebounced = useDebounced(lineas, 300);
  const cotizacion = useQuery({
    queryKey: ["pos-quote", empresa.id, cliente?.id ?? "mostrador", lineasDebounced],
    enabled: lineasDebounced.length > 0,
    placeholderData: (prev) => prev,
    queryFn: () =>
      cotizarPos(llamar, {
        company_id: empresa.id,
        ...(cliente === null ? {} : { customer_id: cliente.id }),
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
    setCarrito((prev) => {
      const s = new Map(prev);
      const actual = s.get(p.id);
      s.set(p.id, { producto: p, qty: (actual?.qty ?? 0) + 1 });
      return s;
    });
  }

  function cambiarQty(id: string, delta: number): void {
    setCarrito((prev) => {
      const s = new Map(prev);
      const l = s.get(id);
      if (!l) return prev;
      const qty = l.qty + delta;
      if (qty <= 0) s.delete(id);
      else s.set(id, { ...l, qty });
      return s;
    });
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

  const clienteResuelto = modoRecibos || cliente !== null || sinIdentificar;

  // En modo recibos no hay cédula que pedir primero: el foco va a la búsqueda.
  useEffect(() => {
    if (modoRecibos) buscarRef.current?.focus();
  }, [modoRecibos]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2" && carrito.size > 0 && clienteResuelto) {
        e.preventDefault();
        setCobrando(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [carrito.size, clienteResuelto]);

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
          <IdentificarCliente
            opcional={modoRecibos}
            cliente={cliente}
            sinIdentificar={sinIdentificar}
            permiteSinIdentificar={ajustes.data?.allow_unidentified_sales ?? true}
            onCliente={(c) => {
              setCliente(c);
              setSinIdentificar(false);
              buscarRef.current?.focus();
            }}
            onSinIdentificar={() => {
              setSinIdentificar(true);
              setCliente(null);
              buscarRef.current?.focus();
            }}
            onCambiar={() => {
              setCliente(null);
              setSinIdentificar(false);
            }}
          />
          <div className="min-h-0 flex-1 overflow-y-auto px-3">
            {carrito.size === 0 ? (
              <div className="flex h-full flex-col items-center justify-center py-16 text-center text-muted-foreground">
                <ShoppingCart className="size-8 text-faint-foreground" />
                <p className="mt-2 text-[0.95rem]">Toca un producto para empezar</p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {[...carrito.values()].map((l) => {
                  const cot = cotizacion.data?.lines.find((x) => x.product_id === l.producto.id);
                  return (
                    <li key={l.producto.id} className="flex items-center gap-2 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[0.92rem] font-medium">{l.producto.name}</p>
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
                          aria-label={`Quitar uno de ${l.producto.name}`}
                          onClick={() => cambiarQty(l.producto.id, -1)}
                        >
                          {l.qty === 1 ? <Trash2 /> : <Minus />}
                        </Button>
                        <span className="w-7 text-center text-[0.95rem] font-medium tabular-nums">
                          {l.qty}
                        </span>
                        <Button
                          variant="ghost"
                          size="iconSm"
                          aria-label={`Agregar uno de ${l.producto.name}`}
                          onClick={() => cambiarQty(l.producto.id, 1)}
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
            {cotizacion.data && carrito.size > 0 && (
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
                carrito.size === 0 || !cotizacion.data || deposito === null || !clienteResuelto
              }
              onClick={() => setCobrando(true)}
            >
              Cobrar {carrito.size > 0 && clienteResuelto ? "· F2" : ""}
            </Button>
            {carrito.size > 0 && !clienteResuelto && (
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
            clienteId={cliente?.id ?? null}
            deposito={deposito}
            onCerrar={() => setCobrando(false)}
            onVendida={(v) => {
              setCobrando(false);
              setVenta(v);
              setCarrito(new Map());
              setCliente(null);
              setSinIdentificar(false);
            }}
          />
        )}
        {venta !== null && (
          <VentaLista
            venta={venta}
            onNueva={() => {
              setVenta(null);
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
  otro: "VES",
};

interface PagoElegido {
  instrument: string;
  currency: string;
  amount: string;
  account_id?: string;
}

function Cobrar({
  cotizacion,
  lineas,
  clienteId,
  deposito,
  onCerrar,
  onVendida,
}: {
  cotizacion: CotizacionPos;
  lineas: { product_id: string; quantity: string }[];
  clienteId: string | null;
  deposito: string;
  onCerrar: () => void;
  onVendida: (v: Venta) => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [pagos, setPagos] = useState<PagoElegido[]>([]);
  // El id de VENTA del cliente: nace con la pantalla de cobro y es la llave
  // de idempotencia — reintentar el botón no emite dos facturas.
  const saleId = useRef(crypto.randomUUID());

  const formas = useQuery({
    queryKey: ["formas-pago", empresa.id],
    staleTime: 60_000,
    queryFn: () => llamar<{ methods: FormaDePago[] }>("/v1/payment-methods"),
  });

  // Las formas que se OFRECEN: las configuradas del negocio; el efectivo
  // existe siempre aunque nadie lo configure — la gaveta no necesita alta.
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
    for (const efectivo of ["efectivo_bs", "efectivo_usd"] as const) {
      if (!configuradas.some((f) => f.kind === efectivo)) {
        base.push({
          clave: efectivo,
          etiqueta: ETIQUETA_FORMA[efectivo]!,
          instrument: efectivo,
          currency: MONEDA_FORMA[efectivo]!,
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
          ...(clienteId === null ? {} : { customer_id: clienteId }),
          lines: lineas,
          payments: pagos.map((p) => ({
            instrument: p.instrument,
            currency: p.currency,
            amount: p.amount.trim().replace(",", "."),
            ...(p.account_id === undefined ? {} : { account_id: p.account_id }),
          })),
        }),
      }),
    onSuccess: (v) => onVendida(v),
    onError: (e) => toast.error("No se pudo cobrar", errorDePersona(e)),
  });

  const listo =
    pagos.length > 0 && pagos.every((p) => importeValido(p.amount.trim().replace(",", ".")));

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
  onQuitar,
}: {
  indice: number;
  pago: PagoElegido;
  cotizacion: CotizacionPos;
  onCambiar: (v: string) => void;
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

function VentaLista({ venta, onNueva }: { venta: Venta; onNueva: () => void }): React.JSX.Element {
  const { empresa } = useSesion();
  const toast = useToast();
  const esRecibo = venta.document.kind === "receipt";
  const numero = `${venta.document.series}-${String(venta.document.document_number ?? "").padStart(8, "0")}`;

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
          {esRecibo ? "Venta registrada" : "¡Venta lista!"}
        </DialogTitle>
        <div className="space-y-3 pt-2">
          <p className="text-[0.95rem] text-muted-foreground">
            {esRecibo ? "Recibo" : "Factura"} {numero}
          </p>
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
