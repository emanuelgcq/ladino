import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Package, Plus, Trash2, Truck, User } from "lucide-react";
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
  MoneyInput,
  importeValido,
  type EntityOption,
} from "../../components/forms.js";
import { ConfirmarSobregiro, esSinSaldo } from "../../components/sobregiro.js";
import { fechaLocal } from "../../fechas.js";
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

type Paso = "origen" | "que" | "factura" | "pago" | "deposito" | "confirmar";
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
  por: "unidad" | "total";
  paquete: string;
  vence: string;
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
  por: "unidad",
  paquete: "",
  vence: "",
});

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

  const [clave] = useState(() => crypto.randomUUID());
  const [paso, setPaso] = useState<Paso>("origen");
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
      importeValido(l.costo.trim().replace(",", ".")) &&
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
            // Uno de los dos, nunca los dos: el otro lo calcula el servidor.
            ...(l.por === "unidad"
              ? { unit_amount: l.costo.trim().replace(",", ".") }
              : { amount: l.costo.trim().replace(",", ".") }),
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
    const p: Paso[] = ["origen", "que"];
    if (origen === "proveedor") {
      p.push("factura");
      if (puedePagar && estadoFactura !== "pending") p.push("pago");
    }
    if (activos.length > 1) p.push("deposito");
    p.push("confirmar");
    return p;
  }, [origen, estadoFactura, puedePagar, activos.length]);
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

          {origen === "proveedor" && (
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

                <div className="grid gap-2 sm:grid-cols-2">
                  <FormField label="El costo que vas a poner es">
                    {(p) => (
                      <SimpleSelect
                        id={p.id}
                        value={l.por}
                        onValueChange={(v) =>
                          setLineas((prev) =>
                            prev.map((x) =>
                              x.id === l.id ? { ...x, por: v === "total" ? "total" : "unidad" } : x,
                            ),
                          )
                        }
                        options={[
                          { value: "unidad", label: "De cada uno (100 por bolsa)" },
                          { value: "total", label: "El total de la llegada (1.000 por 10 bolsas)" },
                        ]}
                      />
                    )}
                  </FormField>
                  <FormField
                    label={l.por === "unidad" ? "¿Cuánto costó cada uno?" : "¿Cuánto costó todo?"}
                    required
                  >
                    {(p) => (
                      <MoneyInput
                        id={p.id}
                        value={l.costo}
                        onChange={(v) =>
                          setLineas((prev) =>
                            prev.map((x) => (x.id === l.id ? { ...x, costo: v } : x)),
                          )
                        }
                        currency={moneda === "VES" ? "Bs." : moneda}
                      />
                    )}
                  </FormField>
                </div>

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
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLineas((prev) => [...prev, lineaVacia()])}
            >
              <Plus /> Otro producto
            </Button>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <FormField label="Moneda de lo que pagaste" hint="La conversión la hace el sistema.">
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
                  Se la compraste a <strong>{proveedor?.label}</strong>.
                </p>
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
