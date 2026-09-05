import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowRightLeft,
  ArrowUpFromLine,
  ClipboardCheck,
  PackageCheck,
  PackageX,
  TriangleAlert,
} from "lucide-react";
import { useSesion } from "../../app/session.js";
import { errorDePersona } from "../../lib.js";
import { mostrarCantidad } from "../../money.js";
import { compararImportes, esCero, restarCantidades } from "../../components/decimal-compare.js";
import { Button } from "../../ui/button.js";
import { Card, CardContent } from "../../ui/card.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../ui/dialog.js";
import { Input, Textarea } from "../../ui/input.js";
import { SimpleSelect } from "../../ui/select.js";
import { useToast } from "../../ui/toast.js";
import { FormField, MoneyInput, importeValido } from "../../components/forms.js";
import { fechaRelativa } from "./comunes.js";

/**
 * INVENTARIO (Fase C, PARTE 8): tres números grandes, cuatro verbos y la
 * lista de Movimientos en idioma de persona. La mercancía entra con su costo
 * (y puede entrar directo como compra con factura), sale con su motivo,
 * se ajusta contando y se mueve entre depósitos.
 */

interface ProductoFila {
  id: string;
  sku: string;
  name: string;
  kind: "good" | "service";
  stock_quantity?: string | null;
}
interface Deposito {
  id: string;
  name: string;
}
interface Movimiento {
  id: string;
  kind: string;
  product_id: string;
  quantity: string;
  occurred_at: string;
  reason: string | null;
  reference: string | null;
}

const CANT_RE = /^\d{1,16}(\.\d{1,8})?$/;

export function InventarioNegocio(): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const productoFiltro = params.get("producto");
  const [pestana, setPestana] = useState<"existencias" | "movimientos">(
    productoFiltro !== null ? "movimientos" : "existencias",
  );
  const [dialogo, setDialogo] = useState<"entro" | "salio" | "ajustar" | "mover" | null>(null);

  const productos = useQuery({
    queryKey: ["inv-productos", empresa.id],
    queryFn: () =>
      llamar<{ items: ProductoFila[]; total: number }>(
        "/v1/products?with_stock=1&only_active=1&per_page=100",
      ),
  });
  const depositos = useQuery({
    queryKey: ["depositos", empresa.id],
    staleTime: 5 * 60_000,
    queryFn: () => llamar<Deposito[]>("/v1/warehouses"),
  });
  const bajoMinimo = useQuery({
    queryKey: ["inv-bajos", empresa.id],
    queryFn: () => llamar<{ items: unknown[] }>("/v1/inventory/low-stock"),
  });

  const recargar = () => {
    void qc.invalidateQueries({ queryKey: ["inv-productos", empresa.id] });
    void qc.invalidateQueries({ queryKey: ["inv-movs", empresa.id] });
    void qc.invalidateQueries({ queryKey: ["inv-bajos", empresa.id] });
  };

  const fisicos = (productos.data?.items ?? []).filter((p) => p.kind === "good");
  const conExistencia = fisicos.filter(
    (p) => compararImportes(p.stock_quantity ?? "0", "0") > 0,
  ).length;
  const sinExistencia = fisicos.length - conExistencia;
  const listaDepositos = depositos.data ?? [];

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Inventario</h1>

      <div className="grid gap-3 sm:grid-cols-3">
        <Contador
          icono={PackageCheck}
          titulo="Con existencia"
          valor={productos.isLoading ? "…" : String(conExistencia)}
        />
        <Contador
          icono={TriangleAlert}
          titulo="Por agotarse"
          valor={bajoMinimo.data ? String(bajoMinimo.data.items.length) : "…"}
          alerta={(bajoMinimo.data?.items.length ?? 0) > 0}
        />
        <Contador
          icono={PackageX}
          titulo="Sin existencia"
          valor={productos.isLoading ? "…" : String(sinExistencia)}
          alerta={sinExistencia > 0}
        />
      </div>

      {/* ADR-0048: los verbos aparecen según el rol — el cajero VE existencias
          y movimientos, pero no registra si llegó algo o no. */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {puede("inventory.move") && (
          <BotonVerbo
            icono={ArrowDownToLine}
            titulo="Entró mercancía"
            detalle="Llegó producto: al depósito con su costo"
            onClick={() => setDialogo("entro")}
          />
        )}
        {puede("inventory.move") && (
          <BotonVerbo
            icono={ArrowUpFromLine}
            titulo="Salió mercancía"
            detalle="Se dañó, venció o se usó: sale con su motivo"
            onClick={() => setDialogo("salio")}
          />
        )}
        {puede("inventory.adjust") && (
          <BotonVerbo
            icono={ClipboardCheck}
            titulo="Ajustar contando"
            detalle="Contaste y no cuadra: se corrige con motivo"
            onClick={() => setDialogo("ajustar")}
          />
        )}
        {listaDepositos.length > 1 && puede("inventory.transfer") && (
          <BotonVerbo
            icono={ArrowRightLeft}
            titulo="Mover"
            detalle="De un depósito a otro"
            onClick={() => setDialogo("mover")}
          />
        )}
      </div>

      <div className="flex gap-1 border-b border-border">
        {(
          [
            ["existencias", "Existencias"],
            ["movimientos", "Movimientos"],
          ] as const
        ).map(([clave, etiqueta]) => (
          <button
            key={clave}
            onClick={() => setPestana(clave)}
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

      {pestana === "existencias" ? (
        <Existencias productos={fisicos} cargando={productos.isLoading} />
      ) : (
        <Movimientos productoFiltro={productoFiltro} productos={productos.data?.items ?? []} />
      )}

      {dialogo === "entro" && (
        <EntroMercancia
          productos={fisicos}
          depositos={listaDepositos}
          onCerrar={() => setDialogo(null)}
          onListo={recargar}
        />
      )}
      {dialogo === "salio" && (
        <SalioMercancia
          productos={fisicos}
          depositos={listaDepositos}
          onCerrar={() => setDialogo(null)}
          onListo={recargar}
        />
      )}
      {dialogo === "ajustar" && (
        <Ajustar
          productos={fisicos}
          depositos={listaDepositos}
          onCerrar={() => setDialogo(null)}
          onListo={recargar}
        />
      )}
      {dialogo === "mover" && (
        <Mover
          productos={fisicos}
          depositos={listaDepositos}
          onCerrar={() => setDialogo(null)}
          onListo={recargar}
        />
      )}
    </div>
  );
}

function Contador({
  icono: Icono,
  titulo,
  valor,
  alerta = false,
}: {
  icono: React.ComponentType<{ className?: string }>;
  titulo: string;
  valor: string;
  alerta?: boolean;
}): React.JSX.Element {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-4">
        <Icono
          className={`size-6 ${alerta ? "text-warning-soft-foreground" : "text-muted-foreground"}`}
        />
        <div>
          <p className="text-2xl font-semibold tabular-nums">{valor}</p>
          <p className="text-[0.85rem] text-muted-foreground">{titulo}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function BotonVerbo({
  icono: Icono,
  titulo,
  detalle,
  onClick,
}: {
  icono: React.ComponentType<{ className?: string }>;
  titulo: string;
  detalle: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex min-h-20 items-center gap-3 rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:border-accent hover:bg-accent-soft/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      <Icono className="size-6 shrink-0 text-accent" />
      <span>
        <span className="block font-medium">{titulo}</span>
        <span className="block text-[0.82rem] text-muted-foreground">{detalle}</span>
      </span>
    </button>
  );
}

function Existencias({
  productos,
  cargando,
}: {
  productos: ProductoFila[];
  cargando: boolean;
}): React.JSX.Element {
  if (cargando) return <p className="text-muted-foreground">Cargando…</p>;
  if (productos.length === 0) {
    return (
      <p className="py-8 text-center text-muted-foreground">
        Sin productos físicos todavía. Agrégalos en Productos.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-surface">
      <table className="w-full text-[0.9rem]">
        <thead>
          <tr className="border-b border-border text-left text-[0.8rem] uppercase tracking-wide text-faint-foreground">
            <th className="px-3 py-2">Producto</th>
            <th className="px-3 py-2 text-right">Existencia</th>
          </tr>
        </thead>
        <tbody>
          {productos.map((p) => {
            const q = p.stock_quantity ?? "0";
            return (
              <tr key={p.id} className="border-b border-border last:border-0">
                <td className="px-3 py-2">{p.name}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {esCero(q) ? (
                    <span className="text-destructive-soft-foreground">Sin existencia</span>
                  ) : (
                    mostrarCantidad(q)
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const VERBO_MOV: Record<string, string> = {
  entrada: "Entró",
  salida: "Salió",
  ajuste: "Ajuste",
  transferencia_in: "Llegó de otro depósito",
  transferencia_out: "Se fue a otro depósito",
};

function Movimientos({
  productoFiltro,
  productos,
}: {
  productoFiltro: string | null;
  productos: ProductoFila[];
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const movs = useQuery({
    queryKey: ["inv-movs", empresa.id, productoFiltro],
    queryFn: () =>
      llamar<{ items: Movimiento[] }>(
        `/v1/inventory/moves?per_page=50${productoFiltro === null ? "" : `&product_id=${productoFiltro}`}`,
      ),
  });
  const nombreDe = useMemo(() => {
    const m = new Map(productos.map((p) => [p.id, p.name]));
    return (id: string) => m.get(id) ?? "Producto";
  }, [productos]);

  const items = movs.data?.items ?? [];
  if (movs.isLoading) return <p className="text-muted-foreground">Cargando…</p>;
  if (items.length === 0) {
    return <p className="py-8 text-center text-muted-foreground">Todavía no hay movimientos.</p>;
  }
  return (
    <div className="divide-y divide-border rounded-md border border-border bg-surface">
      {items.map((m) => (
        <div key={m.id} className="flex items-center gap-3 px-3 py-2.5 text-[0.9rem]">
          <span className="w-24 shrink-0 text-[0.82rem] text-muted-foreground">
            {fechaRelativa(m.occurred_at)}
          </span>
          <span className="min-w-0 flex-1 truncate">
            <strong>{VERBO_MOV[m.kind] ?? m.kind}</strong> · {nombreDe(m.product_id)}
            {m.reason !== null && <span className="text-muted-foreground"> — {m.reason}</span>}
          </span>
          <span className="shrink-0 tabular-nums">{mostrarCantidad(m.quantity)}</span>
        </div>
      ))}
    </div>
  );
}

/** Selector de producto por búsqueda local: la lista ya está en memoria. */
function SelectorProducto({
  productos,
  valor,
  onElegir,
}: {
  productos: ProductoFila[];
  valor: ProductoFila | null;
  onElegir: (p: ProductoFila) => void;
}): React.JSX.Element {
  const [texto, setTexto] = useState("");
  const visibles = useMemo(() => {
    const q = texto.trim().toLowerCase();
    if (q === "") return productos.slice(0, 6);
    return productos.filter((p) => `${p.name} ${p.sku}`.toLowerCase().includes(q)).slice(0, 6);
  }, [productos, texto]);
  if (valor !== null) {
    return (
      <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{valor.name}</span>
          <span className="block text-[0.8rem] text-muted-foreground tabular-nums">
            Hay {mostrarCantidad(valor.stock_quantity ?? "0")}
          </span>
        </span>
        <Button variant="ghost" size="sm" onClick={() => onElegir(null as never)}>
          Cambiar
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <Input
        autoFocus
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        placeholder="Busca el producto…"
        aria-label="Buscar producto"
      />
      <div className="max-h-44 space-y-0.5 overflow-y-auto">
        {visibles.map((p) => (
          <button
            key={p.id}
            className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-[0.9rem] hover:bg-surface-muted"
            onClick={() => onElegir(p)}
          >
            <span className="truncate">{p.name}</span>
            <span className="text-[0.8rem] text-faint-foreground tabular-nums">
              {mostrarCantidad(p.stock_quantity ?? "0")}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function EntroMercancia({
  productos,
  depositos,
  onCerrar,
  onListo,
}: {
  productos: ProductoFila[];
  depositos: Deposito[];
  onCerrar: () => void;
  onListo: () => void;
}): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const toast = useToast();
  const [producto, setProducto] = useState<ProductoFila | null>(null);
  const [cantidad, setCantidad] = useState("");
  const [costoTotal, setCostoTotal] = useState("");
  const [deposito, setDeposito] = useState<string | null>(depositos[0]?.id ?? null);
  const [esCompra, setEsCompra] = useState(false);
  const [proveedor, setProveedor] = useState<string | null>(null);
  const [nroFactura, setNroFactura] = useState("");
  const [nroControl, setNroControl] = useState("");
  const [costoUnitario, setCostoUnitario] = useState("");

  const proveedores = useQuery({
    queryKey: ["proveedores", empresa.id],
    enabled: esCompra,
    queryFn: () =>
      llamar<{ items: { id: string; legal_name: string }[] }>("/v1/suppliers?per_page=100"),
  });

  const cantidadOk = CANT_RE.test(cantidad.trim().replace(",", ".")) && !esCero(cantidad);
  const listo = esCompra
    ? producto !== null &&
      cantidadOk &&
      proveedor !== null &&
      nroFactura.trim() !== "" &&
      nroControl.trim() !== "" &&
      importeValido(costoUnitario.trim().replace(",", ".")) &&
      deposito !== null
    : producto !== null &&
      cantidadOk &&
      importeValido(costoTotal.trim().replace(",", ".")) &&
      deposito !== null;

  const registrar = useMutation({
    mutationFn: () =>
      esCompra
        ? llamar("/v1/purchases/simple", {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({
              company_id: empresa.id,
              supplier_id: proveedor,
              warehouse_id: deposito,
              currency: "VES",
              supplier_document_number: nroFactura.trim(),
              supplier_control_number: nroControl.trim(),
              lines: [
                {
                  product_id: producto!.id,
                  quantity: cantidad.trim().replace(",", "."),
                  unit_price: costoUnitario.trim().replace(",", "."),
                },
              ],
            }),
          })
        : llamar("/v1/inventory/receipts", {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({
              company_id: empresa.id,
              warehouse_id: deposito,
              product_id: producto!.id,
              quantity: cantidad.trim().replace(",", "."),
              amount: costoTotal.trim().replace(",", "."),
              currency: "VES",
              reference: "entrada-mostrador",
            }),
          }),
    onSuccess: () => {
      toast.success(
        "Mercancía registrada",
        esCompra ? "Entró al depósito y la factura del proveedor quedó asentada." : undefined,
      );
      onListo();
      onCerrar();
    },
    onError: (e) => toast.error("No se pudo registrar", errorDePersona(e)),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Entró mercancía</DialogTitle>
        <div className="space-y-3 pt-2">
          <SelectorProducto productos={productos} valor={producto} onElegir={setProducto} />
          <div className="grid grid-cols-2 gap-2">
            <FormField label="¿Cuántos llegaron?" required>
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  value={cantidad}
                  onChange={(e) => setCantidad(e.target.value)}
                />
              )}
            </FormField>
            {!esCompra && (
              <FormField label="¿Cuánto pagaste por todo?" required>
                {(p) => (
                  <MoneyInput {...p} value={costoTotal} onChange={setCostoTotal} currency="Bs." />
                )}
              </FormField>
            )}
          </div>
          {depositos.length > 1 && (
            <FormField label="¿A qué depósito?" required>
              {(p) => (
                <SimpleSelect
                  id={p.id}
                  value={deposito}
                  onValueChange={setDeposito}
                  options={depositos.map((d) => ({ value: d.id, label: d.name }))}
                />
              )}
            </FormField>
          )}
          {/* El atajo registra una COMPRA completa: su permiso es propio. */}
          {puede("purchase.invoice.register") && (
            <label className="flex items-center gap-2 text-[0.9rem]">
              <input
                type="checkbox"
                checked={esCompra}
                onChange={(e) => setEsCompra(e.target.checked)}
                className="size-4 accent-[var(--color-accent)]"
              />
              Llegó con factura del proveedor (se registra como compra)
            </label>
          )}
          {esCompra && (
            <div className="space-y-2 rounded-md border border-border p-3">
              <FormField label="Proveedor" required>
                {(p) => (
                  <SimpleSelect
                    id={p.id}
                    value={proveedor}
                    onValueChange={setProveedor}
                    options={(proveedores.data?.items ?? []).map((s) => ({
                      value: s.id,
                      label: s.legal_name,
                    }))}
                    placeholder={
                      (proveedores.data?.items.length ?? 0) === 0
                        ? "Crea el proveedor en Compras y gastos"
                        : "Elige el proveedor…"
                    }
                  />
                )}
              </FormField>
              <div className="grid grid-cols-2 gap-2">
                <FormField label="N° de la factura" required>
                  {(p) => (
                    <Input
                      {...p}
                      value={nroFactura}
                      onChange={(e) => setNroFactura(e.target.value)}
                    />
                  )}
                </FormField>
                <FormField
                  label="N° impreso de la factura"
                  required
                  hint="El que trae la factura del proveedor."
                >
                  {(p) => (
                    <Input
                      {...p}
                      value={nroControl}
                      onChange={(e) => setNroControl(e.target.value)}
                    />
                  )}
                </FormField>
              </div>
              <FormField label="Precio por unidad (sin IVA)" required>
                {(p) => (
                  <MoneyInput
                    {...p}
                    value={costoUnitario}
                    onChange={setCostoUnitario}
                    currency="Bs."
                  />
                )}
              </FormField>
            </div>
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
            Registrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const MOTIVOS_SALIDA = ["Se dañó", "Se venció", "Uso del negocio", "Regalo o muestra"];

function SalioMercancia({
  productos,
  depositos,
  onCerrar,
  onListo,
}: {
  productos: ProductoFila[];
  depositos: Deposito[];
  onCerrar: () => void;
  onListo: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [producto, setProducto] = useState<ProductoFila | null>(null);
  const [cantidad, setCantidad] = useState("");
  const [motivo, setMotivo] = useState<string | null>(null);
  const [detalle, setDetalle] = useState("");
  const deposito = depositos[0]?.id ?? null;

  const listo =
    producto !== null &&
    CANT_RE.test(cantidad.trim().replace(",", ".")) &&
    !esCero(cantidad) &&
    motivo !== null &&
    deposito !== null;

  const registrar = useMutation({
    mutationFn: () =>
      llamar("/v1/inventory/issues", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          warehouse_id: deposito,
          product_id: producto!.id,
          quantity: cantidad.trim().replace(",", "."),
          note: detalle.trim() === "" ? motivo : `${motivo}: ${detalle.trim()}`,
          reference: "salida-mostrador",
        }),
      }),
    onSuccess: () => {
      toast.success("Salida registrada");
      onListo();
      onCerrar();
    },
    onError: (e) => toast.error("No se pudo registrar", errorDePersona(e)),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Salió mercancía</DialogTitle>
        <DialogDescription>Lo que sale sin venderse: dañado, vencido, consumo.</DialogDescription>
        <div className="space-y-3 pt-2">
          <SelectorProducto productos={productos} valor={producto} onElegir={setProducto} />
          <FormField label="¿Cuántos salieron?" required>
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                value={cantidad}
                onChange={(e) => setCantidad(e.target.value)}
              />
            )}
          </FormField>
          <div>
            <p className="pb-1.5 text-[0.88rem] font-medium">¿Por qué?</p>
            <div className="flex flex-wrap gap-1.5">
              {MOTIVOS_SALIDA.map((m) => (
                <button
                  key={m}
                  onClick={() => setMotivo(m)}
                  className={`rounded-full border px-3 py-1.5 text-[0.85rem] ${
                    motivo === m
                      ? "border-accent bg-accent-soft text-accent-soft-foreground"
                      : "border-border hover:bg-surface-muted"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          <FormField label="Algo más que anotar">
            {(p) => (
              <Textarea
                {...p}
                rows={2}
                value={detalle}
                onChange={(e) => setDetalle(e.target.value)}
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
            disabled={!listo || registrar.isPending}
            onClick={() => registrar.mutate()}
          >
            Registrar salida
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Ajustar({
  productos,
  depositos,
  onCerrar,
  onListo,
}: {
  productos: ProductoFila[];
  depositos: Deposito[];
  onCerrar: () => void;
  onListo: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [producto, setProducto] = useState<ProductoFila | null>(null);
  const [contado, setContado] = useState("");
  const [motivo, setMotivo] = useState("");
  const deposito = depositos[0]?.id ?? null;

  const contadoLimpio = contado.trim().replace(",", ".");
  // Cantidades, NO dinero: el delta que la API pide se calcula exacto con
  // BigInt escalado y el esquema lo vuelve a validar contra los Movimientos reales.
  const delta =
    producto !== null && CANT_RE.test(contadoLimpio)
      ? restarCantidades(contadoLimpio, producto.stock_quantity ?? "0")
      : null;
  const hayDiferencia = delta !== null && !esCero(delta);
  const listo = hayDiferencia && motivo.trim().length >= 3 && deposito !== null;

  const registrar = useMutation({
    mutationFn: () =>
      llamar("/v1/inventory/adjustments", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          warehouse_id: deposito,
          product_id: producto!.id,
          delta,
          reason: motivo.trim(),
          reference: "conteo-mostrador",
        }),
      }),
    onSuccess: () => {
      toast.success("Inventario ajustado");
      onListo();
      onCerrar();
    },
    onError: (e) => toast.error("No se pudo ajustar", errorDePersona(e)),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Ajustar contando</DialogTitle>
        <DialogDescription>
          Di cuántos contaste de verdad y el sistema corrige la diferencia.
        </DialogDescription>
        <div className="space-y-3 pt-2">
          <SelectorProducto productos={productos} valor={producto} onElegir={setProducto} />
          <FormField label="¿Cuántos contaste?" required>
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                value={contado}
                onChange={(e) => setContado(e.target.value)}
              />
            )}
          </FormField>
          {producto !== null && delta !== null && (
            <p className="text-[0.88rem] text-muted-foreground tabular-nums">
              {esCero(delta)
                ? "Cuadra exacto: no hay nada que ajustar."
                : delta.startsWith("-")
                  ? `Faltan ${mostrarCantidad(delta.slice(1))} respecto a lo registrado.`
                  : `Sobran ${mostrarCantidad(delta)} respecto a lo registrado.`}
            </p>
          )}
          {hayDiferencia && (
            <FormField label="¿Qué pasó?" required hint="Una línea basta.">
              {(p) => <Input {...p} value={motivo} onChange={(e) => setMotivo(e.target.value)} />}
            </FormField>
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
            Ajustar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Mover({
  productos,
  depositos,
  onCerrar,
  onListo,
}: {
  productos: ProductoFila[];
  depositos: Deposito[];
  onCerrar: () => void;
  onListo: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [producto, setProducto] = useState<ProductoFila | null>(null);
  const [cantidad, setCantidad] = useState("");
  const [desde, setDesde] = useState<string | null>(depositos[0]?.id ?? null);
  const [hacia, setHacia] = useState<string | null>(null);

  const listo =
    producto !== null &&
    CANT_RE.test(cantidad.trim().replace(",", ".")) &&
    !esCero(cantidad) &&
    desde !== null &&
    hacia !== null &&
    desde !== hacia;

  const registrar = useMutation({
    mutationFn: () =>
      llamar("/v1/inventory/transfers", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          from_warehouse_id: desde,
          to_warehouse_id: hacia,
          product_id: producto!.id,
          quantity: cantidad.trim().replace(",", "."),
        }),
      }),
    onSuccess: () => {
      toast.success("Mercancía movida");
      onListo();
      onCerrar();
    },
    onError: (e) => toast.error("No se pudo mover", errorDePersona(e)),
  });

  const opciones = depositos.map((d) => ({ value: d.id, label: d.name }));

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Mover entre depósitos</DialogTitle>
        <div className="space-y-3 pt-2">
          <SelectorProducto productos={productos} valor={producto} onElegir={setProducto} />
          <FormField label="¿Cuántos?" required>
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                value={cantidad}
                onChange={(e) => setCantidad(e.target.value)}
              />
            )}
          </FormField>
          <div className="grid grid-cols-2 gap-2">
            <FormField label="Desde" required>
              {(p) => (
                <SimpleSelect id={p.id} value={desde} onValueChange={setDesde} options={opciones} />
              )}
            </FormField>
            <FormField label="Hacia" required>
              {(p) => (
                <SimpleSelect id={p.id} value={hacia} onValueChange={setHacia} options={opciones} />
              )}
            </FormField>
          </div>
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
            Mover
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
