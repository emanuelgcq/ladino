import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { PackagePlus, Pencil } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DataTable } from "../../components/DataTable.js";
import { FormField } from "../../components/forms.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { Button } from "../../ui/button.js";
import { Input } from "../../ui/input.js";
import { SimpleSelect } from "../../ui/select.js";
import { Badge, type BadgeTone } from "../../ui/badge.js";
import { Skeleton } from "../../ui/card.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../ui/dialog.js";
import { useToast } from "../../ui/toast.js";
import { mostrarImporte } from "../../money.js";
import { MensajeError } from "../ventas/comunes.js";
import type { Product, PriceList, PriceItem, Unit, TaxCategory } from "../../lib.js";

/**
 * Productos — Fase B. Lo mismo que hacía la pantalla anterior, con el sistema:
 * búsqueda/paginación del servidor, alta y edición en diálogo, y el detalle con
 * el precio VIGENTE por lista a fecha explícita (ADR-0032: la fecha es
 * parámetro, no un now() escondido).
 *
 * La clasificación tributaria NO se edita aquí: tiene permiso propio del
 * contador y su propio endpoint — la pantalla lo dice en vez de esconderlo.
 */
const ESTADO: Record<string, { etiqueta: string; tone: BadgeTone }> = {
  draft: { etiqueta: "Borrador", tone: "neutral" },
  active: { etiqueta: "Activo", tone: "accent" },
  inactive: { etiqueta: "Inactivo", tone: "outline" },
};

const PER_PAGE = 25;

export function Productos(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const [busqueda, setBusqueda] = useState("");
  const [pagina, setPagina] = useState(1);
  const [creando, setCreando] = useState(false);
  const [detalle, setDetalle] = useState<Product | null>(null);
  const qc = useQueryClient();

  const productos = useQuery({
    queryKey: ["productos", empresa.id, busqueda, pagina],
    queryFn: () => {
      const q = new URLSearchParams({ page: String(pagina), per_page: String(PER_PAGE) });
      if (busqueda.trim() !== "") q.set("search", busqueda.trim());
      return llamar<{ items: Product[]; total: number }>(`/v1/products?${q.toString()}`);
    },
  });

  const recargar = () => void qc.invalidateQueries({ queryKey: ["productos", empresa.id] });

  const columnas = useMemo<ColumnDef<Product, unknown>[]>(
    () => [
      {
        id: "sku",
        header: "SKU",
        accessorKey: "sku",
        cell: (c) => <span className="font-mono text-[0.84rem]">{c.getValue<string>()}</span>,
      },
      { id: "nombre", header: "Nombre", accessorKey: "name" },
      {
        id: "tipo",
        header: "Tipo",
        enableSorting: false,
        accessorFn: (p) => (p.kind === "good" ? "Bien" : "Servicio"),
      },
      { id: "unidad", header: "Unidad", accessorKey: "unit_code", enableSorting: false },
      {
        id: "fiscal",
        header: "Clasif. fiscal",
        accessorKey: "tax_category_code",
        enableSorting: false,
        cell: (c) => <span className="font-mono text-[0.8rem]">{c.getValue<string>()}</span>,
      },
      {
        id: "estado",
        header: "Estado",
        accessorKey: "status",
        enableSorting: false,
        cell: (c) => {
          const e = ESTADO[c.getValue<string>()] ?? {
            etiqueta: c.getValue<string>(),
            tone: "outline" as const,
          };
          return <Badge tone={e.tone}>{e.etiqueta}</Badge>;
        },
      },
    ],
    [],
  );

  return (
    <div>
      <PageHeader
        title="Productos"
        description="El catálogo: SKU, unidad y clasificación tributaria — la clasificación se congela en cada documento al emitir."
        actions={
          <Button variant="primary" onClick={() => setCreando(true)}>
            <PackagePlus /> Nuevo producto
          </Button>
        }
      />
      <DataTable
        columns={columnas}
        data={productos.data?.items}
        error={productos.error instanceof Error ? productos.error.message : null}
        onRetry={() => void productos.refetch()}
        getRowId={(p) => p.id}
        onRowClick={setDetalle}
        search={{
          value: busqueda,
          onChange: (v) => {
            setBusqueda(v);
            setPagina(1);
          },
          placeholder: "Buscar por SKU o nombre…",
        }}
        pagination={{
          total: productos.data?.total ?? 0,
          page: pagina,
          perPage: PER_PAGE,
          onPageChange: setPagina,
        }}
        exportCsv={{ filename: `productos-${empresa.tax_id}.csv` }}
        empty={{
          title: busqueda === "" ? "El catálogo está vacío" : "Nada con esa búsqueda",
          description:
            busqueda === ""
              ? "Sin productos no hay precios, ni inventario, ni ventas: es la primera pieza."
              : "La búsqueda es del servidor: prueba con parte del SKU o del nombre.",
          action:
            busqueda === "" ? (
              <Button variant="primary" size="sm" onClick={() => setCreando(true)}>
                Crear el primero
              </Button>
            ) : undefined,
        }}
      />

      {creando && <NuevoProducto onCerrar={(hecho) => (setCreando(false), hecho && recargar())} />}
      {detalle !== null && (
        <DetalleProducto
          producto={detalle}
          onCerrar={(hecho) => (setDetalle(null), hecho && recargar())}
        />
      )}
    </div>
  );
}

function NuevoProducto({ onCerrar }: { onCerrar: (hecho: boolean) => void }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [form, setForm] = useState({
    sku: "",
    name: "",
    kind: "good" as "good" | "service",
    unit_code: "unidad",
    tax_category_code: "gravado_general",
    barcode: "",
  });
  const [error, setError] = useState<unknown>(null);
  const [guardando, setGuardando] = useState(false);

  const catalogos = useQuery({
    queryKey: ["catalogos-producto"],
    staleTime: 300_000,
    queryFn: async () => {
      const [unidades, clasifs] = await Promise.all([
        llamar<Unit[]>("/v1/units"),
        llamar<TaxCategory[]>("/v1/tax-categories"),
      ]);
      return { unidades, clasifs };
    },
  });

  async function guardar(): Promise<void> {
    setError(null);
    setGuardando(true);
    try {
      await llamar("/v1/products", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          sku: form.sku,
          name: form.name,
          kind: form.kind,
          unit_code: form.unit_code,
          tax_category_code: form.tax_category_code,
          ...(form.barcode.trim() === "" ? {} : { barcode: form.barcode.trim() }),
        }),
      });
      toast.success("Producto creado", form.sku);
      onCerrar(true);
    } catch (e) {
      setError(e);
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar(false)}>
      <DialogContent className="max-w-xl">
        <DialogTitle>Nuevo producto</DialogTitle>
        <DialogDescription>
          El tipo (bien/servicio) no podrá cambiarse una vez activo, y la clasificación tributaria
          elegida es la que se congelará en cada emisión.
        </DialogDescription>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="SKU" required>
            {(a) => (
              <Input
                id={a.id}
                className="font-mono"
                value={form.sku}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="Nombre" required>
            {(a) => (
              <Input
                id={a.id}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="Tipo" required>
            {(a) => (
              <SimpleSelect
                id={a.id}
                value={form.kind}
                onValueChange={(v) => setForm({ ...form, kind: v as "good" | "service" })}
                options={[
                  { value: "good", label: "Bien (con inventario)" },
                  { value: "service", label: "Servicio" },
                ]}
              />
            )}
          </FormField>
          <FormField label="Unidad" required>
            {(a) => (
              <SimpleSelect
                id={a.id}
                value={form.unit_code}
                onValueChange={(v) => setForm({ ...form, unit_code: v })}
                options={(catalogos.data?.unidades ?? []).map((u) => ({
                  value: u.code,
                  label: u.name,
                }))}
              />
            )}
          </FormField>
          <FormField
            label="Clasificación tributaria"
            required
            hint="VALIDAR-TRIBUTARIO: la confirma el contador."
          >
            {(a) => (
              <SimpleSelect
                id={a.id}
                value={form.tax_category_code}
                onValueChange={(v) => setForm({ ...form, tax_category_code: v })}
                options={(catalogos.data?.clasifs ?? []).map((t) => ({
                  value: t.code,
                  label: t.name,
                }))}
              />
            )}
          </FormField>
          <FormField label="Código de barras">
            {(a) => (
              <Input
                id={a.id}
                className="font-mono"
                value={form.barcode}
                onChange={(e) => setForm({ ...form, barcode: e.target.value })}
              />
            )}
          </FormField>
        </div>
        {error !== null && (
          <div className="mt-3">
            <MensajeError error={error} />
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onCerrar(false)} disabled={guardando}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={guardando || form.sku.trim() === "" || form.name.trim() === ""}
            onClick={() => void guardar()}
          >
            {guardando ? "Creando…" : "Crear producto"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetalleProducto({
  producto,
  onCerrar,
}: {
  producto: Product;
  onCerrar: (hecho: boolean) => void;
}): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const toast = useToast();
  const [editando, setEditando] = useState(false);
  const [form, setForm] = useState({
    name: producto.name,
    status: producto.status,
    barcode: producto.barcode ?? "",
  });
  const [clasif, setClasif] = useState(producto.tax_category_code);
  const [confirmandoClasif, setConfirmandoClasif] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const clasificaciones = useQuery({
    queryKey: ["clasif-tributarias"],
    staleTime: 300_000,
    enabled: puede("product.tax_category.set"),
    queryFn: () => llamar<TaxCategory[]>("/v1/tax-categories"),
  });

  async function cambiarClasificacion(): Promise<void> {
    setError(null);
    try {
      await llamar("/v1/products/" + producto.id + "/tax-category", {
        method: "PUT",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id, tax_category_code: clasif }),
      });
      toast.success("Clasificación cambiada", "Aplica a las emisiones FUTURAS.");
      onCerrar(true);
    } catch (e) {
      setError(e);
      toast.error("No se pudo cambiar la clasificación");
    }
  }

  // El precio VIGENTE por lista, a fecha EXPLÍCITA (hoy, elegido aquí como
  // parámetro — ADR-0032). Un documento con otra fecha pedirá otro vigente.
  const precios = useQuery({
    queryKey: ["precios-de", empresa.id, producto.id],
    queryFn: async () => {
      const listas = await llamar<PriceList[]>("/v1/price-lists");
      const hoy = new Date().toISOString();
      return Promise.all(
        listas.map(async (lista) => {
          const r = await llamar<{
            items: PriceItem[];
            vigente: { amount: string; currency: string } | null;
          }>(
            `/v1/price-lists/${lista.id}/prices?product_id=${producto.id}&at=${encodeURIComponent(hoy)}`,
          );
          return { lista, vigente: r.vigente, historial: r.items.length };
        }),
      );
    },
  });

  async function guardar(): Promise<void> {
    setError(null);
    try {
      await llamar(`/v1/products/${producto.id}`, {
        method: "PATCH",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          name: form.name,
          status: form.status,
          barcode: form.barcode.trim() === "" ? null : form.barcode.trim(),
        }),
      });
      toast.success("Producto actualizado");
      onCerrar(true);
    } catch (e) {
      setError(e);
    }
  }

  const estado = ESTADO[producto.status] ?? { etiqueta: producto.status, tone: "outline" as const };

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar(false)}>
      <DialogContent className="max-w-xl">
        <DialogTitle>
          <span className="font-mono">{producto.sku}</span> — {producto.name}
        </DialogTitle>
        <DialogDescription>
          {producto.kind === "good" ? "Bien" : "Servicio"} · unidad {producto.unit_code} ·{" "}
          <span className="font-mono">{producto.tax_category_code}</span>
          {producto.barcode !== null && producto.barcode !== undefined && producto.barcode !== ""
            ? ` · ${producto.barcode}`
            : ""}
        </DialogDescription>
        <div className="mt-1">
          <Badge tone={estado.tone}>{estado.etiqueta}</Badge>
        </div>

        {!editando ? (
          <div className="mt-3 space-y-2">
            <p className="text-[0.85rem] font-medium">Precio vigente hoy, por lista</p>
            {precios.isPending ? (
              <Skeleton className="h-12 w-full" />
            ) : (precios.data ?? []).length === 0 ? (
              <p className="text-[0.88rem] text-muted-foreground">
                La empresa no tiene listas de precios todavía.
              </p>
            ) : (
              <ul className="space-y-1 text-[0.9rem]">
                {(precios.data ?? []).map(({ lista, vigente, historial }) => (
                  <li key={lista.id} className="flex items-baseline justify-between gap-3">
                    <span className="text-muted-foreground">
                      {lista.name} ({lista.currency_code})
                    </span>
                    <span className="font-mono">
                      {vigente !== null ? (
                        mostrarImporte(vigente)
                      ) : (
                        <span className="text-warning-soft-foreground">sin precio</span>
                      )}
                      <span className="ml-2 text-[0.78rem] text-faint-foreground">
                        {historial} vigencia{historial === 1 ? "" : "s"}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {puede("product.tax_category.set") ? (
              <div className="rounded-md border border-border bg-surface-muted/40 p-3">
                <p className="text-[0.85rem] font-medium">
                  Clasificación tributaria — permiso del contador, auditada
                </p>
                <div className="mt-2 flex gap-2">
                  <div className="flex-1">
                    <SimpleSelect
                      ariaLabel="Clasificación tributaria"
                      value={clasif}
                      onValueChange={setClasif}
                      options={(clasificaciones.data ?? []).map((t) => ({
                        value: t.code,
                        label: t.name,
                      }))}
                    />
                  </div>
                  <Button
                    variant="secondary"
                    disabled={clasif === producto.tax_category_code}
                    onClick={() => setConfirmandoClasif(true)}
                  >
                    Cambiar
                  </Button>
                </div>
              </div>
            ) : (
              <p className="pt-1 text-[0.8rem] text-faint-foreground">
                La clasificación tributaria se cambia aparte, con permiso propio del contador — no
                desde esta edición.
              </p>
            )}
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField label="Nombre" required>
              {(a) => (
                <Input
                  id={a.id}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              )}
            </FormField>
            <FormField label="Estado">
              {(a) => (
                <SimpleSelect
                  id={a.id}
                  value={form.status}
                  onValueChange={(v) => setForm({ ...form, status: v as Product["status"] })}
                  options={[
                    { value: "draft", label: "Borrador" },
                    { value: "active", label: "Activo" },
                    { value: "inactive", label: "Inactivo" },
                  ]}
                />
              )}
            </FormField>
            <FormField label="Código de barras">
              {(a) => (
                <Input
                  id={a.id}
                  className="font-mono"
                  value={form.barcode}
                  onChange={(e) => setForm({ ...form, barcode: e.target.value })}
                />
              )}
            </FormField>
          </div>
        )}

        {error !== null && (
          <div className="mt-3">
            <MensajeError error={error} />
          </div>
        )}

        <DialogFooter>
          {!editando ? (
            <>
              <Button variant="ghost" onClick={() => onCerrar(false)}>
                Cerrar
              </Button>
              <Button variant="secondary" onClick={() => setEditando(true)}>
                <Pencil /> Editar
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setEditando(false)}>
                Volver
              </Button>
              <Button
                variant="primary"
                disabled={form.name.trim() === ""}
                onClick={() => void guardar()}
              >
                Guardar cambios
              </Button>
            </>
          )}
        </DialogFooter>

        <ConfirmDialog
          open={confirmandoClasif}
          onOpenChange={setConfirmandoClasif}
          title="Cambiar la clasificación tributaria"
          confirmLabel="Cambiar la clasificación"
          onConfirm={cambiarClasificacion}
        >
          De «{producto.tax_category_code}» a «{clasif}». Aplica a las emisiones FUTURAS: lo ya
          emitido congeló su clasificación al nacer y NO cambia. Queda auditado (VALIDAR-TRIBUTARIO:
          la confirma el contador).
        </ConfirmDialog>
      </DialogContent>
    </Dialog>
  );
}
