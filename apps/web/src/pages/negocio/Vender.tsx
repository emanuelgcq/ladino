import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Banknote,
  ChevronLeft,
  CreditCard,
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
import { useModoDeVenta } from "../../app/modo-venta.js";
import { AvisoFacturacion } from "../../components/capa-fiscal/AvisoFacturacion.js";
import { FilasImpuesto } from "../../components/capa-fiscal/FilasImpuesto.js";
import {
  IgtfCobradoEnVenta,
  IncluyeIgtf,
  SUFIJO_CON_IGTF,
} from "../../components/capa-fiscal/Igtf.js";
import { errorDePersona } from "../../lib.js";
import { abrirPdf as abrirPdfApi } from "../../pdf.js";
import {
  cotizarPos,
  previsualizarCobro,
  type CotizacionPos,
  type FilaCobro,
  type SugerenciaCobro,
} from "../../pos.js";
import {
  aNube,
  crearSincronizador,
  escribirCuentasLocales,
  leerCuentasLocales,
  siguienteEtiqueta,
  type ClientePos,
  type CuentaAbierta,
  cantidadTexto,
  leerCantidad,
} from "../../pos-cuentas.js";
import { mostrarImporte, mostrarCantidad } from "../../money.js";
import { compararImportes } from "../../components/decimal-compare.js";
import { Button } from "../../ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "../../ui/dialog.js";
import { Input } from "../../ui/input.js";
import { SimpleSelect } from "../../ui/select.js";
import { useToast } from "../../ui/toast.js";
import { FormField, MoneyInput, importeValido } from "../../components/forms.js";
import { ETIQUETA_FORMA, FORMAS_BASE, MONEDA_FORMA } from "../../components/formas-de-pago.js";
import { formatearDocumento } from "./comunes.js";
import { BotonEscanear, type Lectura } from "../../components/EscanerCodigo.js";

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
 * CUANDO EL CARRITO SE QUEDA QUIETO (orden del dueño, 2026-09-10: subir en
 * cada toque convertía un carrito de diez renglones en diez viajes de red).
 * La nube también recibe de golpe al cambiar de ficha, al cobrar y al salir.
 * Una cuenta solo se cierra al COBRARSE — el servidor borra su fila en la
 * transacción de la venta — o descartándola a propósito con confirmación.
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
  /** El impuesto a las transacciones que cobró esta venta, si algún pago lo causó. */
  igtf: { functional_amount: string; currency: string } | null;
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

/**
 * La caja se REMONTA al cambiar de empresa: las cuentas abiertas nacen del
 * disco de LA empresa activa, y sin esta llave las de la empresa A seguían en
 * pantalla, se escribían en el disco de B y se subían a la nube bajo B
 * (auditoría 2026-09-11, regla 5 de CLAUDE.md).
 */
export function Vender(): React.JSX.Element {
  const { empresa } = useSesion();
  return <VenderDeEmpresa key={empresa.id} />;
}

function VenderDeEmpresa(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [busqueda, setBusqueda] = useState("");
  const buscarRef = useRef<HTMLInputElement>(null);

  // ── Las CUENTAS ABIERTAS: varias a la vez, cada una con su cliente ────────
  // Nacen del disco de la caja (síncrono: lo que el apagón no se llevó) y se
  // completan con la nube al montar. Cada toque escribe el disco EN EL ACTO;
  // la nube espera a que el carrito se quede quieto — ver pos-cuentas.ts.
  const [cuentas, setCuentas] = useState<CuentaAbierta[]>(() => {
    const locales = leerCuentasLocales(empresa.id);
    return locales.length > 0 ? locales : [cuentaNueva([])];
  });
  const [activaId, setActivaId] = useState<string>("");
  const activa = cuentas.find((c) => c.id === activaId) ?? cuentas[0]!;
  // LAS CUENTAS MÁS RECIENTES, sin esperar al render: dos escaneos seguidos
  // resuelven en la misma tanda, y el segundo `tocar` partía de las cuentas
  // del render — sin la línea del primero — y la pisaba (revisión 2026-09-14).
  const cuentasRef = useRef(cuentas);
  cuentasRef.current = cuentas;
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

  // Al salir de Vender, lo pendiente sube: nadie se lleva un carrito a medias
  // por cerrar la pestaña. (El disco local ya lo tenía; esto es para que la
  // OTRA caja lo vea.)
  useEffect(() => () => sincronizador.vaciar(), [sincronizador]);

  /** TODA mutación de cuentas pasa por aquí: estado + disco síncrono + nube. */
  function tocar(id: string, cambio: (c: CuentaAbierta) => CuentaAbierta): void {
    const siguientes = cuentasRef.current.map((c) => (c.id === id ? cambio(c) : c));
    cuentasRef.current = siguientes;
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
  // TELÉFONO: la cuenta se abre a pantalla entera desde la barra de abajo.
  const [cuentaMovil, setCuentaMovil] = useState(false);
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
  // Modo recibos (migración 54, definición única): el POS es el MISMO; cambia el documento.
  const { modo: modoDeVenta } = useModoDeVenta();
  const modoRecibos = modoDeVenta === "recibos";

  const depositos = useQuery({
    queryKey: ["depositos", empresa.id],
    staleTime: 5 * 60_000,
    queryFn: () => llamar<{ id: string; name: string }[]>("/v1/warehouses"),
  });

  const deposito = ajustes.data?.default_warehouse_id ?? depositos.data?.[0]?.id ?? null;

  // La cotización de la cuenta ACTIVA (solo ella: N fichas, UNA cotización),
  // SIEMPRE del servidor, con debounce — y sin debounce al cambiar de ficha.
  const lineas = useMemo(
    () => activa.lineas.map((l) => ({ product_id: l.product_id, quantity: cantidadTexto(l.qty) })),
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

  /** Anota uno. Devuelve el motivo si no se pudo (null = anotado). */
  function agregar(p: ProductoFila, avisar = true): string | null {
    const negar = (titulo: string, detalle: string): string => {
      if (avisar) toast.warning(titulo, detalle);
      return titulo;
    };
    if (!p.price_amount) {
      return negar(
        `${p.name}: no tiene precio`,
        "Se le pone en Administración → Productos antes de venderlo.",
      );
    }
    // LA EXISTENCIA MANDA (orden del dueño, 2026-09-08): no se anota más de lo
    // que hay. Solo bienes — un servicio no tiene existencia. El número lo
    // dijo el servidor con el producto; el control de verdad sigue siendo el
    // inventario del servidor al emitir.
    const existencia = p.kind === "good" ? (p.stock_quantity ?? "0") : null;
    if (existencia !== null && compararImportes(existencia, "0") <= 0) {
      return negar(
        `${p.name}: sin existencia`,
        "Registra la entrada de mercancía antes de venderlo.",
      );
    }
    const actual = cuentasRef.current.find((c) => c.id === activa.id) ?? activa;
    const ya = actual.lineas.find((l) => l.product_id === p.id);
    if (
      existencia !== null &&
      ya !== undefined &&
      compararImportes(String(ya.qty + 1), existencia) > 0
    ) {
      return negar(
        `${p.name}: solo quedan ${mostrarCantidad(existencia)}`,
        "No se puede anotar más de lo que hay en el depósito.",
      );
    }
    tocar(activa.id, (c) => {
      const linea = c.lineas.find((l) => l.product_id === p.id);
      return {
        ...c,
        lineas: linea
          ? c.lineas.map((l) => (l.product_id === p.id ? { ...l, qty: l.qty + 1, existencia } : l))
          : [...c.lineas, { product_id: p.id, qty: 1, nombre: p.name, existencia }],
      };
    });
    return null;
  }

  function cambiarQty(productId: string, delta: number): void {
    // El «+» respeta el mismo tope que agregar: la existencia anotada con la
    // línea (o la del producto si está a la vista en la cuadrícula).
    if (delta > 0) {
      const linea = activa.lineas.find((l) => l.product_id === productId);
      const enGrid = productos.data?.items.find((p) => p.id === productId);
      const tope =
        linea?.existencia ?? (enGrid?.kind === "good" ? (enGrid.stock_quantity ?? null) : null);
      if (
        linea !== undefined &&
        tope !== null &&
        tope !== undefined &&
        compararImportes(cantidadTexto(linea.qty + delta), tope) > 0
      ) {
        toast.warning(
          `Solo quedan ${mostrarCantidad(tope)}`,
          "No se puede anotar más de lo que hay en el depósito.",
        );
        return;
      }
    }
    tocar(activa.id, (c) => ({
      ...c,
      lineas: c.lineas
        .map((l) =>
          l.product_id === productId
            ? { ...l, qty: leerCantidad(cantidadTexto(l.qty + delta)) ?? 0 }
            : l,
        )
        .filter((l) => l.qty > 0),
    }));
  }

  /**
   * FIJAR LA CANTIDAD TECLEADA (A13): medio kilo de queso es «0,5». Mismo tope de
   * existencia que el «+»; cero la quita. El total lo calcula el servidor.
   */
  function fijarQty(productId: string, texto: string): boolean {
    const nueva = leerCantidad(texto);
    if (nueva === null) {
      toast.warning("Cantidad no válida", "Escribe un número, por ejemplo 2 o 0,5.");
      return false;
    }
    const linea = activa.lineas.find((l) => l.product_id === productId);
    const tope = linea?.existencia ?? null;
    if (
      nueva > 0 &&
      tope !== null &&
      tope !== undefined &&
      compararImportes(cantidadTexto(nueva), tope) > 0
    ) {
      toast.warning(
        `Solo quedan ${mostrarCantidad(tope)}`,
        "No se puede anotar más de lo que hay en el depósito.",
      );
      return false;
    }
    tocar(activa.id, (c) => ({
      ...c,
      lineas: c.lineas
        .map((l) => (l.product_id === productId ? { ...l, qty: nueva } : l))
        .filter((l) => l.qty > 0),
    }));
    return true;
  }

  // EL GESTO DEL LECTOR (Enter en la búsqueda, o la cámara). Se busca el
  // código en el SERVIDOR en ese momento: el lector de mostrador teclea y pulsa
  // Enter en milisegundos, antes de que la lista con debounce se refresque, y
  // tomar el primero de la lista vieja anotaba un producto EQUIVOCADO
  // (corregido 2026-09-14). Orden: código de barras exacto, código interno exacto, único
  // resultado. Si hay varios, se muestran para elegir; nunca se adivina.
  //
  // Los códigos se atienden EN COLA, en el orden en que llegaron: el lector de
  // mostrador puede pasar el segundo antes de que responda el primero.
  const agregarRef = useRef(agregar);
  agregarRef.current = agregar;
  const colaCodigos = useRef<Promise<unknown>>(Promise.resolve());
  /** En cola. `avisar`: con toasts (Enter); sin ellos, el lector muestra la Lectura. */
  function encolarCodigo(texto: string, avisar = true): Promise<Lectura> {
    const turno = colaCodigos.current.then(() => agregarPorCodigo(texto, avisar));
    colaCodigos.current = turno.catch(() => undefined);
    return turno;
  }
  async function agregarPorCodigo(texto: string, avisar: boolean): Promise<Lectura> {
    const codigo = texto.trim();
    if (codigo === "") return { ok: false, texto: "Código vacío" };
    let encontrados: ProductoFila[];
    try {
      const r = await qc.fetchQuery({
        queryKey: ["pos-productos", empresa.id, codigo],
        queryFn: () =>
          llamar<{ items: ProductoFila[] }>(
            `/v1/products?only_active=1&with_price=1&with_stock=1&per_page=60&search=${encodeURIComponent(codigo)}`,
          ),
        staleTime: 5_000,
      });
      encontrados = r.items;
    } catch (e) {
      if (avisar) toast.error("No se pudo buscar el código", errorDePersona(e));
      return { ok: false, texto: `No se pudo buscar ${codigo}: ${errorDePersona(e)}` };
    }
    const igual = (a: string | null) => a !== null && a.toLowerCase() === codigo.toLowerCase();
    const elegido =
      encontrados.find((p) => igual(p.barcode)) ??
      encontrados.find((p) => igual(p.sku)) ??
      (encontrados.length === 1 ? encontrados[0] : undefined);
    if (elegido !== undefined) {
      const motivo = agregarRef.current(elegido, avisar);
      if (motivo !== null) return { ok: false, texto: motivo };
      const linea = cuentasRef.current
        .find((c) => c.id === activa.id)
        ?.lineas.find((l) => l.product_id === elegido.id);
      return { ok: true, texto: `${elegido.name} · ${linea?.qty ?? 1} en la cuenta` };
    }
    // Se deja el texto a la vista para elegir — salvo que ya se esté
    // tecleando otra cosa.
    setBusqueda((actual) => (actual === "" ? codigo : actual));
    if (encontrados.length === 0) {
      if (avisar) {
        toast.warning(
          `No hay un producto con el código ${codigo}`,
          "Revisa el código o búscalo por nombre.",
        );
      }
      return { ok: false, texto: `No hay un producto con el código ${codigo}` };
    }
    if (avisar) toast.info("Hay varios productos con ese texto", "Toca el que corresponde.");
    return { ok: false, texto: `Varios productos con «${codigo}»: elígelo en la lista` };
  }

  // A12: en modo recibos la venta al contado no pide cliente — SOLO si el dueño
  // permite vender sin identificar. El servidor exige cliente en TODOS los modos
  // cuando el ajuste está apagado, y antes la caja lo daba por resuelto y el cobro
  // terminaba en 422.
  const permiteSinIdentificar = ajustes.data?.allow_unidentified_sales ?? true;
  const clienteResuelto =
    (modoRecibos && permiteSinIdentificar) || activa.cliente !== null || activa.sinIdentificar;

  // En modo recibos no hay cédula que pedir primero: el foco va a la búsqueda.
  useEffect(() => {
    if (modoRecibos) buscarRef.current?.focus();
  }, [modoRecibos]);

  // F2 abre Cobrar bajo las MISMAS condiciones que el botón: líneas,
  // cotización lista (no en vuelo), depósito y cliente resuelto. Antes el
  // atajo saltaba las tres últimas (auditoría 2026-09-11).
  const puedeCobrar =
    activa.lineas.length > 0 &&
    cotizacion.data !== undefined &&
    !cotizacion.isFetching &&
    deposito !== null &&
    clienteResuelto;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2" && puedeCobrar) {
        e.preventDefault();
        setCobrando(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [puedeCobrar]);

  const items = productos.data?.items ?? [];

  return (
    <div className="space-y-2">
      {modoRecibos && <AvisoFacturacion />}
      {/*
        Altura FIJA, no mínima: con `min-h` la cuadrícula crecía con el catálogo
        —300 productos daban una página de 3.870 px— y el carrito se estiraba con
        ella, así que «Cobrar» quedaba en el fondo del documento y había que
        bajar toda la lista para cobrar. La caja ocupa la pantalla y cada columna
        se desplaza por dentro.
      */}
      <div className="flex h-[calc(100dvh-9.5rem)] gap-4 lg:h-[calc(100vh-8rem)]">
        {/* ── La cuadrícula ──────────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="relative flex shrink-0 gap-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint-foreground" />
            <Input
              ref={buscarRef}
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  // Se captura y se vacía YA: el siguiente escaneo empieza limpio.
                  const codigo = busqueda;
                  setBusqueda("");
                  void encolarCodigo(codigo);
                }
              }}
              placeholder="Busca o pasa el lector de código de barras…"
              className="h-11 pl-9 text-[1rem]"
              aria-label="Buscar productos para vender"
            />
            <BotonEscanear
              className="h-11 w-11 sm:h-11 sm:w-11"
              titulo="Agregar con la cámara"
              focoAlCerrar={buscarRef}
              continuo
              onCodigo={(c) => encolarCodigo(c, false)}
            />
          </div>
          {productos.isLoading ? (
            <p className="text-muted-foreground">Cargando…</p>
          ) : items.length === 0 ? (
            <p className="py-12 text-center text-muted-foreground">
              {q === "" ? "No hay productos activos para vender." : "Nada con ese nombre o código."}
            </p>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto pb-20 pr-1 lg:pb-0">
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
                {items.map((p) => (
                  <TarjetaPos key={p.id} producto={p} onAgregar={() => agregar(p)} />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── El carrito ─────────────────────────────────────────────────── */}
        <aside
          className={`${
            cuentaMovil ? "fixed inset-0 z-40 flex" : "hidden"
          } flex-col bg-surface lg:static lg:z-auto lg:flex lg:w-96 lg:shrink-0 lg:rounded-lg lg:border lg:border-border`}
          aria-label="Cuenta"
        >
          <div className="flex items-center gap-2 border-b border-border px-2 py-2 lg:hidden">
            <Button variant="ghost" className="h-10" onClick={() => setCuentaMovil(false)}>
              <ChevronLeft /> Productos
            </Button>
            <span className="ml-auto pr-2 text-[0.95rem] font-semibold">Cuenta</span>
          </div>
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
                    onClick={() => {
                      // Cambiar de ficha SUBE la anterior: si la cajera se
                      // va a otra cuenta, la que deja ya esta terminada.
                      sincronizador.vaciar();
                      setActivaId(c.id);
                    }}
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
                    // En teléfonos angostos (< 380 px) la línea va en dos filas: el nombre
                    // entero arriba, cantidad y total abajo — en una sola fila
                    // el nombre quedaba en tres letras y los botones apretados.
                    <li
                      key={l.product_id}
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2.5 min-[380px]:flex-nowrap"
                    >
                      <div className="min-w-0 basis-full min-[380px]:basis-auto min-[380px]:flex-1">
                        <p className="line-clamp-2 break-words text-[0.92rem] font-medium min-[380px]:line-clamp-1">
                          {/* La restaurada de la nube trae solo la intención:
                              el nombre lo pone la cotización al llegar. */}
                          {l.nombre !== "" ? l.nombre : (cot?.description ?? "…")}
                        </p>
                        <p className="text-[0.8rem] text-muted-foreground tabular-nums">
                          {/* DUAL siempre: el ancla (USD) del servidor y el Bs que
                              congelará el documento. */}
                          {cot
                            ? `${
                                cot.precio_usd !== null
                                  ? `${mostrarImporte({ amount: cot.precio_usd, currency: cotizacion.data!.anchor_currency })} · `
                                  : ""
                              }${mostrarImporte({ amount: cot.precio_bs, currency: cotizacion.data!.functional_currency })} c/u`
                            : "…"}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 max-[379px]:mr-auto">
                        <Button
                          variant="ghost"
                          size="iconSm"
                          className="max-sm:size-9"
                          aria-label={`Quitar uno de ${l.nombre !== "" ? l.nombre : "este producto"}`}
                          onClick={() => cambiarQty(l.product_id, -1)}
                        >
                          {l.qty <= 1 ? <Trash2 /> : <Minus />}
                        </Button>
                        <CantidadEditable
                          cantidad={l.qty}
                          nombre={l.nombre !== "" ? l.nombre : "este producto"}
                          onFijar={(t) => fijarQty(l.product_id, t)}
                        />
                        <Button
                          variant="ghost"
                          size="iconSm"
                          className="max-sm:size-9"
                          aria-label={`Agregar uno de ${l.nombre !== "" ? l.nombre : "este producto"}`}
                          onClick={() => cambiarQty(l.product_id, 1)}
                        >
                          <Plus />
                        </Button>
                      </div>
                      <span className="w-24 text-right tabular-nums">
                        <span className="block text-[0.92rem] font-medium">
                          {cot
                            ? mostrarImporte({
                                amount: cot.total_bs,
                                currency: cotizacion.data!.functional_currency,
                              })
                            : "…"}
                        </span>
                        {cot?.total_usd != null && (
                          <span className="block text-[0.75rem] text-muted-foreground">
                            {mostrarImporte({
                              amount: cot.total_usd,
                              currency: cotizacion.data!.anchor_currency,
                            })}
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="space-y-2 border-t border-border p-3">
            {/* Si el servidor no puede cotizar (sin regla de impuesto, sin tasa, un
                producto sin precio), se DICE: antes las líneas quedaban en «…»
                y Cobrar se apagaba sin explicación (auditoría 2026-09-11). */}
            {cotizacion.isError && activa.lineas.length > 0 && (
              <p
                role="alert"
                className="rounded-md bg-destructive-soft px-3 py-2 text-[0.85rem] text-destructive-soft-foreground"
              >
                No se pudo calcular la cuenta: {errorDePersona(cotizacion.error)}
              </p>
            )}
            {cotizacion.data && activa.lineas.length > 0 && (
              <>
                {/* En modo recibos no existe el impuesto: el total ES el precio (A4). */}
                {!modoRecibos && (
                  <FilasImpuesto
                    subtotal={cotizacion.data.subtotal_bs}
                    impuesto={cotizacion.data.impuesto_bs}
                    moneda={cotizacion.data.functional_currency}
                  />
                )}
                <div className="flex items-baseline justify-between">
                  <span className="text-[1rem] font-semibold">Total</span>
                  <span className="text-xl font-semibold tabular-nums">
                    {mostrarImporte({
                      amount: cotizacion.data.functional_total,
                      currency: cotizacion.data.functional_currency,
                    })}
                  </span>
                </div>
                {/* El ancla en USD SIEMPRE, también con la lista en Bs (orden del
                    dueño, 2026-09-13): la factura habla en Bs, el carrito en las dos. */}
                {cotizacion.data.anchor_total !== null &&
                cotizacion.data.anchor_currency !== cotizacion.data.functional_currency ? (
                  <p className="text-right text-[0.82rem] text-muted-foreground tabular-nums">
                    ={" "}
                    {mostrarImporte({
                      amount: cotizacion.data.anchor_total,
                      currency: cotizacion.data.anchor_currency,
                    })}{" "}
                    a la tasa de hoy (
                    {mostrarCantidad(cotizacion.data.anchor_rate ?? cotizacion.data.tasa)})
                  </p>
                ) : cotizacion.data.anchor_total === null ? (
                  <p className="text-right text-[0.82rem] text-muted-foreground">
                    Sin tasa del día: no hay equivalente en {cotizacion.data.anchor_currency}.
                  </p>
                ) : null}
              </>
            )}
            <Button
              variant="primary"
              size="lg"
              className="h-12 w-full text-[1.05rem]"
              disabled={
                activa.lineas.length === 0 ||
                !cotizacion.data ||
                // Mientras se recotiza, el total en pantalla es el ANTERIOR
                // (placeholder): cobrar con él prellenaba el importe viejo y,
                // con cliente, fiaba la diferencia sin querer.
                cotizacion.isFetching ||
                deposito === null ||
                !clienteResuelto
              }
              onClick={() => setCobrando(true)}
            >
              {cotizacion.isFetching && activa.lineas.length > 0
                ? "Calculando…"
                : `Cobrar ${activa.lineas.length > 0 && clienteResuelto ? "· F2" : ""}`}
            </Button>
            {activa.lineas.length > 0 && !clienteResuelto && (
              <p className="text-center text-[0.8rem] text-warning-soft-foreground">
                Primero di quién compra: la cédula arriba, o «Venta sin identificar».
              </p>
            )}
            {deposito === null && (
              <p className="text-center text-[0.8rem] text-warning-soft-foreground">
                Falta un depósito para descontar la mercancía: lo configura quien administra el
                negocio (Empezar o Configuración).
              </p>
            )}
          </div>
        </aside>

        {/* TELÉFONO: la cuenta a un toque, con lo que lleva y el total. */}
        {!cuentaMovil && (
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-glass-border bg-glass p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur-xl lg:hidden">
            <Button
              variant={activa.lineas.length > 0 ? "primary" : "secondary"}
              size="lg"
              className="h-12 w-full justify-between text-[1rem]"
              onClick={() => setCuentaMovil(true)}
            >
              <span>
                {activa.lineas.length === 0
                  ? "Cuenta vacía"
                  : `Ver cuenta · ${String(activa.lineas.reduce((n, l) => n + l.qty, 0))} ${
                      activa.lineas.reduce((n, l) => n + l.qty, 0) === 1 ? "producto" : "productos"
                    }`}
              </span>
              {activa.lineas.length > 0 && cotizacion.data && (
                <span className="tabular-nums">
                  {mostrarImporte({
                    amount: cotizacion.data.functional_total,
                    currency: cotizacion.data.functional_currency,
                  })}
                </span>
              )}
            </Button>
          </div>
        )}

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
              setCuentaMovil(false);
              setVenta(v);
              setDeudor(activa.cliente?.legal_name ?? null);
              // La cuenta cobrada MUERE: el servidor la borró en la MISMA
              // transacción de la venta (cart_id); aquí solo cae la ficha.
              quitarCuenta(activa.id, false);
              // «Me deben» de Inicio y Mi dinero se refresca al instante: la
              // venta fiada es deuda desde ya. Y lo que la venta MOVIÓ también:
              // «Quedan N» del mostrador, existencias y cuentas de dinero
              // (antes quedaban viejos 30 s — auditoría 2026-09-11).
              void qc.invalidateQueries({ queryKey: ["negocio-resumen", empresa.id] });
              void qc.invalidateQueries({ queryKey: ["pos-productos", empresa.id] });
              void qc.invalidateQueries({ queryKey: ["inv-productos", empresa.id] });
              void qc.invalidateQueries({ queryKey: ["cuentas", empresa.id] });
              void qc.invalidateQueries({ queryKey: ["negocio-clientes", empresa.id] });
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
          className="h-24 w-full object-cover sm:aspect-square sm:h-auto"
        />
      ) : (
        <div
          className="flex h-24 w-full items-center justify-center bg-accent-soft text-3xl font-semibold text-accent-soft-foreground sm:aspect-square sm:h-auto"
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
        {/* La existencia, dicha en la tarjeta (orden del dueño): la cajera ve
            cuántos quedan sin salir de la cuadrícula. Solo bienes. */}
        {producto.kind === "good" && producto.stock_quantity != null && (
          <p
            className={`text-[0.78rem] tabular-nums ${
              sinExistencia ? "text-warning-soft-foreground" : "text-faint-foreground"
            }`}
          >
            {sinExistencia ? "Agotado" : `Quedan ${mostrarCantidad(producto.stock_quantity)}`}
          </p>
        )}
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

// ETIQUETA_FORMA, MONEDA_FORMA y FORMAS_BASE viven en components/formas-de-pago.ts:
// las comparte el diálogo de cobro de documentos, con la misma regla.

interface PagoElegido {
  /** Clave estable de la fila: con el índice, quitar la primera forma le
      heredaba estado y consultas a la segunda (auditoría 2026-09-11). */
  id: string;
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
  // La llave de idempotencia de la venta es el id de la CUENTA que cierra:
  // cerrar y reabrir «Cobrar» tras una respuesta perdida reintenta con la
  // MISMA llave (auditoría 2026-09-11).

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

  // ── La vista previa del SERVIDOR (ADR-0059): cuánto abona cada forma, su
  // impuesto a las transacciones, el vuelto, lo que falta y cuánto pedir en cada forma.
  // Es el MISMO cálculo que hará la venta; la pantalla no suma dinero.
  const limpio = (v: string): string => v.trim().replace(",", ".");
  const conMonto = pagos
    .map((p, i) => ({ p, i, monto: limpio(p.amount) }))
    .filter((x) => importeValido(x.monto) && compararImportes(x.monto, "0") > 0);
  const pedido = JSON.stringify(
    conMonto.map((x) => ({ instrument: x.p.instrument, currency: x.p.currency, amount: x.monto })),
  );
  const pedidoEstable = useDebounced(pedido, 250);
  const ofertas = useMemo(() => {
    const vistos = new Set<string>();
    const lista: { instrument: string; currency: string }[] = [];
    for (const b of botones) {
      const k = `${b.instrument}|${b.currency}`;
      if (!vistos.has(k)) {
        vistos.add(k);
        lista.push({ instrument: b.instrument, currency: b.currency });
      }
    }
    return lista;
  }, [botones]);
  const previa = useQuery({
    queryKey: ["pos-cobro", empresa.id, cotizacion.functional_total, pedidoEstable, ofertas],
    enabled: ofertas.length > 0,
    placeholderData: (anterior) => anterior,
    queryFn: () =>
      previsualizarCobro(llamar, {
        company_id: empresa.id,
        total: cotizacion.functional_total,
        payments: JSON.parse(pedidoEstable) as {
          instrument: string;
          currency: string;
          amount: string;
        }[],
        offer: ofertas,
      }),
  });
  const estado = previa.data;
  // La vista previa CORRESPONDE a lo que hay en pantalla: sin esto, un Enter
  // rápido cobraba con los números de la tecla anterior.
  const alDia = estado !== undefined && pedidoEstable === pedido && !previa.isFetching;
  const filaDe = (i: number): FilaCobro | null => {
    const pos = conMonto.findIndex((x) => x.i === i);
    return pos < 0 || estado === undefined ? null : (estado.filas[pos] ?? null);
  };
  const hayError = estado?.filas.some((f) => f.error !== null) ?? false;
  const completo = estado?.completo === true;
  const todosConMonto = pagos.length > 0 && conMonto.length === pagos.length;
  const listo = alDia && todosConMonto && !hayError && completo;
  const puedeFiar =
    clienteNombre !== null &&
    alDia &&
    !hayError &&
    !completo &&
    lineas.length > 0 &&
    conMonto.length === pagos.length;
  const funcional = cotizacion.functional_currency;

  const sugerenciaDe = (instrument: string, currency: string): SugerenciaCobro | null =>
    estado?.sugerencias.find((s) => s.instrument === instrument && s.currency === currency) ?? null;
  const sinCeros = (v: string): string => v.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

  function elegirForma(b: (typeof botones)[number]): void {
    if (pagos.length >= 4) {
      toast.warning("Máximo cuatro formas de pago", "Quita una para agregar otra.");
      return;
    }
    const indice = pagos.length;
    const sugerida = sugerenciaDe(b.instrument, b.currency)?.monto ?? null;
    setPagos((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        instrument: b.instrument,
        currency: b.currency,
        amount: sugerida === null ? "" : sinCeros(sugerida),
        ...(b.account_id === undefined ? {} : { account_id: b.account_id }),
      },
    ]);
    // El foco cae en el monto recién puesto: con lo que falta prellenado, el
    // siguiente Enter ya cobra — el flujo de teclado completo sin ratón.
    requestAnimationFrame(() => document.getElementById(`pos-pago-${indice}`)?.focus());
  }

  const vender = useMutation({
    mutationFn: () =>
      llamar<Venta>("/v1/pos/sales", {
        method: "POST",
        headers: { "Idempotency-Key": cartId },
        body: JSON.stringify({
          company_id: empresa.id,
          warehouse_id: deposito,
          cart_id: cartId,
          ...(clienteId === null ? {} : { customer_id: clienteId }),
          lines: lineas,
          payments: pagos.map((p) => ({
            instrument: p.instrument,
            currency: p.currency,
            amount: limpio(p.amount),
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

  if (fiando) {
    return (
      <Dialog open onOpenChange={(v) => !v && setFiando(false)}>
        <DialogContent className="max-w-md">
          <DialogTitle>Fiar esta venta</DialogTitle>
          <div className="space-y-4 pt-1">
            <p className="text-[0.95rem]">
              Se registra la venta por{" "}
              <span className="font-semibold tabular-nums">
                {mostrarImporte({ amount: cotizacion.functional_total, currency: funcional })}
              </span>{" "}
              y <span className="font-semibold">{clienteNombre}</span> queda debiendo{" "}
              <span className="font-semibold tabular-nums">
                {mostrarImporte({
                  amount: estado?.falta ?? cotizacion.functional_total,
                  currency: funcional,
                })}
              </span>
              {pagos.length === 0 ? "" : " (lo recibido se abona ahora)"}. Lo cobras después desde
              Clientes o Mi dinero.
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
      <DialogContent className="flex max-h-[92vh] max-w-lg flex-col gap-0 p-0">
        <div className="border-b border-border px-5 py-3">
          <DialogTitle>Cobrar</DialogTitle>
        </div>
        <div
          className="flex-1 space-y-4 overflow-y-auto px-5 py-4"
          onKeyDown={(e) => {
            // Enter fuera de un botón = confirmar, si ya se puede.
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
          {/* EL RESUMEN DE CAJA: total, recibido y lo que falta o el vuelto. */}
          <div className="grid grid-cols-3 gap-1.5 rounded-lg bg-surface-muted p-2.5 text-center sm:gap-2 sm:p-3 [&_p]:min-w-0 [&_p]:break-words">
            <div>
              <p className="text-[0.78rem] text-muted-foreground">Total</p>
              <p className="text-[0.98rem] font-semibold min-[380px]:text-[1.15rem] tabular-nums">
                {mostrarImporte({ amount: cotizacion.functional_total, currency: funcional })}
              </p>
              {cotizacion.anchor_total !== null && cotizacion.anchor_currency !== funcional && (
                <p className="text-[0.78rem] text-muted-foreground tabular-nums">
                  {mostrarImporte({
                    amount: cotizacion.anchor_total,
                    currency: cotizacion.anchor_currency,
                  })}
                </p>
              )}
            </div>
            <div>
              <p className="text-[0.78rem] text-muted-foreground">Recibido</p>
              <p className="text-[0.98rem] font-semibold min-[380px]:text-[1.15rem] tabular-nums">
                {mostrarImporte({ amount: estado?.pagado ?? "0", currency: funcional })}
              </p>
            </div>
            <div>
              {estado?.vuelto ? (
                <>
                  <p className="text-[0.78rem] text-success-soft-foreground">Vuelto</p>
                  <p className="text-[0.98rem] font-semibold min-[380px]:text-[1.15rem] text-success-soft-foreground tabular-nums">
                    {mostrarImporte({
                      amount: estado.vuelto.amount,
                      currency: estado.vuelto.currency,
                    })}
                  </p>
                </>
              ) : completo ? (
                <>
                  <p className="text-[0.78rem] text-success-soft-foreground">Estado</p>
                  <p className="text-[0.98rem] font-semibold min-[380px]:text-[1.15rem] text-success-soft-foreground">
                    Completo
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[0.78rem] text-warning-soft-foreground">Falta</p>
                  <p className="text-[0.98rem] font-semibold min-[380px]:text-[1.15rem] text-warning-soft-foreground tabular-nums">
                    {mostrarImporte({
                      amount: estado?.falta ?? cotizacion.functional_total,
                      currency: funcional,
                    })}
                  </p>
                </>
              )}
            </div>
          </div>

          {previa.isError && (
            <p
              role="alert"
              className="rounded-md bg-destructive-soft px-3 py-2 text-[0.85rem] text-destructive-soft-foreground"
            >
              No se pudo calcular el cobro: {errorDePersona(previa.error)}
            </p>
          )}

          {pagos.map((p, i) => (
            <PagoFila
              key={p.id}
              indice={i}
              pago={p}
              fila={filaDe(i)}
              funcional={funcional}
              onCambiar={(amount) =>
                setPagos((prev) => prev.map((x, j) => (j === i ? { ...x, amount } : x)))
              }
              onReferencia={(reference) =>
                setPagos((prev) => prev.map((x, j) => (j === i ? { ...x, reference } : x)))
              }
              onQuitar={() => setPagos((prev) => prev.filter((_, j) => j !== i))}
            />
          ))}

          {!completo && pagos.length < 4 && (
            <div>
              <p className="pb-1.5 text-[0.88rem] font-medium">
                {pagos.length === 0 ? "¿Cómo te pagan?" : "Agregar otra forma de pago"}
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {botones.map((b) => {
                  const s = sugerenciaDe(b.instrument, b.currency);
                  return (
                    <Button
                      key={b.clave}
                      variant="secondary"
                      className="h-auto min-h-11 flex-col items-start gap-0 py-1.5"
                      onClick={() => elegirForma(b)}
                    >
                      <span className="flex items-center gap-1.5">
                        {b.instrument.startsWith("efectivo") ? <Banknote /> : <CreditCard />}
                        <span className="truncate">{b.etiqueta}</span>
                      </span>
                      {s?.monto != null && (
                        <span className="pl-6 text-[0.75rem] font-normal text-muted-foreground tabular-nums">
                          {mostrarImporte({ amount: s.monto, currency: b.currency })}
                          {s.igtf !== null ? SUFIJO_CON_IGTF : ""}
                        </span>
                      )}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-2 border-t border-border px-5 py-3">
          <Button
            variant="primary"
            size="lg"
            className="h-12 w-full text-[1.05rem]"
            disabled={!listo || vender.isPending}
            onClick={() => vender.mutate()}
          >
            {vender.isPending
              ? "Cobrando…"
              : completo || pagos.length === 0
                ? `Cobrar ${mostrarImporte({ amount: cotizacion.functional_total, currency: funcional })}`
                : `Falta ${mostrarImporte({ amount: estado?.falta ?? "0", currency: funcional })}`}
          </Button>
          {!completo && clienteNombre !== null && (
            <Button
              variant="secondary"
              className="w-full"
              disabled={!puedeFiar || vender.isPending}
              onClick={() => setFiando(true)}
            >
              {pagos.length === 0 ? "Fiar todo" : "Fiar lo que falta"}
            </Button>
          )}
          {!completo && clienteNombre === null && (
            <p className="text-center text-[0.78rem] text-muted-foreground">
              Sin cliente identificado la venta se cobra completa. Para fiar, identifica al cliente.
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
  fila,
  funcional,
  onCambiar,
  onReferencia,
  onQuitar,
}: {
  indice: number;
  pago: PagoElegido;
  /** Lo que el servidor calculó para esta forma; null mientras no hay monto. */
  fila: FilaCobro | null;
  funcional: string;
  onCambiar: (v: string) => void;
  onReferencia: (v: string) => void;
  onQuitar: () => void;
}): React.JSX.Element {
  const esEfectivo = pago.instrument.startsWith("efectivo");
  return (
    <div className="space-y-1.5 rounded-md border border-border p-2.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[0.9rem] font-medium">
          {esEfectivo ? <Banknote className="size-4" /> : <CreditCard className="size-4" />}
          {ETIQUETA_FORMA[pago.instrument] ?? pago.instrument}
        </span>
        <Button variant="ghost" size="iconSm" aria-label="Quitar esta forma" onClick={onQuitar}>
          <X />
        </Button>
      </div>
      <label className="block text-[0.78rem] text-muted-foreground" htmlFor={`pos-pago-${indice}`}>
        {esEfectivo ? "Lo que te entregan" : "Monto recibido"}
      </label>
      <MoneyInput
        id={`pos-pago-${indice}`}
        value={pago.amount}
        onChange={onCambiar}
        currency={pago.currency === "VES" ? "Bs." : pago.currency}
        ariaDescribedby={`pos-pago-${indice}-detalle`}
        ariaInvalid={fila?.error != null ? true : undefined}
      />
      {/* Todo lo que no es efectivo trae un comprobante. */}
      {!esEfectivo && (
        <Input
          aria-label="Referencia del pago"
          className="font-mono"
          placeholder="Referencia (opcional)"
          value={pago.reference ?? ""}
          onChange={(e) => onReferencia(e.target.value)}
        />
      )}
      <div id={`pos-pago-${indice}-detalle`} className="space-y-0.5 text-[0.84rem] tabular-nums">
        {fila?.error != null ? (
          <p role="alert" className="text-destructive-soft-foreground">
            {fila.error}
          </p>
        ) : fila !== null ? (
          <>
            <p className="text-muted-foreground">
              Abona a la venta{" "}
              {mostrarImporte({ amount: fila.abonoFuncional ?? "0", currency: funcional })}
            </p>
            {fila.igtf !== null && (
              <IncluyeIgtf
                importe={mostrarImporte({ amount: fila.igtf, currency: pago.currency })}
              />
            )}
            {fila.vuelto !== null && (
              <p className="font-medium text-success-soft-foreground">
                Vuelto {mostrarImporte({ amount: fila.vuelto, currency: pago.currency })}
              </p>
            )}
          </>
        ) : null}
      </div>
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
  // Sin número asignado no se inventa un «00000000»: se dice.
  const numero =
    venta.document.document_number === null
      ? `${venta.document.series} (sin número)`
      : `${venta.document.series}-${String(venta.document.document_number).padStart(8, "0")}`;
  // FIADA la decide el ESTADO que puso el servidor, no el saldo de ocho
  // decimales: con la regla del último centavo (R-02) una factura pagada puede
  // guardar un residuo de 0,0000002 que nadie debe, y la pantalla decía
  // «queda debiendo Bs. 0,0000002» (QA de caja, 2026-09-13).
  const fiada = venta.document_status !== "paid";

  function abrirPdf(): void {
    void abrirPdfApi(`/v1/documents/${venta.document.id}/pdf`, empresa.id, (m) =>
      toast.error("No se pudo abrir el PDF", m),
    );
  }

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
          {venta.igtf !== null && (
            <IgtfCobradoEnVenta
              importe={mostrarImporte({
                amount: venta.igtf.functional_amount,
                currency: venta.igtf.currency,
              })}
            />
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
          <Button variant="secondary" className="w-full" onClick={() => void abrirPdf()}>
            <Printer /> Imprimir
          </Button>
          <Button variant="primary" size="lg" className="h-12 w-full" onClick={onNueva} autoFocus>
            Nueva venta
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * La cantidad de una línea, editable a mano (A13): se teclea «0,5» o «2» y se
 * fija al salir del campo o con Enter; Escape la deja como estaba.
 */
function CantidadEditable({
  cantidad,
  nombre,
  onFijar,
}: {
  cantidad: number;
  nombre: string;
  onFijar: (texto: string) => boolean;
}): React.JSX.Element {
  const [texto, setTexto] = useState(() => cantidadTexto(cantidad).replace(".", ","));
  useEffect(() => setTexto(cantidadTexto(cantidad).replace(".", ",")), [cantidad]);
  const fijar = () => {
    if (texto.replace(",", ".") === cantidadTexto(cantidad)) return;
    if (!onFijar(texto)) setTexto(cantidadTexto(cantidad).replace(".", ","));
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={`Cantidad de ${nombre}`}
      className="h-8 w-14 rounded-sm border border-transparent bg-transparent text-center text-[0.95rem] font-medium tabular-nums hover:border-border focus:border-border-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:h-9"
      value={texto}
      onChange={(e) => setTexto(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={fijar}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setTexto(cantidadTexto(cantidad).replace(".", ","));
        }
      }}
    />
  );
}
