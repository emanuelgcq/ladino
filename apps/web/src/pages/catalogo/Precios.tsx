import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus, Tags } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DataTable } from "../../components/DataTable.js";
import {
  FormField,
  MoneyInput,
  EntityPicker,
  importeValido,
  type EntityOption,
} from "../../components/forms.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { Button } from "../../ui/button.js";
import { Input } from "../../ui/input.js";
import { SimpleSelect } from "../../ui/select.js";
import { Badge } from "../../ui/badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card.js";
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
import type { PriceList, PriceItem, Product } from "../../lib.js";

/**
 * Listas de precios — Fase B. La regla que esta pantalla ENSEÑA en vez de
 * esconder: un precio no se edita ni se borra (ADR-0032, append-only). Cargar
 * una vigencia nueva CIERRA la anterior en ese instante, y el historial de la
 * tabla es la prueba. La confirmación lo dice antes de escribir.
 */
export function Precios(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const [seleccionada, setSeleccionada] = useState<PriceList | null>(null);
  const [creando, setCreando] = useState(false);
  const qc = useQueryClient();

  const listas = useQuery({
    queryKey: ["listas", empresa.id],
    queryFn: () => llamar<PriceList[]>("/v1/price-lists"),
  });

  return (
    <div>
      <PageHeader
        title="Listas de precios"
        description="Cada lista vive en UNA moneda; el documento que la usa nace en esa moneda y de ahí sale el diferencial cambiario."
        actions={
          <Button variant="primary" onClick={() => setCreando(true)}>
            <Plus /> Nueva lista
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Listas</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 px-2 pb-2">
            {(listas.data ?? []).map((l) => (
              <button
                key={l.id}
                onClick={() => setSeleccionada(l)}
                className={`flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-[0.9rem] transition-colors ${
                  seleccionada?.id === l.id
                    ? "bg-accent-soft font-medium text-accent-soft-foreground"
                    : "hover:bg-surface-muted"
                }`}
              >
                <span className="truncate">{l.name}</span>
                <Badge tone={l.status === "active" ? "accent" : "neutral"}>{l.currency_code}</Badge>
              </button>
            ))}
            {listas.data !== undefined && listas.data.length === 0 && (
              <p className="px-2 py-3 text-[0.85rem] text-muted-foreground">
                Sin listas todavía — sin lista no hay precio y sin precio no hay venta.
              </p>
            )}
          </CardContent>
        </Card>

        <div className="lg:col-span-3">
          {seleccionada === null ? (
            <Card>
              <CardContent className="py-10 text-center text-[0.9rem] text-muted-foreground">
                <Tags className="mx-auto mb-2 size-6 text-faint-foreground" />
                Elige una lista para ver su historial de vigencias y cargar precios.
              </CardContent>
            </Card>
          ) : (
            <PreciosDeLista lista={seleccionada} />
          )}
        </div>
      </div>

      {creando && (
        <NuevaLista
          onCerrar={(hecha) => {
            setCreando(false);
            if (hecha) void qc.invalidateQueries({ queryKey: ["listas", empresa.id] });
          }}
        />
      )}
    </div>
  );
}

function NuevaLista({ onCerrar }: { onCerrar: (hecha: boolean) => void }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [nombre, setNombre] = useState("");
  const [moneda, setMoneda] = useState("VES");
  const [error, setError] = useState<unknown>(null);
  const [guardando, setGuardando] = useState(false);

  async function crear(): Promise<void> {
    setError(null);
    setGuardando(true);
    try {
      await llamar("/v1/price-lists", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id, name: nombre, currency_code: moneda }),
      });
      toast.success("Lista creada", `${nombre} (${moneda})`);
      onCerrar(true);
    } catch (e) {
      setError(e);
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar(false)}>
      <DialogContent>
        <DialogTitle>Nueva lista de precios</DialogTitle>
        <DialogDescription>
          La moneda es de la LISTA y no se cambia después: los documentos que la usen nacerán en
          ella.
        </DialogDescription>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <FormField label="Nombre" required>
            {(a) => <Input id={a.id} value={nombre} onChange={(e) => setNombre(e.target.value)} />}
          </FormField>
          <FormField label="Moneda" required>
            {(a) => (
              <SimpleSelect
                id={a.id}
                value={moneda}
                onValueChange={setMoneda}
                options={[
                  { value: "VES", label: "VES — Bolívares" },
                  { value: "USD", label: "USD — Dólares" },
                ]}
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
            disabled={guardando || nombre.trim() === ""}
            onClick={() => void crear()}
          >
            Crear lista
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreciosDeLista({ lista }: { lista: PriceList }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  const [producto, setProducto] = useState<EntityOption | null>(null);
  const [importe, setImporte] = useState("");
  const [desde, setDesde] = useState("");
  const [confirmando, setConfirmando] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const precios = useQuery({
    queryKey: ["precios-lista", empresa.id, lista.id],
    queryFn: async () => {
      const [r, prods] = await Promise.all([
        llamar<{ items: PriceItem[] }>(`/v1/price-lists/${lista.id}/prices`),
        llamar<{ items: Product[] }>(`/v1/products?per_page=100`),
      ]);
      const skuDe = new Map(prods.items.map((p) => [p.id, `${p.sku} · ${p.name}`]));
      return r.items.map((i) => ({ ...i, producto: skuDe.get(i.product_id) ?? i.product_id }));
    },
  });

  type Fila = PriceItem & { producto: string };
  const columnas = useMemo<ColumnDef<Fila, unknown>[]>(
    () => [
      { id: "producto", header: "Producto", accessorKey: "producto" },
      {
        id: "importe",
        header: () => <span className="block text-right">Importe</span>,
        accessorKey: "amount",
        enableSorting: false,
        cell: (c) => (
          <span className="block text-right font-mono text-[0.84rem]">
            {mostrarImporte({ amount: c.row.original.amount, currency: c.row.original.currency })}
          </span>
        ),
      },
      {
        id: "desde",
        header: "Desde",
        accessorFn: (i) => i.effective_from.slice(0, 16).replace("T", " "),
      },
      {
        id: "hasta",
        header: "Hasta",
        enableSorting: false,
        cell: (c) =>
          c.row.original.effective_to === null ? (
            <Badge tone="accent">Vigente</Badge>
          ) : (
            <span className="text-muted-foreground">
              {c.row.original.effective_to.slice(0, 16).replace("T", " ")}
            </span>
          ),
      },
    ],
    [],
  );

  async function cargarPrecio(): Promise<void> {
    setError(null);
    const cuando = desde === "" ? new Date().toISOString() : new Date(desde).toISOString();
    try {
      await llamar(`/v1/price-lists/${lista.id}/prices`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          product_id: producto?.id ?? "",
          amount: importe.trim(),
          effective_from: cuando,
        }),
      });
      toast.success("Precio cargado", "La vigencia anterior, si la había, quedó cerrada.");
      setImporte("");
      setDesde("");
      await qc.invalidateQueries({ queryKey: ["precios-lista", empresa.id, lista.id] });
    } catch (e) {
      setError(e);
      toast.error("No se pudo cargar el precio");
    }
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle>
            Cargar precio en {lista.name} ({lista.currency_code})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <FormField label="Producto" required>
              {(a) => (
                <EntityPicker
                  id={a.id}
                  placeholder="SKU o nombre…"
                  value={producto}
                  onChange={setProducto}
                  buscar={async (q) => {
                    const r = await llamar<{ items: Product[] }>(
                      `/v1/products?search=${encodeURIComponent(q)}&per_page=8`,
                    );
                    return r.items.map((p) => ({ id: p.id, label: p.name, detalle: p.sku }));
                  }}
                />
              )}
            </FormField>
            <FormField label={`Importe (${lista.currency_code})`} required>
              {(a) => (
                <MoneyInput
                  id={a.id}
                  value={importe}
                  onChange={setImporte}
                  currency={lista.currency_code}
                />
              )}
            </FormField>
            <FormField label="Vigente desde" hint="Vacío = ahora mismo.">
              {(a) => (
                <Input
                  id={a.id}
                  type="datetime-local"
                  value={desde}
                  onChange={(e) => setDesde(e.target.value)}
                />
              )}
            </FormField>
          </div>
          {error !== null && (
            <div className="mt-3">
              <MensajeError error={error} />
            </div>
          )}
          <div className="mt-3">
            <Button
              variant="primary"
              disabled={producto === null || !importeValido(importe)}
              onClick={() => setConfirmando(true)}
            >
              Cargar precio…
            </Button>
          </div>
        </CardContent>
      </Card>

      <DataTable
        columns={columnas}
        data={precios.data}
        error={precios.error instanceof Error ? precios.error.message : null}
        onRetry={() => void precios.refetch()}
        density="compact"
        exportCsv={{ filename: `precios-${lista.name}.csv` }}
        empty={{
          title: "Sin precios cargados",
          description:
            "El primer precio de cada producto abre su historial de vigencias — que nunca se edita, solo crece.",
        }}
      />

      <ConfirmDialog
        open={confirmando}
        onOpenChange={setConfirmando}
        title="Cargar el precio"
        confirmLabel="Cargar el precio"
        onConfirm={cargarPrecio}
      >
        {producto?.label}:{" "}
        <span className="font-mono">
          {importe} {lista.currency_code}
        </span>{" "}
        desde {desde === "" ? "ahora mismo" : desde.replace("T", " ")}. Si hay un precio abierto
        anterior, <strong>su vigencia se cierra en ese instante</strong> — un precio no se edita ni
        se borra: el historial es la prueba (ADR-0032).
      </ConfirmDialog>
    </div>
  );
}
