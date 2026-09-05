import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, PackageCheck, PackageX, TriangleAlert } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { mostrarCantidad } from "../../money.js";
import { compararImportes, esCero } from "../../components/decimal-compare.js";
import { Card, CardContent } from "../../ui/card.js";
import { fechaRelativa } from "./comunes.js";

/**
 * INVENTARIO (Fase C, PARTE 8): tres números grandes y la lista de
 * Movimientos en idioma de persona. SOLO CONSULTA (decisión del dueño,
 * 2026-09-05): arriba se vende y se mira; registrar que llegó, salió o se
 * ajustó mercancía vive en Administración → Inventario.
 */

interface ProductoFila {
  id: string;
  sku: string;
  name: string;
  kind: "good" | "service";
  stock_quantity?: string | null;
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

export function InventarioNegocio(): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const [params] = useSearchParams();
  const productoFiltro = params.get("producto");
  const [pestana, setPestana] = useState<"existencias" | "movimientos">(
    productoFiltro !== null ? "movimientos" : "existencias",
  );

  const productos = useQuery({
    queryKey: ["inv-productos", empresa.id],
    queryFn: () =>
      llamar<{ items: ProductoFila[]; total: number }>(
        "/v1/products?with_stock=1&only_active=1&per_page=100",
      ),
  });
  const bajoMinimo = useQuery({
    queryKey: ["inv-bajos", empresa.id],
    queryFn: () => llamar<{ items: unknown[] }>("/v1/inventory/low-stock"),
  });

  const fisicos = (productos.data?.items ?? []).filter((p) => p.kind === "good");
  const conExistencia = fisicos.filter(
    (p) => compararImportes(p.stock_quantity ?? "0", "0") > 0,
  ).length;
  const sinExistencia = fisicos.length - conExistencia;

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

      {/* Quien puede registrar movimientos encuentra la puerta aquí: los
          verbos viven en la administración, no en el mostrador. */}
      {puede("inventory.move") && (
        <Link
          to="/admin/inventario"
          className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3 text-[0.9rem] transition-colors hover:border-accent hover:bg-accent-soft/30"
        >
          <span>
            ¿Llegó, salió o contaste mercancía? Se registra en{" "}
            <strong>Administración → Inventario</strong>.
          </span>
          <ArrowRight className="size-4 shrink-0 text-accent" />
        </Link>
      )}

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
