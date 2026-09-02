import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip, Plus, Receipt, ShoppingCart, Trash2 } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { errorDePersona } from "../../lib.js";
import { mostrarImporte } from "../../money.js";
import { compararImportes, esCero } from "../../components/decimal-compare.js";
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
import { SimpleSelect } from "../../ui/select.js";
import { Switch } from "../../ui/switch.js";
import { useToast } from "../../ui/toast.js";
import { FormField, MoneyInput, importeValido } from "../../components/forms.js";
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
  name: string;
  kind: "good" | "service";
}
interface FormaDePago {
  id: string;
  name: string;
  kind: string;
  is_active: boolean;
}

const CANT_RE = /^\d{1,16}(\.\d{1,8})?$/;
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

export function ComprasNegocio(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const qc = useQueryClient();
  const [pestana, setPestana] = useState<"gastos" | "compras">("gastos");
  const [nuevoGasto, setNuevoGasto] = useState(false);
  const [nuevaCompra, setNuevaCompra] = useState(false);

  const gastos = useQuery({
    queryKey: ["gastos", empresa.id],
    queryFn: () => llamar<{ items: Gasto[]; total: number }>("/v1/expenses"),
  });
  const facturas = useQuery({
    queryKey: ["facturas-prov", empresa.id],
    queryFn: () => llamar<{ items: FacturaProveedor[]; total: number }>("/v1/supplier-invoices"),
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

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">Compras y gastos</h1>
        <div className="flex-1" />
        <Button variant="secondary" onClick={() => setNuevaCompra(true)}>
          <ShoppingCart /> Registrar compra
        </Button>
        <Button variant="primary" onClick={() => setNuevoGasto(true)}>
          <Plus /> Registrar gasto
        </Button>
      </div>

      <div className="flex gap-1 border-b border-border">
        {(
          [
            ["gastos", "Gastos"],
            ["compras", "Compras a proveedores"],
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

      {pestana === "gastos" ? (
        (gastos.data?.items ?? []).length === 0 ? (
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
          <div className="divide-y divide-border rounded-md border border-border bg-surface">
            {(gastos.data?.items ?? []).map((g) => (
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
        )
      ) : (facturas.data?.items ?? []).length === 0 ? (
        <Card className="py-12 text-center">
          <ShoppingCart className="mx-auto size-8 text-faint-foreground" />
          <p className="mt-2 font-medium">Sin compras registradas</p>
          <p className="mx-auto mt-1 max-w-sm text-[0.9rem] text-muted-foreground">
            Cuando llegue mercancía con su factura, regístrala aquí: entra al depósito y queda claro
            cuánto le debes a cada proveedor.
          </p>
          <Button variant="primary" className="mt-4" onClick={() => setNuevaCompra(true)}>
            <ShoppingCart /> Registrar compra
          </Button>
        </Card>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border bg-surface">
          {(facturas.data?.items ?? []).map((f) => (
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
                <span className="shrink-0 text-[0.8rem] text-success-soft-foreground">Pagada</span>
              ) : (
                <span className="shrink-0 text-[0.8rem] text-warning-soft-foreground tabular-nums">
                  Debo {mostrarImporte({ amount: f.balance, currency: f.transaction_currency })}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {nuevoGasto && <RegistrarGasto onCerrar={() => setNuevoGasto(false)} onListo={recargar} />}
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
        const form = new FormData();
        form.append("file", adjunto);
        const r = await llamar<{ attachment_path: string }>("/v1/expenses/attachment", {
          method: "POST",
          body: form,
        });
        attachment = r.attachment_path;
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
            <p className="pb-1.5 text-[0.88rem] font-medium">¿Qué pagaste?</p>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIAS_GASTO.map((cat) => (
                <button
                  key={cat}
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
  producto: ProductoFila | null;
  cantidad: string;
  precio: string;
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
  const [lineas, setLineas] = useState<LineaCompra[]>([
    { producto: null, cantidad: "", precio: "" },
  ]);
  const [pagarAhora, setPagarAhora] = useState(false);
  const [forma, setForma] = useState<string | null>(null);
  const qc = useQueryClient();

  const productos = useQuery({
    queryKey: ["inv-productos", empresa.id],
    queryFn: () => llamar<{ items: ProductoFila[] }>("/v1/products?only_active=1&per_page=100"),
  });
  const fisicos = (productos.data?.items ?? []).filter((p) => p.kind === "good");
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

  const crearProveedor = useMutation({
    mutationFn: () =>
      llamar<{ id: string }>("/v1/suppliers", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          legal_name: nuevoNombre.trim(),
          tax_id: nuevoRif.trim() === "" ? null : nuevoRif.trim().toUpperCase(),
          supplier_kind: "nacional",
          person_type_code: /^[jg]/i.test(nuevoRif.trim()) ? "juridica" : "natural",
          taxpayer_type_code: "ordinario",
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
      const metodo = (formas.data?.methods ?? []).find((f) => f.id === forma);
      return llamar("/v1/purchases/simple", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          supplier_id: proveedor,
          warehouse_id: deposito,
          currency: "VES",
          supplier_document_number: nroFactura.trim(),
          supplier_control_number: nroControl.trim(),
          lines: lineasValidas.map((l) => ({
            product_id: l.producto!.id,
            quantity: l.cantidad.trim().replace(",", "."),
            unit_price: l.precio.trim().replace(",", "."),
          })),
          ...(pagarAhora && metodo !== undefined
            ? { payment: { instrument: metodo.kind } }
            : pagarAhora && forma !== null
              ? { payment: { instrument: forma } }
              : {}),
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

          <div className="space-y-2">
            <p className="text-[0.88rem] font-medium">¿Qué llegó?</p>
            {lineas.map((l, i) => (
              <div key={i} className="flex items-start gap-2">
                <div className="flex-1">
                  <SimpleSelect
                    value={l.producto?.id ?? null}
                    onValueChange={(v) =>
                      setLineas((prev) =>
                        prev.map((x, j) =>
                          j === i ? { ...x, producto: fisicos.find((f) => f.id === v) ?? null } : x,
                        ),
                      )
                    }
                    options={fisicos.map((f) => ({ value: f.id, label: f.name }))}
                    placeholder="Producto…"
                    ariaLabel={`Producto de la línea ${i + 1}`}
                  />
                </div>
                <Input
                  inputMode="decimal"
                  value={l.cantidad}
                  onChange={(e) =>
                    setLineas((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, cantidad: e.target.value } : x)),
                    )
                  }
                  placeholder="Cant."
                  className="w-20"
                  aria-label={`Cantidad de la línea ${i + 1}`}
                />
                <MoneyInput
                  value={l.precio}
                  onChange={(v) =>
                    setLineas((prev) => prev.map((x, j) => (j === i ? { ...x, precio: v } : x)))
                  }
                  currency="Bs."
                  className="w-32"
                />
                {lineas.length > 1 && (
                  <Button
                    variant="ghost"
                    size="iconSm"
                    aria-label={`Quitar la línea ${i + 1}`}
                    onClick={() => setLineas((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setLineas((prev) => [...prev, { producto: null, cantidad: "", precio: "" }])
              }
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
                  onValueChange={setForma}
                  options={[
                    ...(formas.data?.methods ?? [])
                      .filter((f) => f.is_active)
                      .map((f) => ({ value: f.id, label: f.name })),
                    { value: "efectivo_bs", label: "Efectivo Bs." },
                    { value: "transferencia", label: "Transferencia" },
                  ]}
                />
              )}
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
            {registrar.isPending ? "Registrando…" : "Registrar compra"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
