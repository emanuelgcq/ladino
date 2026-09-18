import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, ClipboardList, Package, Plus, Trash2, Truck, User } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { errorDePersona } from "../../lib.js";
import { esCero } from "../../components/decimal-compare.js";
import { Button } from "../../ui/button.js";
import { Card } from "../../ui/card.js";
import { Input } from "../../ui/input.js";
import { SimpleSelect } from "../../ui/select.js";
import { useToast } from "../../ui/toast.js";
import {
  EntityPicker,
  FormField,
  importeValido,
  type EntityOption,
} from "../../components/forms.js";
import { ConfirmarSobregiro, esSinSaldo } from "../../components/sobregiro.js";
import { fechaLocal } from "../../fechas.js";
import { MoneyDualInput } from "../../components/MoneyDualInput.js";
import { TARJETAS_FACTURA } from "../../components/capa-fiscal/textos.js";

/**
 * LLEGÓ MERCANCÍA (ADR-0066) — LA ÚNICA PUERTA por la que la mercancía entra al negocio.
 *
 * La persona cuenta el hecho, una pregunta por pantalla, y el SERVIDOR decide cómo se registra:
 * esta pantalla no elige cuentas ni calcula dinero. Antes había tres puertas —el alta de
 * producto, «Registrar compra» y «Entrada de existencias»— que hacían lo mismo con tres
 * lenguajes y dos monedas, y la persona elegía el efecto en los libros eligiendo un ítem de
 * menú.
 *
 * La clave de idempotencia nace AL ENTRAR, no al confirmar: un doble clic, un reintento o una
 * conexión que va y viene no crean dos llegadas.
 */

type Paso = "pedido" | "origen" | "que" | "factura" | "pago" | "deposito" | "confirmar";
type Origen = "proveedor" | "propia";
type EstadoFactura = "present" | "pending" | "none";

interface ProductoFila {
  id: string;
  name: string;
  sku: string;
  kind: string;
  is_composed: boolean;
  tracks_lots: boolean;
  tracks_expiry: boolean;
}
interface Deposito {
  id: string;
  name: string;
  is_default: boolean;
  /** El endpoint devuelve el estado, no una bandera: «active» es el que admite mercancía. */
  status: string;
}
interface FormaDePago {
  id: string;
  name: string;
  kind: string;
  account_id: string | null;
  is_active: boolean;
}
interface Linea {
  id: string;
  producto: EntityOption | null;
  compuesto: boolean;
  lleva_paquete: boolean;
  lleva_vencimiento: boolean;
  cantidad: string;
  costo: string;
  /** La moneda en la que se ESCRIBIÓ el costo; puede no ser la del documento. */
  monedaCosto: string;
  por: "unidad" | "total";
  paquete: string;
  vence: string;
  /**
   * La línea del pedido que esta satisface. Si la trae, el costo lo pone el PEDIDO y esta
   * pantalla no enseña dinero: quien recibe cuenta bultos, no valora mercancía (ADR-0066 §7).
   */
  ordenLineaId: string | null;
}

/** Un pedido esperando mercancía, tal como lo lista «Por recibir». */
interface PedidoPendiente {
  id: string;
  order_number: number;
  supplier_id: string;
  supplier_name: string;
  transaction_currency: string;
  expected_at: string | null;
  age_days: number;
}
interface LineaDePedido {
  id: string;
  product_id: string;
  description: string;
}
interface AvanceDePedido {
  order_line_id: string;
  quantity_pending: string;
}

const CANT_RE = /^\d{1,16}(\.\d{1,8})?$/;
const lineaVacia = (): Linea => ({
  id: crypto.randomUUID(),
  producto: null,
  compuesto: false,
  lleva_paquete: false,
  lleva_vencimiento: false,
  cantidad: "",
  costo: "",
  monedaCosto: "VES",
  por: "unidad",
  paquete: "",
  vence: "",
  ordenLineaId: null,
});

/** «8.00000000» es como lo guarda la base; «8» es como se cuenta. */
function sinCerosSobrantes(q: string): string {
  return q.includes(".") ? q.replace(/\.?0+$/, "") : q;
}

/** El día de hoy tal como lo escribe el navegador, que es el que la persona ve. */
function hoyLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function haceDias(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function LlegoMercancia(): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();

  const [params] = useSearchParams();
  const pedidoDeLaUrl = params.get("pedido");

  const [clave] = useState(() => crypto.randomUUID());
  const [paso, setPaso] = useState<Paso>("pedido");
  const [pedido, setPedido] = useState<PedidoPendiente | null>(null);
  const [origen, setOrigen] = useState<Origen | null>(null);
  const [proveedor, setProveedor] = useState<EntityOption | null>(null);
  const [creandoProveedor, setCreandoProveedor] = useState(false);
  const [nuevoNombre, setNuevoNombre] = useState("");
  const [nuevoRif, setNuevoRif] = useState("");
  const [lineas, setLineas] = useState<Linea[]>([lineaVacia()]);
  const [fecha, setFecha] = useState(hoyLocal());
  const [moneda, setMoneda] = useState("VES");
  const [estadoFactura, setEstadoFactura] = useState<EstadoFactura | null>(null);
  const [nroFactura, setNroFactura] = useState("");
  const [nroControl, setNroControl] = useState("");
  const [pagada, setPagada] = useState<boolean | null>(null);
  const [forma, setForma] = useState<string | null>(null);
  const [deposito, setDeposito] = useState<string | null>(null);
  const [sinSaldo, setSinSaldo] = useState<string | null>(null);
  const [hecho, setHecho] = useState<{ kind: string; productos: number } | null>(null);

  const puedeFacturar = puede("purchase.invoice.register");
  const puedePagar = puede("purchase.payment.register");

  /**
   * Los pedidos que esperan mercancía. Si no hay ninguno —o si quien entra no puede verlos— el
   * paso 0 se salta solo: una pregunta que siempre tiene la misma respuesta no es una pregunta.
   */
  const pendientes = useQuery({
    queryKey: ["pedidos-pendientes", empresa.id],
    staleTime: 30_000,
    retry: false,
    queryFn: () => llamar<{ items: PedidoPendiente[] }>("/v1/purchase-orders?pending=1"),
  });
  const hayPedidos = (pendientes.data?.items.length ?? 0) > 0;
  useEffect(() => {
    if (paso !== "pedido" || pedidoDeLaUrl !== null) return;
    if (pendientes.isPending) return;
    if (!hayPedidos) setPaso("origen");
  }, [paso, pedidoDeLaUrl, pendientes.isPending, hayPedidos]);

  const depositos = useQuery({
    queryKey: ["depositos", empresa.id],
    staleTime: 5 * 60_000,
    queryFn: () => llamar<Deposito[]>("/v1/warehouses"),
  });
  const activos = useMemo(
    () => (depositos.data ?? []).filter((d) => d.status === "active"),
    [depositos.data],
  );
  const depositoElegido =
    deposito ?? activos.find((d) => d.is_default)?.id ?? activos[0]?.id ?? null;

  const formas = useQuery({
    queryKey: ["formas-pago", empresa.id],
    enabled: pagada === true,
    queryFn: () => llamar<{ methods: FormaDePago[] }>("/v1/payment-methods"),
  });

  const buscarProveedor = useCallback(
    async (q: string): Promise<EntityOption[]> => {
      const r = await llamar<{
        items: { id: string; legal_name: string; tax_id: string | null }[];
      }>(`/v1/suppliers?per_page=50${q === "" ? "" : `&search=${encodeURIComponent(q)}`}`);
      return r.items.map((s) => ({
        id: s.id,
        label: s.legal_name,
        ...(s.tax_id === null ? {} : { detalle: s.tax_id }),
      }));
    },
    [llamar],
  );
  const [fichas, setFichas] = useState<Record<string, ProductoFila>>({});
  const buscarProducto = useCallback(
    async (q: string): Promise<EntityOption[]> => {
      const r = await llamar<{ items: ProductoFila[] }>(
        `/v1/products?only_active=1&per_page=50${q === "" ? "" : `&search=${encodeURIComponent(q)}`}`,
      );
      setFichas((prev) => {
        const sig = { ...prev };
        for (const p of r.items) sig[p.id] = p;
        return sig;
      });
      return r.items
        .filter((p) => p.kind === "good")
        .map((p) => ({
          id: p.id,
          label: p.name,
          detalle: p.is_composed ? "Se arma con receta: lo que entra son sus ingredientes" : p.sku,
        }));
    },
    [llamar],
  );

  /** Lo vendido desde la fecha elegida: solo si se fecha hacia atrás. */
  const productosElegidos = lineas.map((l) => l.producto?.id).filter((x): x is string => !!x);
  const impacto = useQuery({
    queryKey: ["impacto-llegada", empresa.id, fecha, productosElegidos.join(",")],
    enabled: fecha !== hoyLocal() && productosElegidos.length > 0,
    queryFn: () =>
      llamar<{ sales_since: { product_id: string; name: string; quantity: string }[] }>(
        `/v1/arrivals/impact?from=${fecha}&product_ids=${productosElegidos.join(",")}`,
      ),
  });

  /**
   * ABRIR UN PEDIDO: trae lo que falta por recibir y arma las líneas ya contadas. El precio
   * acordado NO viaja hasta aquí a propósito — lo lee el servidor de la línea del pedido, que es
   * lo que hace que la recepción a ciegas sea de verdad y no una convención de la pantalla.
   */
  const abrirPedido = useMutation({
    mutationFn: async (p: PedidoPendiente) => {
      const d = await llamar<{ lines: LineaDePedido[]; progress: AvanceDePedido[] }>(
        `/v1/purchase-orders/${p.id}`,
      );
      const falta = new Map(d.progress.map((x) => [x.order_line_id, x.quantity_pending]));
      const pendientesDeLinea = d.lines.filter((l) => !esCero(falta.get(l.id) ?? "0"));
      const fichasDeLinea = await Promise.all(
        pendientesDeLinea.map((l) => llamar<ProductoFila>(`/v1/products/${l.product_id}`)),
      );
      return { p, lineas: pendientesDeLinea, falta, fichasDeLinea };
    },
    onSuccess: ({ p, lineas: ls, falta, fichasDeLinea }) => {
      setFichas((prev) => {
        const sig = { ...prev };
        for (const f of fichasDeLinea) sig[f.id] = f;
        return sig;
      });
      setPedido(p);
      setOrigen("proveedor");
      setProveedor({ id: p.supplier_id, label: p.supplier_name });
      setMoneda(p.transaction_currency);
      setLineas(
        ls.map((l, i) => {
          const f = fichasDeLinea[i];
          return {
            ...lineaVacia(),
            producto: { id: l.product_id, label: f?.name ?? l.description },
            compuesto: f?.is_composed ?? false,
            lleva_paquete: f?.tracks_lots ?? false,
            lleva_vencimiento: f?.tracks_expiry ?? false,
            cantidad: sinCerosSobrantes(falta.get(l.id) ?? "0"),
            ordenLineaId: l.id,
          };
        }),
      );
      setPaso("que");
    },
    onError: (e) => toast.error("No se pudo abrir el pedido", errorDePersona(e)),
  });

  /**
   * El pedido llega por la URL cuando se entra desde «Por recibir» → «Ya llegó». Se abre una
   * sola vez: `abrirPedido` no es idempotente para la pantalla —repone las líneas— y reponerlas
   * encima de lo que la persona ya contó le borraría el trabajo.
   */
  const abrirDesdeUrl = abrirPedido.mutate;
  const yaSeIntento = abrirPedido.isPending || abrirPedido.isSuccess || abrirPedido.isError;
  useEffect(() => {
    if (pedidoDeLaUrl === null || yaSeIntento) return;
    const p = pendientes.data?.items.find((x) => x.id === pedidoDeLaUrl);
    if (p !== undefined) abrirDesdeUrl(p);
  }, [pedidoDeLaUrl, yaSeIntento, pendientes.data, abrirDesdeUrl]);

  const crearProveedor = useMutation({
    mutationFn: () =>
      llamar<{ id: string; legal_name: string }>("/v1/suppliers", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          legal_name: nuevoNombre.trim(),
          tax_id: nuevoRif.trim() === "" ? null : nuevoRif.trim().toUpperCase(),
          supplier_kind: "nacional",
        }),
      }),
    onSuccess: (r) => {
      setProveedor({ id: r.id, label: r.legal_name });
      setCreandoProveedor(false);
      toast.success("Proveedor agregado");
    },
    onError: (e) => toast.error("No se pudo agregar el proveedor", errorDePersona(e)),
  });

  const lineasValidas = lineas.filter(
    (l) =>
      l.producto !== null &&
      !l.compuesto &&
      CANT_RE.test(l.cantidad.trim().replace(",", ".")) &&
      !esCero(l.cantidad) &&
      // A ciegas no hay costo que validar: lo pone el pedido.
      (l.ordenLineaId !== null || importeValido(l.costo.trim().replace(",", "."))) &&
      (!l.lleva_paquete || l.paquete.trim() !== "") &&
      (!l.lleva_vencimiento || l.vence !== ""),
  );
  const hayCompuesto = lineas.some((l) => l.compuesto);
  const listoQue =
    lineasValidas.length > 0 &&
    lineasValidas.length === lineas.filter((l) => l.producto !== null).length;

  const registrar = useMutation({
    mutationFn: (forzar: boolean) => {
      const configurada = (formas.data?.methods ?? []).find((f) => f.id === forma);
      const pago =
        pagada !== true || forma === null
          ? undefined
          : {
              instrument: configurada?.kind ?? forma,
              ...(configurada?.account_id == null ? {} : { account_id: configurada.account_id }),
              ...(forzar ? { allow_negative_balance: true } : {}),
            };
      return llamar<{ kind: string }>("/v1/arrivals", {
        method: "POST",
        headers: { "Idempotency-Key": clave },
        body: JSON.stringify({
          company_id: empresa.id,
          warehouse_id: depositoElegido,
          currency: moneda,
          ...(fecha === hoyLocal() ? {} : { arrived_on: fecha }),
          ...(pedido === null ? {} : { purchase_order_id: pedido.id }),
          ...(origen === "propia"
            ? {}
            : {
                supplier_id: proveedor?.id,
                invoice: estadoFactura,
                ...(estadoFactura === "present" && nroFactura.trim() !== ""
                  ? { supplier_document_number: nroFactura.trim() }
                  : {}),
                ...(estadoFactura === "present" && nroControl.trim() !== ""
                  ? { supplier_control_number: nroControl.trim() }
                  : {}),
                ...(pago === undefined ? {} : { payment: pago }),
              }),
          lines: lineasValidas.map((l) => ({
            product_id: l.producto!.id,
            quantity: l.cantidad.trim().replace(",", "."),
            // A CIEGAS: la línea del pedido va, el costo NO. El servidor lo lee del pedido y el
            // contrato rechaza que viaje un importe con ella.
            ...(l.ordenLineaId !== null
              ? { purchase_order_line_id: l.ordenLineaId }
              : {
                  // Uno de los dos, nunca los dos: el otro lo calcula el servidor.
                  ...(l.por === "unidad"
                    ? { unit_amount: l.costo.trim().replace(",", ".") }
                    : { amount: l.costo.trim().replace(",", ".") }),
                  // En qué moneda lo escribió. Si no es la del documento, el servidor convierte
                  // con la tasa del día del hecho y guarda las dos cosas (migración 71).
                  ...(l.monedaCosto === moneda ? {} : { capture_currency: l.monedaCosto }),
                }),
            ...(l.paquete.trim() === "" ? {} : { lot_code: l.paquete.trim() }),
            ...(l.vence === "" ? {} : { lot_expires_at: l.vence }),
          })),
        }),
      });
    },
    onSuccess: (r) => {
      setHecho({ kind: r.kind, productos: lineasValidas.length });
      void qc.invalidateQueries({ queryKey: ["stock", empresa.id] });
      void qc.invalidateQueries({ queryKey: ["compras", empresa.id] });
    },
    onError: (e) => {
      const falta = esSinSaldo(e);
      if (falta !== null) {
        setSinSaldo(falta);
        return;
      }
      toast.error("No se pudo registrar la llegada", errorDePersona(e));
    },
  });

  // ── Navegación ────────────────────────────────────────────────────────────
  const pasos: Paso[] = useMemo(() => {
    const p: Paso[] = [];
    if (hayPedidos || pedido !== null) p.push("pedido");
    // Venir de un pedido YA dice de quién vino: preguntarlo otra vez sería pedir dos veces lo
    // mismo, que es justo lo que ADR-0066 vino a quitar.
    if (pedido === null) p.push("origen");
    p.push("que");
    if (origen === "proveedor") {
      p.push("factura");
      if (puedePagar && estadoFactura !== "pending") p.push("pago");
    }
    if (activos.length > 1) p.push("deposito");
    p.push("confirmar");
    return p;
  }, [origen, estadoFactura, puedePagar, activos.length, hayPedidos, pedido]);
  const indice = pasos.indexOf(paso);
  const avanzar = (): void => {
    const sig = pasos[indice + 1];
    if (sig !== undefined) setPaso(sig);
  };
  const atras = (): void => {
    const ant = pasos[indice - 1];
    if (ant !== undefined) setPaso(ant);
  };

  if (hecho !== null) {
    return (
      <div className="mx-auto max-w-lg space-y-4 py-8 text-center">
        <div className="flex justify-center">
          <span className="rounded-full bg-success-soft p-3 text-success-soft-foreground">
            <Check className="size-7" />
          </span>
        </div>
        <h1 className="text-xl font-semibold">Listo</h1>
        <p className="text-muted-foreground">
          {hecho.productos === 1
            ? "Entró 1 producto al depósito."
            : `Entraron ${hecho.productos} productos al depósito.`}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="secondary" onClick={() => void navigate("/inventario")}>
            Ver lo que tengo
          </Button>
          {hecho.kind !== "own" && (
            <Button variant="secondary" onClick={() => void navigate("/compras")}>
              Ver lo que debo
            </Button>
          )}
          <Button variant="primary" onClick={() => window.location.reload()}>
            Registrar otra llegada
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5 py-4">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          {indice > 0 && (
            <Button variant="ghost" size="iconSm" aria-label="Atrás" onClick={atras}>
              <ArrowLeft />
            </Button>
          )}
          <h1 className="text-xl font-semibold">Llegó mercancía</h1>
        </div>
        <div className="h-1 w-full rounded-full bg-muted" role="presentation">
          <div
            className="h-1 rounded-full bg-accent transition-all"
            style={{ width: `${((indice + 1) / pasos.length) * 100}%` }}
          />
        </div>
      </div>

      {/* ── Paso 0: ¿viene de un pedido? ────────────────────────────────── */}
      {paso === "pedido" && (
        <div className="space-y-3">
          <h2 className="text-lg font-medium">¿Viene de uno de estos pedidos?</h2>
          {pendientes.isPending || abrirPedido.isPending ? (
            <p className="text-[0.9rem] text-muted-foreground">Buscando pedidos…</p>
          ) : (
            <div className="grid gap-3">
              {(pendientes.data?.items ?? []).map((p) => (
                <Card
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  className="cursor-pointer p-4 hover:border-accent"
                  onClick={() => abrirPedido.mutate(p)}
                  onKeyDown={(e) => e.key === "Enter" && abrirPedido.mutate(p)}
                >
                  <div className="flex items-start gap-3">
                    <ClipboardList className="mt-0.5 size-5 shrink-0 text-accent" />
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
                        {p.expected_at === null
                          ? ""
                          : ` · esperado el ${fechaLocal(p.expected_at)}`}
                      </p>
                    </div>
                  </div>
                </Card>
              ))}
              <Card
                role="button"
                tabIndex={0}
                className="cursor-pointer p-4 hover:border-accent"
                onClick={() => setPaso("origen")}
                onKeyDown={(e) => e.key === "Enter" && setPaso("origen")}
              >
                <p className="font-medium">No, llegó sin pedido</p>
                <p className="text-[0.85rem] text-muted-foreground">
                  La compraste en el momento, o ya era tuya.
                </p>
              </Card>
            </div>
          )}
        </div>
      )}

      {/* ── Paso 1: ¿de quién vino? ─────────────────────────────────────── */}
      {paso === "origen" && (
        <div className="space-y-3">
          <h2 className="text-lg font-medium">¿De quién vino?</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Card
              role="button"
              tabIndex={0}
              className="cursor-pointer p-4 hover:border-accent"
              onClick={() => {
                setOrigen("proveedor");
                setPaso("que");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setOrigen("proveedor");
                  setPaso("que");
                }
              }}
            >
              <Truck className="mb-2 size-6 text-accent" />
              <p className="font-medium">Me la trajo un proveedor</p>
              <p className="text-[0.85rem] text-muted-foreground">
                Se la compraste a alguien: le pagaste o le quedas debiendo.
              </p>
            </Card>
            <Card
              role="button"
              tabIndex={0}
              className="cursor-pointer p-4 hover:border-accent"
              onClick={() => {
                setOrigen("propia");
                setPaso("que");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setOrigen("propia");
                  setPaso("que");
                }
              }}
            >
              <User className="mb-2 size-6 text-accent" />
              <p className="font-medium">Ya era mía</p>
              <p className="text-[0.85rem] text-muted-foreground">
                La tenías al empezar, o la pusiste tú. No queda deuda con nadie.
              </p>
            </Card>
          </div>
        </div>
      )}

      {/* ── Paso 2: ¿qué llegó? ─────────────────────────────────────────── */}
      {paso === "que" && (
        <div className="space-y-4">
          <h2 className="text-lg font-medium">¿Qué llegó?</h2>

          {pedido !== null && (
            <div className="rounded-md border border-border bg-muted/40 p-3 text-[0.9rem]">
              <p>
                Del pedido n.º <strong>{pedido.order_number}</strong> a{" "}
                <strong>{pedido.supplier_name}</strong>.
              </p>
              <p className="mt-1 text-muted-foreground">
                Cuenta lo que llegó de verdad. Si vino menos, corrige la cantidad: lo que falte
                sigue esperando. Lo que costó ya está en el pedido, no hace falta escribirlo.
              </p>
            </div>
          )}

          {origen === "proveedor" && pedido === null && (
            <div className="space-y-2">
              {!creandoProveedor ? (
                <div className="flex items-end gap-2">
                  <FormField label="Proveedor" required className="flex-1">
                    {(p) => (
                      <EntityPicker
                        id={p.id}
                        value={proveedor}
                        onChange={setProveedor}
                        buscar={buscarProveedor}
                        placeholder="Busca o elige…"
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
                  <FormField label="Cédula o RIF" hint="Si te la dio. Puede quedar vacío.">
                    {(p) => (
                      <Input
                        {...p}
                        value={nuevoRif}
                        onChange={(e) => setNuevoRif(e.target.value)}
                      />
                    )}
                  </FormField>
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setCreandoProveedor(false)}>
                      Cancelar
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={nuevoNombre.trim() === "" || crearProveedor.isPending}
                      onClick={() => crearProveedor.mutate()}
                    >
                      Agregar
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="space-y-3">
            {lineas.map((l, i) => (
              <div key={l.id} className="space-y-2 rounded-md border border-border p-3">
                <div className="flex items-start gap-2">
                  <div className="flex-1">
                    <label htmlFor={`prod-${l.id}`} className="sr-only">
                      Producto de la línea {i + 1}
                    </label>
                    {l.ordenLineaId !== null ? (
                      // Del pedido: el producto no se cambia. Cambiarlo sería recibir otra cosa,
                      // y eso es otra llegada, no una corrección de esta.
                      <p id={`prod-${l.id}`} className="flex min-h-9 items-center px-1 font-medium">
                        {l.producto?.label}
                      </p>
                    ) : (
                      <EntityPicker
                        id={`prod-${l.id}`}
                        value={l.producto}
                        onChange={(v) =>
                          setLineas((prev) =>
                            prev.map((x) =>
                              x.id === l.id
                                ? {
                                    ...x,
                                    producto: v,
                                    compuesto:
                                      v === null ? false : (fichas[v.id]?.is_composed ?? false),
                                    lleva_paquete:
                                      v === null ? false : (fichas[v.id]?.tracks_lots ?? false),
                                    lleva_vencimiento:
                                      v === null ? false : (fichas[v.id]?.tracks_expiry ?? false),
                                  }
                                : x,
                            ),
                          )
                        }
                        buscar={buscarProducto}
                        placeholder="Busca el producto…"
                      />
                    )}
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
                    className="w-24"
                    aria-label={`Cantidad de la línea ${i + 1}`}
                  />
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

                {l.compuesto && (
                  <p role="alert" className="text-[0.85rem] text-warning-soft-foreground">
                    Este producto se arma con receta: lo que entra son sus ingredientes, no él.
                  </p>
                )}

                {/* A CIEGAS: la línea viene de un pedido y aquí no hay dinero que escribir. No
                    es que esté escondido —no se manda, y el servidor lo rechazaría—: quien
                    recibe cuenta bultos. */}
                {l.ordenLineaId !== null ? (
                  <p className="text-[0.85rem] text-muted-foreground">
                    Lo que costó lo pone el pedido.
                  </p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <FormField label="El costo que vas a poner es">
                      {(p) => (
                        <SimpleSelect
                          id={p.id}
                          value={l.por}
                          onValueChange={(v) =>
                            setLineas((prev) =>
                              prev.map((x) =>
                                x.id === l.id
                                  ? { ...x, por: v === "total" ? "total" : "unidad" }
                                  : x,
                              ),
                            )
                          }
                          options={[
                            { value: "unidad", label: "De cada uno (100 por bolsa)" },
                            {
                              value: "total",
                              label: "El total de la llegada (1.000 por 10 bolsas)",
                            },
                          ]}
                        />
                      )}
                    </FormField>
                    <FormField
                      label={l.por === "unidad" ? "¿Cuánto costó cada uno?" : "¿Cuánto costó todo?"}
                      required
                      hint="Escribe en bolívares o en dólares: el otro lo llena el sistema."
                    >
                      {() => (
                        <MoneyDualInput
                          id={`costo-${l.id}`}
                          fecha={fecha}
                          valor={{ amount: l.costo, currency: l.monedaCosto }}
                          onChange={(v) =>
                            setLineas((prev) =>
                              prev.map((x) =>
                                x.id === l.id
                                  ? { ...x, costo: v.amount, monedaCosto: v.currency }
                                  : x,
                              ),
                            )
                          }
                        />
                      )}
                    </FormField>
                  </div>
                )}

                {(l.lleva_paquete || l.lleva_vencimiento) && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {l.lleva_paquete && (
                      <FormField
                        label="Código del paquete"
                        required
                        hint="El que trae impreso la caja: con él se avisa antes de que se venza."
                      >
                        {(p) => (
                          <Input
                            {...p}
                            value={l.paquete}
                            onChange={(e) =>
                              setLineas((prev) =>
                                prev.map((x) =>
                                  x.id === l.id ? { ...x, paquete: e.target.value } : x,
                                ),
                              )
                            }
                          />
                        )}
                      </FormField>
                    )}
                    {l.lleva_vencimiento && (
                      <FormField label="Se vence el" required>
                        {(p) => (
                          <Input
                            {...p}
                            type="date"
                            value={l.vence}
                            onChange={(e) =>
                              setLineas((prev) =>
                                prev.map((x) =>
                                  x.id === l.id ? { ...x, vence: e.target.value } : x,
                                ),
                              )
                            }
                          />
                        )}
                      </FormField>
                    )}
                  </div>
                )}
              </div>
            ))}
            {pedido === null ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLineas((prev) => [...prev, lineaVacia()])}
              >
                <Plus /> Otro producto
              </Button>
            ) : (
              <p className="text-[0.85rem] text-muted-foreground">
                ¿Te trajo algo que no estaba en el pedido? Eso entra aparte, como una llegada sin
                pedido.
              </p>
            )}
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {pedido === null && (
              <FormField
                label="¿En qué moneda viene el documento?"
                hint="La de la factura del proveedor. El costo lo puedes escribir en cualquiera."
              >
                {(p) => (
                  <SimpleSelect
                    id={p.id}
                    value={moneda}
                    onValueChange={setMoneda}
                    options={[
                      { value: "VES", label: "Bolívares (Bs.)" },
                      { value: "USD", label: "Dólares (USD)" },
                    ]}
                  />
                )}
              </FormField>
            )}
            <FormField label="¿Qué día llegó?" hint="Hoy, o hasta dos días atrás.">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={fecha}
                  min={haceDias(2)}
                  max={hoyLocal()}
                  onChange={(e) => setFecha(e.target.value)}
                />
              )}
            </FormField>
          </div>

          {(impacto.data?.sales_since.length ?? 0) > 0 && (
            <p role="status" className="rounded-md bg-muted p-3 text-[0.88rem]">
              Entre el {fechaLocal(fecha)} y hoy vendiste{" "}
              {impacto.data!.sales_since.map((v) => `${v.quantity} de ${v.name}`).join(", ")}. Su
              costo ya quedó registrado y no cambia.
            </p>
          )}

          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={!listoQue || hayCompuesto || (origen === "proveedor" && proveedor === null)}
              onClick={avanzar}
            >
              Seguir
            </Button>
          </div>
        </div>
      )}

      {/* ── Paso 3: ¿tienes la factura? ─────────────────────────────────── */}
      {paso === "factura" && (
        <div className="space-y-3">
          <h2 className="text-lg font-medium">¿Tienes la factura?</h2>
          <div className="grid gap-3">
            {TARJETAS_FACTURA.filter((t) => t.valor === "pending" || puedeFacturar).map(
              ({ valor, titulo, detalle }) => (
                <Card
                  key={valor}
                  role="button"
                  tabIndex={0}
                  className="cursor-pointer p-4 hover:border-accent"
                  onClick={() => {
                    setEstadoFactura(valor);
                    if (valor === "pending") setPagada(null);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && setEstadoFactura(valor)}
                >
                  <p className="font-medium">{titulo}</p>
                  <p className="text-[0.85rem] text-muted-foreground">{detalle}</p>
                </Card>
              ),
            )}
          </div>

          {estadoFactura === "present" && (
            <div className="grid gap-2 sm:grid-cols-2">
              <FormField label="N° de la factura" hint="Como viene en el papel.">
                {(p) => (
                  <Input
                    {...p}
                    value={nroFactura}
                    onChange={(e) => setNroFactura(e.target.value)}
                  />
                )}
              </FormField>
              <FormField label="N° de control" hint="El que trae impreso.">
                {(p) => (
                  <Input
                    {...p}
                    value={nroControl}
                    onChange={(e) => setNroControl(e.target.value)}
                  />
                )}
              </FormField>
            </div>
          )}

          <div className="flex justify-end">
            <Button variant="primary" disabled={estadoFactura === null} onClick={avanzar}>
              Seguir
            </Button>
          </div>
        </div>
      )}

      {/* ── Paso 4: ¿ya la pagaste? ─────────────────────────────────────── */}
      {paso === "pago" && (
        <div className="space-y-3">
          <h2 className="text-lg font-medium">¿Ya la pagaste?</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Card
              role="button"
              tabIndex={0}
              className="cursor-pointer p-4 hover:border-accent"
              onClick={() => setPagada(true)}
              onKeyDown={(e) => e.key === "Enter" && setPagada(true)}
            >
              <p className="font-medium">Sí, ya la pagué</p>
              <p className="text-[0.85rem] text-muted-foreground">Sale de la cuenta que elijas.</p>
            </Card>
            <Card
              role="button"
              tabIndex={0}
              className="cursor-pointer p-4 hover:border-accent"
              onClick={() => {
                setPagada(false);
                avanzar();
              }}
              onKeyDown={(e) => e.key === "Enter" && setPagada(false)}
            >
              <p className="font-medium">No, quedo debiendo</p>
              <p className="text-[0.85rem] text-muted-foreground">Aparece en «Lo que debo».</p>
            </Card>
          </div>
          {pagada === true && (
            <FormField label="¿Con qué la pagaste?" required>
              {(p) => (
                <SimpleSelect
                  id={p.id}
                  value={forma}
                  onValueChange={setForma}
                  options={(formas.data?.methods ?? [])
                    .filter((f) => f.is_active)
                    .map((f) => ({ value: f.id, label: f.name }))}
                  placeholder={formas.isPending ? "Cargando…" : "Elige…"}
                />
              )}
            </FormField>
          )}
          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={pagada === null || (pagada && forma === null)}
              onClick={avanzar}
            >
              Seguir
            </Button>
          </div>
        </div>
      )}

      {/* ── Paso 5: ¿a qué depósito? ────────────────────────────────────── */}
      {paso === "deposito" && (
        <div className="space-y-3">
          <h2 className="text-lg font-medium">¿A qué depósito?</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {activos.map((d) => (
              <Card
                key={d.id}
                role="button"
                tabIndex={0}
                className={`cursor-pointer p-4 hover:border-accent ${
                  depositoElegido === d.id ? "border-accent" : ""
                }`}
                onClick={() => {
                  setDeposito(d.id);
                  avanzar();
                }}
                onKeyDown={(e) => e.key === "Enter" && setDeposito(d.id)}
              >
                <Package className="mb-2 size-5 text-accent" />
                <p className="font-medium">{d.name}</p>
                {d.is_default && <p className="text-[0.85rem] text-muted-foreground">Principal</p>}
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* ── Confirmación ────────────────────────────────────────────────── */}
      {paso === "confirmar" && (
        <div className="space-y-4">
          <h2 className="text-lg font-medium">¿Todo bien?</h2>
          <Card className="space-y-2 p-4">
            <p>
              Entran <strong>{lineasValidas.length}</strong>{" "}
              {lineasValidas.length === 1 ? "producto" : "productos"} a{" "}
              <strong>
                {activos.find((d) => d.id === depositoElegido)?.name ?? "el depósito"}
              </strong>
              .
            </p>
            {origen === "propia" && <p>Es mercancía tuya: no queda deuda con nadie.</p>}
            {origen === "proveedor" && (
              <>
                <p>
                  Se la compraste a <strong>{proveedor?.label}</strong>
                  {pedido === null ? "" : `, del pedido n.º ${pedido.order_number}`}.
                </p>
                {pedido !== null && <p>Lo que no haya llegado sigue esperando en «Por recibir».</p>}
                {estadoFactura === "present" && (
                  <p>Con su factura: entra al libro de compras y da crédito fiscal.</p>
                )}
                {estadoFactura === "pending" && (
                  <p>Sin la factura todavía: queda en «Falta la factura» hasta que llegue.</p>
                )}
                {estadoFactura === "none" && (
                  <p>Sin factura: no entra al libro de compras ni da crédito fiscal.</p>
                )}
                {pagada === true && <p>Ya está pagada.</p>}
                {pagada === false && <p>Queda debiendo: aparece en «Lo que debo».</p>}
              </>
            )}
            {fecha !== hoyLocal() && <p>Llegó el {fechaLocal(fecha)}.</p>}
          </Card>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={atras}>
              Atrás
            </Button>
            <Button
              variant="primary"
              disabled={registrar.isPending || depositoElegido === null}
              onClick={() => registrar.mutate(false)}
            >
              {registrar.isPending ? "Registrando…" : "Sí, registrar la llegada"}
            </Button>
          </div>
        </div>
      )}

      {sinSaldo !== null && (
        <ConfirmarSobregiro
          mensaje={sinSaldo}
          onCancelar={() => setSinSaldo(null)}
          onConfirmar={async () => {
            await registrar.mutateAsync(true);
            setSinSaldo(null);
          }}
        />
      )}
    </div>
  );
}
