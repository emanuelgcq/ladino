import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import {
  Camera,
  ChevronDown,
  ChevronRight,
  LayoutGrid,
  Package,
  Rows3,
  Search,
} from "lucide-react";
import { useSesion } from "../../app/session.js";
import { errorDePersona } from "../../lib.js";
import { mostrarImporte, mostrarCantidad } from "../../money.js";
import { esCero } from "../../components/decimal-compare.js";
import { Button } from "../../ui/button.js";
import { Card } from "../../ui/card.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../ui/dialog.js";
import { Input } from "../../ui/input.js";
import { Switch } from "../../ui/switch.js";
import { useToast } from "../../ui/toast.js";
import { FormField, MoneyInput, importeValido } from "../../components/forms.js";
import {
  ImportarArchivo,
  PLANTILLA_PRODUCTOS,
  NOTA_FORMATO_PRODUCTOS,
} from "../../components/importar.js";

/**
 * PRODUCTOS (Fase C, PARTE 7): lo que vendo, con foto. Cuadrícula visual por
 * defecto (la foto ES el diseño), alta simple en una pantalla — nombre y
 * precio bastan —, e importar el Excel que ya existe. El «≈ Bs.» del precio lo
 * calcula el SERVIDOR con la tasa del día: aquí no se multiplica dinero.
 */

interface ProductoFila {
  id: string;
  sku: string;
  name: string;
  kind: "good" | "service";
  status: string;
  barcode: string | null;
  image_path: string | null;
  image_url?: string | null;
  price_amount?: string | null;
  price_currency?: string | null;
  price_equivalent_amount?: string | null;
  price_equivalent_currency?: string | null;
  stock_quantity?: string | null;
}

const POR_PAGINA = 100;
const CLAVE_VISTA = "ladino.productos.vista";

function useDebounced<T>(valor: T, ms: number): T {
  const [v, setV] = useState(valor);
  useEffect(() => {
    const t = setTimeout(() => setV(valor), ms);
    return () => clearTimeout(t);
  }, [valor, ms]);
  return v;
}

export function ProductosNegocio(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const [busqueda, setBusqueda] = useState("");
  const [vista, setVista] = useState<"cuadricula" | "tabla">(() =>
    localStorage.getItem(CLAVE_VISTA) === "tabla" ? "tabla" : "cuadricula",
  );
  const [detalle, setDetalle] = useState<ProductoFila | null>(null);
  const q = useDebounced(busqueda.trim(), 250);

  useEffect(() => localStorage.setItem(CLAVE_VISTA, vista), [vista]);

  /**
   * PAGINADO DE VERDAD (2026-09-10). Antes pedía 100 y punto: con un catálogo
   * de 300 el mostrador veía 100 y **los otros 200 no existían**, sin aviso
   * ninguno — el `total` llegaba del servidor y se tiraba. Ahora se acumulan
   * páginas y la pantalla dice cuántos hay de cuántos.
   */
  const productos = useInfiniteQuery({
    queryKey: ["negocio-productos", empresa.id, q],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      llamar<{ items: ProductoFila[]; total: number }>(
        `/v1/products?with_price=1&with_stock=1&per_page=${POR_PAGINA}&page=${pageParam}` +
          (q === "" ? "" : `&search=${encodeURIComponent(q)}`),
      ),
    getNextPageParam: (ultima, todas) => {
      const cargados = todas.reduce((n, p) => n + p.items.length, 0);
      return cargados < ultima.total ? todas.length + 1 : undefined;
    },
  });

  const items = productos.data?.pages.flatMap((p) => p.items) ?? [];
  const total = productos.data?.pages[0]?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">Productos</h1>
        <div className="flex-1" />
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint-foreground" />
          <Input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar por nombre o código…"
            className="w-64 pl-8"
            aria-label="Buscar productos"
          />
        </div>
        <Button
          variant="ghost"
          size="iconSm"
          aria-label={vista === "cuadricula" ? "Ver como tabla" : "Ver como tarjetas"}
          onClick={() => setVista((v) => (v === "cuadricula" ? "tabla" : "cuadricula"))}
        >
          {vista === "cuadricula" ? <Rows3 /> : <LayoutGrid />}
        </Button>
        {/* ARRIBA SE CONSULTA (regla de los dos mundos, 2026-09-08): agregar,
            editar, importar, foto y código de barras viven en
            Administración → Productos. Aquí, solo mirar. */}
      </div>

      {productos.isLoading ? (
        <p className="text-muted-foreground">Cargando…</p>
      ) : items.length === 0 ? (
        <Card className="py-12 text-center">
          <Package className="mx-auto size-8 text-faint-foreground" />
          <p className="mt-2 font-medium">
            {q === "" ? "Todavía no tienes productos" : "Nada con ese nombre"}
          </p>
          <p className="mx-auto mt-1 max-w-sm text-[0.9rem] text-muted-foreground">
            {q === ""
              ? "Los productos se agregan e importan en Administración → Productos."
              : "Prueba con otra palabra."}
          </p>
        </Card>
      ) : vista === "cuadricula" ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {items.map((p) => (
            <TarjetaProducto key={p.id} producto={p} onAbrir={() => setDetalle(p)} />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-surface">
          <table className="w-full text-[0.9rem]">
            <thead>
              <tr className="border-b border-border text-left text-[0.8rem] uppercase tracking-wide text-faint-foreground">
                <th className="px-3 py-2">Código</th>
                <th className="px-3 py-2">Nombre</th>
                <th className="px-3 py-2 text-right">Precio</th>
                <th className="px-3 py-2 text-right">Existencia</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr
                  key={p.id}
                  className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-muted"
                  onClick={() => setDetalle(p)}
                >
                  <td className="px-3 py-2 font-mono text-[0.82rem] text-muted-foreground">
                    {p.sku}
                  </td>
                  <td className="px-3 py-2">{p.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <Precio producto={p} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <Existencia producto={p} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {items.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
          <span className="text-[0.86rem] text-muted-foreground">
            Mostrando {items.length} de {total}
          </span>
          {productos.hasNextPage && (
            <Button
              variant="secondary"
              onClick={() => void productos.fetchNextPage()}
              disabled={productos.isFetchingNextPage}
            >
              {productos.isFetchingNextPage ? "Cargando…" : "Mostrar más"}
            </Button>
          )}
        </div>
      )}

      {detalle !== null && <DetalleProducto producto={detalle} onCerrar={() => setDetalle(null)} />}
    </div>
  );
}

function Precio({ producto }: { producto: ProductoFila }): React.JSX.Element {
  if (!producto.price_amount || !producto.price_currency) {
    return <span className="text-faint-foreground">Sin precio</span>;
  }
  return (
    <span>
      {mostrarImporte({ amount: producto.price_amount, currency: producto.price_currency })}
      {producto.price_equivalent_amount && producto.price_equivalent_currency ? (
        <span className="block text-[0.8rem] text-muted-foreground">
          {mostrarImporte({
            amount: producto.price_equivalent_amount,
            currency: producto.price_equivalent_currency,
          })}
        </span>
      ) : null}
    </span>
  );
}

function Existencia({ producto }: { producto: ProductoFila }): React.JSX.Element {
  if (producto.kind === "service") {
    return <span className="text-faint-foreground">Servicio</span>;
  }
  const q = producto.stock_quantity ?? "0";
  if (esCero(q)) {
    return <span className="text-destructive-soft-foreground">Sin existencia</span>;
  }
  return <span>Quedan {mostrarCantidad(q)}</span>;
}

/** La foto o la inicial sobre acento: el placeholder ES diseño, no error. */
function Foto({
  producto,
  className,
}: {
  producto: ProductoFila;
  className: string;
}): React.JSX.Element {
  if (producto.image_url) {
    return (
      <img src={producto.image_url} alt="" loading="lazy" className={`${className} object-cover`} />
    );
  }
  return (
    <div
      className={`${className} flex items-center justify-center bg-accent-soft text-2xl font-semibold text-accent-soft-foreground`}
      aria-hidden
    >
      {producto.name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function TarjetaProducto({
  producto,
  onAbrir,
}: {
  producto: ProductoFila;
  onAbrir: () => void;
}): React.JSX.Element {
  return (
    <button
      onClick={onAbrir}
      className="group overflow-hidden rounded-lg border border-border bg-surface text-left transition-shadow hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      <Foto producto={producto} className="aspect-square w-full" />
      <div className="space-y-0.5 p-2.5">
        <p className="truncate text-[0.92rem] font-medium leading-tight">{producto.name}</p>
        <p className="text-[0.95rem] font-semibold tabular-nums">
          <Precio producto={producto} />
        </p>
        <p className="text-[0.8rem]">
          <Existencia producto={producto} />
        </p>
      </div>
    </button>
  );
}

/** «≈ Bs.» del precio en dólares: lo calcula el SERVIDOR con la tasa del día. */
function EquivalenteBs({
  amount,
  currency,
}: {
  amount: string;
  currency: string;
}): React.JSX.Element | null {
  const { empresa, llamar } = useSesion();
  const limpio = amount.trim().replace(",", ".");
  const valido = importeValido(limpio) && currency === "USD";
  const debounced = useDebounced(limpio, 350);
  const q = useQuery({
    queryKey: ["convertir", empresa.id, debounced],
    enabled: valido && debounced === limpio,
    staleTime: 60_000,
    queryFn: () =>
      llamar<{ converted: string; rate: string }>(
        `/v1/negocio/convertir?amount=${debounced}&from=USD&to=VES`,
      ),
  });
  if (!valido || !q.data) return null;
  return (
    <p className="text-[0.82rem] text-muted-foreground">
      ≈ {mostrarImporte({ amount: q.data.converted, currency: "VES" })} a la tasa de hoy (
      {mostrarCantidad(q.data.rate)})
    </p>
  );
}

export function AltaSimple({
  onCerrar,
  onCreado,
}: {
  onCerrar: () => void;
  onCreado: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [nombre, setNombre] = useState("");
  const [precio, setPrecio] = useState("");
  // ADR-0046: el precio se pone en dólares, siempre — el sistema lo convierte
  // a Bs con la tasa del día (y lo enseña debajo). No hay moneda que elegir.
  const moneda = "USD";
  const [esServicio, setEsServicio] = useState(false);
  const [existencia, setExistencia] = useState("");
  const [costo, setCosto] = useState("");
  const [masDetalles, setMasDetalles] = useState(false);
  const [codigo, setCodigo] = useState("");
  const [barras, setBarras] = useState("");
  const [categoria, setCategoria] = useState("");
  const [foto, setFoto] = useState<File | null>(null);
  const [vistaPrevia, setVistaPrevia] = useState<string | null>(null);
  const fotoRef = useRef<HTMLInputElement>(null);

  const ajustes = useQuery({
    queryKey: ["ajustes", empresa.id],
    staleTime: 5 * 60_000,
    queryFn: () => llamar<{ sells_wholesale: boolean }>("/v1/company-settings"),
  });
  const [mayor, setMayor] = useState("");

  const categorias = useQuery({
    queryKey: ["categorias", empresa.id],
    staleTime: 60_000,
    queryFn: () => llamar<{ items: { id: string; name: string }[] }>("/v1/product-categories"),
  });

  const precioLimpio = precio.trim().replace(",", ".");
  const existenciaLimpia = existencia.trim().replace(",", ".");
  const costoLimpio = costo.trim().replace(",", ".");
  const conStock = !esServicio && existenciaLimpia !== "";
  const listo =
    nombre.trim().length > 0 &&
    importeValido(precioLimpio) &&
    (!conStock || (importeValido(existenciaLimpia) && importeValido(costoLimpio)));

  const crear = useMutation({
    mutationFn: async () => {
      const creado = await llamar<{ product: { id: string } }>("/v1/products/simple", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          name: nombre.trim(),
          price: { amount: precioLimpio, currency: moneda },
          ...(esServicio ? { is_service: true } : {}),
          ...(conStock
            ? {
                initial_stock: {
                  quantity: existenciaLimpia,
                  unit_cost: { amount: costoLimpio, currency: "VES" },
                },
              }
            : {}),
          ...(codigo.trim() === "" ? {} : { sku: codigo.trim() }),
          ...(barras.trim() === "" ? {} : { barcode: barras.trim() }),
          ...(categoria.trim() === "" ? {} : { category_name: categoria.trim() }),
          ...(ajustes.data?.sells_wholesale && importeValido(mayor.trim().replace(",", "."))
            ? { wholesale_price: { amount: mayor.trim().replace(",", "."), currency: moneda } }
            : {}),
        }),
      });
      if (foto !== null) {
        const form = new FormData();
        form.append("file", foto);
        await llamar(`/v1/products/${creado.product.id}/image`, { method: "POST", body: form });
      }
      return creado;
    },
    onSuccess: () => {
      toast.success("Producto agregado", `${nombre.trim()} ya está listo para vender.`);
      onCreado();
      onCerrar();
    },
    onError: (e) => toast.error("No se pudo agregar", errorDePersona(e)),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-lg">
        <DialogTitle>Nuevo producto</DialogTitle>
        <DialogDescription>
          Con el nombre y el precio basta. Lo demás es opcional.
        </DialogDescription>
        <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1 pt-2">
          <div className="flex items-start gap-3">
            <button
              type="button"
              onClick={() => fotoRef.current?.click()}
              className="flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-dashed border-border bg-surface-muted text-faint-foreground hover:border-accent"
              aria-label="Agregar foto"
            >
              {vistaPrevia !== null ? (
                <img src={vistaPrevia} alt="" className="size-full object-cover" />
              ) : (
                <Camera className="size-6" />
              )}
            </button>
            <input
              ref={fotoRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFoto(f);
                setVistaPrevia(f === null ? null : URL.createObjectURL(f));
              }}
            />
            <div className="min-w-0 flex-1 space-y-3">
              <FormField label="Nombre" required>
                {(p) => (
                  <Input
                    {...p}
                    value={nombre}
                    onChange={(e) => setNombre(e.target.value)}
                    placeholder="Harina de maíz 1kg"
                    autoFocus
                  />
                )}
              </FormField>
              {/* El precio NO es un campo del producto: se guarda como un
                  renglón de la lista «detal». Decirlo aquí evita la duda de
                  «¿y este precio compite con el de mis listas?» (2026-09-10). */}
              <FormField label="Precio de venta al detal (USD)" required>
                {(p) => <MoneyInput {...p} value={precio} onChange={setPrecio} currency="USD" />}
              </FormField>
              <p className="text-[0.8rem] text-faint-foreground">
                Se guarda en tu lista «detal». Si manejas otras listas, sus precios se ponen desde
                Listas de precios.
              </p>
              <EquivalenteBs amount={precio} currency={moneda} />
            </div>
          </div>

          <label className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
            <span className="text-[0.9rem]">
              Es un servicio
              <span className="block text-[0.78rem] text-muted-foreground">
                Se vende pero no se cuenta: delivery, reparación, hora de trabajo.
              </span>
            </span>
            <Switch
              checked={esServicio}
              onCheckedChange={setEsServicio}
              aria-label="Es un servicio"
            />
          </label>

          {!esServicio && (
            <div className="grid grid-cols-2 gap-2">
              <FormField
                label="¿Cuántos tienes hoy?"
                hint="Puedes dejarlo vacío y cargarlo después."
              >
                {(p) => (
                  <Input
                    {...p}
                    inputMode="decimal"
                    value={existencia}
                    onChange={(e) => setExistencia(e.target.value)}
                    placeholder="0"
                  />
                )}
              </FormField>
              <FormField label="Costo por unidad" hint="Lo que te costó a ti, en Bs.">
                {(p) => (
                  <MoneyInput
                    {...p}
                    value={costo}
                    onChange={setCosto}
                    currency="VES"
                    disabled={existenciaLimpia === ""}
                  />
                )}
              </FormField>
            </div>
          )}

          <button
            type="button"
            className="flex items-center gap-1 text-[0.88rem] text-accent-soft-foreground"
            onClick={() => setMasDetalles((v) => !v)}
            aria-expanded={masDetalles}
          >
            {masDetalles ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            Más detalles
          </button>
          {masDetalles && (
            <div className="grid grid-cols-2 gap-2">
              <FormField label="Código" hint="Si lo dejas vacío, se genera solo.">
                {(p) => <Input {...p} value={codigo} onChange={(e) => setCodigo(e.target.value)} />}
              </FormField>
              <FormField label="Código de barras">
                {(p) => <Input {...p} value={barras} onChange={(e) => setBarras(e.target.value)} />}
              </FormField>
              <FormField label="Categoría" hint="Se crea si no existe." className="col-span-2">
                {(p) => (
                  <>
                    <Input
                      {...p}
                      value={categoria}
                      onChange={(e) => setCategoria(e.target.value)}
                      list="categorias-existentes"
                      placeholder="Alimentos"
                    />
                    <datalist id="categorias-existentes">
                      {(categorias.data?.items ?? []).map((c) => (
                        <option key={c.id} value={c.name} />
                      ))}
                    </datalist>
                  </>
                )}
              </FormField>
              {ajustes.data?.sells_wholesale && (
                <FormField label="Precio al mayor" className="col-span-2">
                  {(p) => <MoneyInput {...p} value={mayor} onChange={setMayor} currency={moneda} />}
                </FormField>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={!listo || crear.isPending}
            onClick={() => crear.mutate()}
          >
            {crear.isPending ? "Guardando…" : "Agregar producto"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * La importación de productos, sobre el componente COMÚN (2026-09-08): .csv
 * o .xlsx, con plantilla descargable y el formato dicho en letra chica. El
 * nombre se conserva porque Empezar también lo usa.
 */
export function ImportarExcel({
  onCerrar,
  onListo,
}: {
  onCerrar: () => void;
  onListo: () => void;
}): React.JSX.Element {
  return (
    <ImportarArchivo
      titulo="Importar productos"
      descripcion="Descarga la plantilla, llénala en Excel o en cualquier editor, y súbela. Las filas buenas entran; las malas se explican con su número."
      notaFormato={NOTA_FORMATO_PRODUCTOS}
      endpoint="/v1/products/import"
      plantilla={PLANTILLA_PRODUCTOS}
      onCerrar={onCerrar}
      onListo={onListo}
    />
  );
}

/**
 * La ficha del producto ARRIBA es SOLO LECTURA (regla de los dos mundos,
 * 2026-09-08): el cajero consulta; la foto, el código de barras y todo lo
 * demás se gestionan en Administración → Productos.
 */
function DetalleProducto({
  producto,
  onCerrar,
}: {
  producto: ProductoFila;
  onCerrar: () => void;
}): React.JSX.Element {
  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-md">
        <DialogTitle>{producto.name}</DialogTitle>
        <div className="space-y-3 pt-2">
          <Foto producto={producto} className="aspect-square w-full rounded-lg" />
          <div className="flex items-center justify-between text-[0.95rem]">
            <span className="text-muted-foreground">Precio</span>
            <span className="font-semibold tabular-nums">
              <Precio producto={producto} />
            </span>
          </div>
          <div className="flex items-center justify-between text-[0.95rem]">
            <span className="text-muted-foreground">Existencia</span>
            <span className="tabular-nums">
              <Existencia producto={producto} />
            </span>
          </div>
          <div className="flex items-center justify-between text-[0.95rem]">
            <span className="text-muted-foreground">Código</span>
            <span className="font-mono text-[0.85rem]">{producto.sku}</span>
          </div>
          {producto.barcode !== null && producto.barcode !== undefined && (
            <div className="flex items-center justify-between text-[0.95rem]">
              <span className="text-muted-foreground">Código de barras</span>
              <span className="font-mono text-[0.85rem]">{producto.barcode}</span>
            </div>
          )}
          <div className="flex gap-2">
            <Link to={`/inventario?producto=${producto.id}`} className="flex-1">
              <Button variant="ghost" className="w-full" onClick={onCerrar}>
                Ver movimientos
              </Button>
            </Link>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
