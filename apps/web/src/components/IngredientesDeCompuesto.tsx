import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useSesion } from "../app/session.js";
import { errorDePersona } from "../lib.js";
import type { Product } from "../lib.js";
import { mostrarCantidad } from "../money.js";
import { EntityPicker, leerCantidad, type EntityOption } from "./forms.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { Skeleton } from "../ui/card.js";
import { useToast } from "../ui/toast.js";

/**
 * LOS INGREDIENTES DE UN PRODUCTO COMPUESTO (I-04 del recorrido 2026-09-24).
 *
 * Un compuesto no se cuenta: al venderlo se descuentan sus ingredientes. Aquí se escribe cuánto
 * de cada uno lleva UNA unidad. La cantidad va en la unidad en que se lleva el ingrediente, que
 * es la que la persona ve en su inventario; el servidor guarda la lista entera de una vez y es
 * quien valida (un ingrediente no puede ser otro compuesto ni el propio producto).
 *
 * Sin aritmética de dinero: aquí solo hay cantidades, y viajan como texto.
 */
interface Fila {
  producto: (EntityOption & { unidad: string }) | null;
  cantidad: string;
}

interface Receta {
  lines: {
    child_product_id: string;
    child_sku: string;
    child_name: string;
    quantity: string;
    unit_code: string;
    product_unit_code: string;
  }[];
}

export function IngredientesDeCompuesto({
  productoId,
  puedeEditar,
}: {
  productoId: string;
  puedeEditar: boolean;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  const receta = useQuery({
    queryKey: ["ingredientes", empresa.id, productoId],
    queryFn: () => llamar<Receta>(`/v1/products/${productoId}/recipe`),
  });
  const [filas, setFilas] = useState<Fila[] | null>(null);
  const [guardando, setGuardando] = useState(false);

  // La lista editable nace de lo guardado, una vez por carga.
  useEffect(() => {
    if (receta.data === undefined) return;
    setFilas(
      receta.data.lines.map((l) => ({
        producto: {
          id: l.child_product_id,
          label: l.child_name,
          detalle: l.child_sku,
          unidad: l.unit_code,
        },
        cantidad: mostrarCantidad(l.quantity),
      })),
    );
  }, [receta.data]);

  if (receta.isPending || filas === null) return <Skeleton className="h-16 w-full" />;
  if (receta.isError) {
    return (
      <p role="alert" className="text-[0.88rem] text-destructive-soft-foreground">
        {errorDePersona(receta.error)}
      </p>
    );
  }

  const completas = filas.filter((f) => f.producto !== null && f.cantidad.trim() !== "");
  const mala = completas.find((f) => !leerCantidad(f.cantidad).ok);
  const repetido =
    new Set(completas.map((f) => f.producto!.id)).size !== completas.length
      ? "Un ingrediente está dos veces: déjalo una sola vez, con su cantidad total."
      : null;
  const listo = completas.length > 0 && mala === undefined && repetido === null;

  async function guardar(): Promise<void> {
    setGuardando(true);
    try {
      await llamar(`/v1/products/${productoId}/recipe`, {
        method: "PUT",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          lines: completas.map((f) => {
            const q = leerCantidad(f.cantidad);
            return {
              child_product_id: f.producto!.id,
              quantity: q.ok ? q.cantidad : f.cantidad,
              unit_code: f.producto!.unidad,
            };
          }),
        }),
      });
      toast.success(
        "Ingredientes guardados",
        "Desde ahora, cada venta descuenta estos ingredientes. Las ventas ya hechas no cambian.",
      );
      await qc.invalidateQueries({ queryKey: ["ingredientes", empresa.id, productoId] });
    } catch (e) {
      toast.error("No se pudieron guardar los ingredientes", errorDePersona(e));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-[0.85rem] font-medium">Ingredientes de una unidad</p>
      <p className="text-[0.8rem] text-muted-foreground">
        Este producto no se cuenta en el inventario: al venderlo se descuenta lo que escribas aquí.
        Sin ingredientes no se puede vender.
      </p>
      {filas.length === 0 && (
        <p className="text-[0.85rem] text-warning-soft-foreground">
          Todavía no tiene ingredientes.
        </p>
      )}
      <ul className="space-y-2">
        {filas.map((f, i) => (
          <li key={i} className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <EntityPicker
                placeholder="Buscar el ingrediente…"
                value={f.producto}
                disabled={!puedeEditar}
                onChange={(v) =>
                  setFilas(
                    filas.map((x, j) => (j === i ? { ...x, producto: v as Fila["producto"] } : x)),
                  )
                }
                buscar={async (q) => {
                  const r = await llamar<{ items: Product[] }>(
                    `/v1/products?search=${encodeURIComponent(q)}&per_page=10`,
                  );
                  return r.items
                    .filter((p) => p.kind === "good" && !p.is_composed && p.id !== productoId)
                    .map((p) => ({
                      id: p.id,
                      label: p.name,
                      detalle: `${p.sku} · se lleva por ${p.unit_code}`,
                      unidad: p.unit_code,
                    }));
                }}
              />
            </div>
            <Input
              aria-label="Cuánto lleva"
              className="w-24"
              inputMode="decimal"
              placeholder="Cuánto"
              value={f.cantidad}
              disabled={!puedeEditar}
              aria-invalid={f.cantidad.trim() !== "" && !leerCantidad(f.cantidad).ok}
              onChange={(e) =>
                setFilas(filas.map((x, j) => (j === i ? { ...x, cantidad: e.target.value } : x)))
              }
            />
            <span className="w-14 truncate text-[0.8rem] text-muted-foreground">
              {f.producto?.unidad ?? ""}
            </span>
            {puedeEditar && (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Quitar el ingrediente"
                onClick={() => setFilas(filas.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {mala !== undefined && (
        <p role="alert" className="text-[0.8rem] text-destructive-soft-foreground">
          Hay una cantidad que no se entiende: escríbela con números, mayor que cero.
        </p>
      )}
      {repetido !== null && (
        <p role="alert" className="text-[0.8rem] text-destructive-soft-foreground">
          {repetido}
        </p>
      )}
      {puedeEditar && (
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setFilas([...filas, { producto: null, cantidad: "" }])}
          >
            <Plus /> Agregar ingrediente
          </Button>
          <Button size="sm" disabled={!listo || guardando} onClick={() => void guardar()}>
            {guardando ? "Guardando…" : "Guardar ingredientes"}
          </Button>
        </div>
      )}
    </div>
  );
}
