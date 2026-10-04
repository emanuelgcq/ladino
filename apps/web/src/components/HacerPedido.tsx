import { useCallback, useMemo, useState } from "react";
import { formatearDocumento } from "@ladino/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useSesion } from "../app/session.js";
import { errorDePersona, type PriceList } from "../lib.js";
import { monedaQueSeEnsena, nombreCortoDeMoneda } from "../moneda-del-pedido.js";
import { esCero } from "./decimal-compare.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { SimpleSelect } from "../ui/select.js";
import { useToast } from "../ui/toast.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog.js";
import {
  EntityPicker,
  FormField,
  MotivoDeLectura,
  cantidadLimpia,
  cantidadValida,
  importeLimpio,
  importeValido,
  motivoDeCantidad,
  motivoDeImporte,
  type EntityOption,
} from "./forms.js";

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
  // H-06: la moneda nace de la lista de precios de la empresa, no fija en bolívares. `null` =
  // la persona no la ha tocado y vale la propuesta.
  const [monedaElegida, setMonedaElegida] = useState<string | null>(null);
  const listas = useQuery({
    queryKey: ["listas-de-precios", empresa.id],
    enabled: abierto,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => llamar<PriceList[]>("/v1/price-lists"),
  });
  // Mientras las listas cargan no se propone ninguna (null): el selector no salta solo de
  // dólares a bolívares con la persona ya escribiendo, y lo que ella eligió no se le cambia.
  const moneda = monedaQueSeEnsena(monedaElegida, listas.isLoading, listas.data);
  const enMoneda = moneda === null ? "" : ` en ${nombreCortoDeMoneda(moneda)}`;
  const setMoneda = setMonedaElegida;
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
        ...(s.tax_id === null ? {} : { detalle: formatearDocumento(s.tax_id) }),
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
      cantidadValida(l.cantidad) &&
      !esCero(cantidadLimpia(l.cantidad)) &&
      importeValido(l.precio),
  );
  const listo =
    moneda !== null &&
    proveedor !== null &&
    depositoElegido !== null &&
    validas.length > 0 &&
    validas.length === lineas.filter((l) => l.producto !== null).length;

  const limpiar = (): void => {
    setProveedor(null);
    setMonedaElegida(null);
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
            quantity: cantidadLimpia(l.cantidad),
            unit_price: importeLimpio(l.precio),
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

          <FormField
            label="¿En qué moneda van los precios?"
            hint="Los precios de abajo se guardan en esta moneda."
          >
            {(p) => (
              <SimpleSelect
                id={p.id}
                value={moneda}
                onValueChange={setMoneda}
                placeholder="Cargando…"
                options={[
                  { value: "USD", label: "Dólares (USD)" },
                  { value: "VES", label: "Bolívares (Bs.)" },
                ]}
              />
            )}
          </FormField>

          <div className="space-y-2">
            {lineas.map((l, i) => (
              <div key={l.id} className="space-y-1">
                <div className="flex items-start gap-2">
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
                    placeholder={`Precio c/u${enMoneda}`}
                    className="w-36"
                    aria-label={`Precio acordado de cada uno${enMoneda}, línea ${i + 1}`}
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
                {/* F-06: lo que no se pudo leer se dice junto a su línea. */}
                <MotivoDeLectura motivo={motivoDeCantidad(l.cantidad)} />
                <MotivoDeLectura motivo={motivoDeImporte(l.precio)} />
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
