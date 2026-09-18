import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useSesion } from "../app/session.js";
import { errorDePersona } from "../lib.js";
import { esCero } from "./decimal-compare.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { SimpleSelect } from "../ui/select.js";
import { useToast } from "../ui/toast.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog.js";
import { EntityPicker, FormField, importeValido, type EntityOption } from "./forms.js";

/**
 * HACER UN PEDIDO (ADR-0066, entrega iii) — encargar mercancía que TODAVÍA NO HA LLEGADO.
 *
 * Es el único formulario de compras que sigue pidiendo precios, y por una razón: un pedido es
 * justamente el sitio donde se acuerda cuánto va a costar. Lo que NO hace es mover inventario ni
 * deber dinero — de eso se encarga la llegada, cuando la mercancía esté de verdad en el depósito.
 * Por eso vive aquí y no en Inventario: pedir es un acto de compras, recibir es uno de almacén.
 */
interface ProductoFila {
  id: string;
  name: string;
  sku: string;
  kind: string;
}
interface Deposito {
  id: string;
  name: string;
  is_default: boolean;
  status: string;
}
interface LineaPedido {
  id: string;
  producto: EntityOption | null;
  cantidad: string;
  precio: string;
}

const CANT_RE = /^\d{1,16}(\.\d{1,8})?$/;
const lineaVacia = (): LineaPedido => ({
  id: crypto.randomUUID(),
  producto: null,
  cantidad: "",
  precio: "",
});

export function HacerPedido({
  abierto,
  onCerrar,
}: {
  abierto: boolean;
  onCerrar: (hecho: boolean) => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();

  const [proveedor, setProveedor] = useState<EntityOption | null>(null);
  const [moneda, setMoneda] = useState("VES");
  const [esperado, setEsperado] = useState("");
  const [lineas, setLineas] = useState<LineaPedido[]>([lineaVacia()]);

  const depositos = useQuery({
    queryKey: ["depositos", empresa.id],
    enabled: abierto,
    staleTime: 5 * 60_000,
    queryFn: () => llamar<Deposito[]>("/v1/warehouses"),
  });
  const activos = useMemo(
    () => (depositos.data ?? []).filter((d) => d.status === "active"),
    [depositos.data],
  );
  const [deposito, setDeposito] = useState<string | null>(null);
  const depositoElegido =
    deposito ?? activos.find((d) => d.is_default)?.id ?? activos[0]?.id ?? null;

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
  const buscarProducto = useCallback(
    async (q: string): Promise<EntityOption[]> => {
      const r = await llamar<{ items: ProductoFila[] }>(
        `/v1/products?only_active=1&per_page=50${q === "" ? "" : `&search=${encodeURIComponent(q)}`}`,
      );
      return r.items
        .filter((p) => p.kind === "good")
        .map((p) => ({ id: p.id, label: p.name, detalle: p.sku }));
    },
    [llamar],
  );

  const validas = lineas.filter(
    (l) =>
      l.producto !== null &&
      CANT_RE.test(l.cantidad.trim().replace(",", ".")) &&
      !esCero(l.cantidad) &&
      importeValido(l.precio.trim().replace(",", ".")),
  );
  const listo =
    proveedor !== null &&
    depositoElegido !== null &&
    validas.length > 0 &&
    validas.length === lineas.filter((l) => l.producto !== null).length;

  const limpiar = (): void => {
    setProveedor(null);
    setMoneda("VES");
    setEsperado("");
    setDeposito(null);
    setLineas([lineaVacia()]);
  };

  const crear = useMutation({
    mutationFn: () =>
      llamar<{ id: string; order_number: number }>("/v1/purchase-orders", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          supplier_id: proveedor!.id,
          warehouse_id: depositoElegido,
          currency: moneda,
          ...(esperado === "" ? {} : { expected_at: esperado }),
          lines: validas.map((l) => ({
            product_id: l.producto!.id,
            quantity: l.cantidad.trim().replace(",", "."),
            unit_price: l.precio.trim().replace(",", "."),
          })),
        }),
      }),
    onSuccess: (r) => {
      toast.success(
        `Pedido n.º ${r.order_number} hecho`,
        "Queda en «Por recibir» hasta que llegue la mercancía.",
      );
      void qc.invalidateQueries({ queryKey: ["pedidos-pendientes", empresa.id] });
      limpiar();
      onCerrar(true);
    },
    onError: (e) => toast.error("No se pudo hacer el pedido", errorDePersona(e)),
  });

  return (
    <Dialog
      open={abierto}
      onOpenChange={(v) => {
        if (!v) onCerrar(false);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogTitle>Hacer un pedido</DialogTitle>
        <DialogDescription>
          Encarga mercancía que todavía no ha llegado. No entra al depósito ni le debes nada al
          proveedor hasta que llegue de verdad.
        </DialogDescription>

        <div className="mt-3 space-y-3">
          <FormField label="¿A quién se lo pides?" required>
            {(p) => (
              <EntityPicker
                id={p.id}
                value={proveedor}
                onChange={setProveedor}
                buscar={buscarProveedor}
                placeholder="Busca el proveedor…"
              />
            )}
          </FormField>

          <div className="space-y-2">
            {lineas.map((l, i) => (
              <div key={l.id} className="flex items-start gap-2">
                <div className="flex-1">
                  <label htmlFor={`ped-prod-${l.id}`} className="sr-only">
                    Producto de la línea {i + 1}
                  </label>
                  <EntityPicker
                    id={`ped-prod-${l.id}`}
                    value={l.producto}
                    onChange={(v) =>
                      setLineas((prev) =>
                        prev.map((x) => (x.id === l.id ? { ...x, producto: v } : x)),
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
                  className="w-20"
                  aria-label={`Cuántos pides de la línea ${i + 1}`}
                />
                <Input
                  inputMode="decimal"
                  value={l.precio}
                  onChange={(e) =>
                    setLineas((prev) =>
                      prev.map((x) => (x.id === l.id ? { ...x, precio: e.target.value } : x)),
                    )
                  }
                  placeholder="Precio c/u"
                  className="w-28"
                  aria-label={`Precio acordado de cada uno, línea ${i + 1}`}
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
            ))}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLineas((prev) => [...prev, lineaVacia()])}
            >
              <Plus /> Otro producto
            </Button>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <FormField label="¿En qué moneda?">
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
            <FormField label="¿Para cuándo?" hint="Si lo sabes.">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={esperado}
                  onChange={(e) => setEsperado(e.target.value)}
                />
              )}
            </FormField>
            {activos.length > 1 && (
              <FormField label="¿A qué depósito?">
                {(p) => (
                  <SimpleSelect
                    id={p.id}
                    value={depositoElegido}
                    onValueChange={setDeposito}
                    options={activos.map((d) => ({ value: d.id, label: d.name }))}
                  />
                )}
              </FormField>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => onCerrar(false)}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              disabled={!listo || crear.isPending}
              onClick={() => crear.mutate()}
            >
              {crear.isPending ? "Haciendo el pedido…" : "Hacer el pedido"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
