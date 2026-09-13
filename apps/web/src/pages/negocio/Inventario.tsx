import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowRight, PackageCheck, PackageX, TriangleAlert } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { errorDePersona } from "../../lib.js";
import { mostrarCantidad } from "../../money.js";
import { compararImportes, esCero } from "../../components/decimal-compare.js";
import { Button } from "../../ui/button.js";
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
  /** Si el servidor los manda, valen aunque el producto ya no esté activo. */
  product_name?: string | null;
  product_sku?: string | null;
  quantity: string;
  occurred_at: string;
  reason: string | null;
  reference: string | null;
}

const MOVS_POR_PAGINA = 50;

/** El listado que no pudo cargar: el motivo y el reintento, nunca «vacío». */
function ErrorDeLista({
  error,
  onReintentar,
}: {
  error: unknown;
  onReintentar: () => void;
}): React.JSX.Element {
  return (
    <Card className="py-8 text-center" role="alert">
      <p className="font-medium">No se pudo cargar</p>
      <p className="mx-auto mt-1 max-w-sm text-[0.9rem] text-muted-foreground">
        {errorDePersona(error)}
      </p>
      <Button variant="secondary" className="mt-4" onClick={onReintentar}>
        Reintentar
      </Button>
    </Card>
  );
}

export function InventarioNegocio(): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const [params] = useSearchParams();
  const productoFiltro = params.get("producto");
  const [pestana, setPestana] = useState<"existencias" | "movimientos">(
    productoFiltro !== null ? "movimientos" : "existencias",
  );

  /**
   * Se acumulan TODAS las páginas (2026-09-10): esta pantalla resume la
   * existencia del negocio entero, y un resumen calculado sobre los primeros
   * 100 productos de 300 no es un resumen — es un número equivocado.
   */
  const productos = useInfiniteQuery({
    queryKey: ["inv-productos", empresa.id],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      llamar<{ items: ProductoFila[]; total: number }>(
        `/v1/products?with_stock=1&only_active=1&per_page=100&page=${pageParam}`,
      ),
    getNextPageParam: (ultima, todas) => {
      const cargados = todas.reduce((n, p) => n + p.items.length, 0);
      return cargados < ultima.total ? todas.length + 1 : undefined;
    },
  });
  // `useInfiniteQuery` sola trae UNA página; sin esto los contadores decían
  // «100 con existencia» de un catálogo de 300 —el número equivocado que el
  // comentario de arriba quería evitar—. Se piden las que falten, y mientras
  // falte alguna los contadores no se enseñan a medias: enseñan «…».
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = productos;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const catalogoCompleto = !productos.isLoading && !productos.isError && !hasNextPage;
  const todosLosProductos = productos.data?.pages.flatMap((p) => p.items) ?? [];
  const bajoMinimo = useQuery({
    queryKey: ["inv-bajos", empresa.id],
    queryFn: () => llamar<{ items: unknown[] }>("/v1/inventory/low-stock"),
  });

  const fisicos = todosLosProductos.filter((p) => p.kind === "good");
  const conExistencia = fisicos.filter(
    (p) => compararImportes(p.stock_quantity ?? "0", "0") > 0,
  ).length;
  const sinExistencia = fisicos.length - conExistencia;

  const pestanas = [
    ["existencias", "Existencias"],
    ["movimientos", "Movimientos"],
  ] as const;

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Inventario</h1>

      <div className="grid gap-3 sm:grid-cols-3">
        <Contador
          icono={PackageCheck}
          titulo="Con existencia"
          valor={catalogoCompleto ? String(conExistencia) : productos.isError ? "—" : "…"}
        />
        <Contador
          icono={TriangleAlert}
          titulo="Por agotarse"
          valor={
            bajoMinimo.data ? String(bajoMinimo.data.items.length) : bajoMinimo.isError ? "—" : "…"
          }
          alerta={(bajoMinimo.data?.items.length ?? 0) > 0}
        />
        <Contador
          icono={PackageX}
          titulo="Sin existencia"
          valor={catalogoCompleto ? String(sinExistencia) : productos.isError ? "—" : "…"}
          alerta={catalogoCompleto && sinExistencia > 0}
        />
      </div>
      {bajoMinimo.isError && (
        <p role="alert" className="text-[0.85rem] text-warning-soft-foreground">
          No se pudo saber qué está por agotarse: {errorDePersona(bajoMinimo.error)}{" "}
          <button type="button" className="underline" onClick={() => void bajoMinimo.refetch()}>
            Reintentar
          </button>
        </p>
      )}

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

      <div className="flex gap-1 border-b border-border" role="tablist" aria-label="Qué ver">
        {pestanas.map(([clave, etiqueta]) => (
          <button
            key={clave}
            id={`inv-tab-${clave}`}
            role="tab"
            aria-selected={pestana === clave}
            aria-controls={`inv-panel-${clave}`}
            tabIndex={pestana === clave ? 0 : -1}
            onClick={() => setPestana(clave)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              const otra = clave === "existencias" ? "movimientos" : "existencias";
              setPestana(otra);
              document.getElementById(`inv-tab-${otra}`)?.focus();
            }}
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
        <div role="tabpanel" id="inv-panel-existencias" aria-labelledby="inv-tab-existencias">
          {productos.isError ? (
            <ErrorDeLista error={productos.error} onReintentar={() => void productos.refetch()} />
          ) : (
            <Existencias productos={fisicos} cargando={productos.isLoading} />
          )}
        </div>
      ) : (
        <div role="tabpanel" id="inv-panel-movimientos" aria-labelledby="inv-tab-movimientos">
          <Movimientos productoFiltro={productoFiltro} productos={todosLosProductos} />
        </div>
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
        Sin productos físicos todavía. Se agregan en Administración → Productos.
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
  // PAGINADO (auditoría 2026-09-11): antes `per_page=50` y los movimientos
  // anteriores no existían para la pantalla. Se acumulan páginas con «Mostrar
  // más» y se dice cuántos hay de cuántos.
  const movs = useInfiniteQuery({
    queryKey: ["inv-movs", empresa.id, productoFiltro],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      llamar<{ items: Movimiento[]; total: number }>(
        `/v1/inventory/moves?per_page=${MOVS_POR_PAGINA}&page=${pageParam}${
          productoFiltro === null ? "" : `&product_id=${encodeURIComponent(productoFiltro)}`
        }`,
      ),
    getNextPageParam: (ultima, todas) => {
      const cargados = todas.reduce((n, p) => n + p.items.length, 0);
      return cargados < ultima.total ? todas.length + 1 : undefined;
    },
  });
  const nombreDe = useMemo(() => {
    const m = new Map(productos.map((p) => [p.id, p.name]));
    // Un producto INACTIVO no está en el catálogo activo: vale lo que traiga
    // el movimiento (nombre o, si no, el código), y en último caso «Producto».
    return (mov: Movimiento) => {
      const activo = m.get(mov.product_id);
      if (activo !== undefined) return activo;
      if (mov.product_name != null && mov.product_name !== "") return mov.product_name;
      if (mov.product_sku != null && mov.product_sku !== "") return `Producto ${mov.product_sku}`;
      return "Producto";
    };
  }, [productos]);

  const items = movs.data?.pages.flatMap((p) => p.items) ?? [];
  const total = movs.data?.pages[0]?.total ?? 0;
  if (movs.isPending) return <p className="text-muted-foreground">Cargando…</p>;
  if (movs.isError) {
    return <ErrorDeLista error={movs.error} onReintentar={() => void movs.refetch()} />;
  }
  if (items.length === 0) {
    return <p className="py-8 text-center text-muted-foreground">Todavía no hay movimientos.</p>;
  }
  return (
    <>
      <div className="divide-y divide-border rounded-md border border-border bg-surface">
        {items.map((m) => (
          <div key={m.id} className="flex items-center gap-3 px-3 py-2.5 text-[0.9rem]">
            <span className="w-24 shrink-0 text-[0.82rem] text-muted-foreground">
              {fechaRelativa(m.occurred_at)}
            </span>
            <span className="min-w-0 flex-1 truncate">
              <strong>{VERBO_MOV[m.kind] ?? m.kind}</strong> · {nombreDe(m)}
              {m.reason !== null && <span className="text-muted-foreground"> — {m.reason}</span>}
            </span>
            <span className="shrink-0 tabular-nums">{mostrarCantidad(m.quantity)}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3 pt-3">
        <span className="text-[0.86rem] text-muted-foreground">
          Mostrando {items.length} de {total}
        </span>
        {movs.hasNextPage && (
          <Button
            variant="secondary"
            onClick={() => void movs.fetchNextPage()}
            disabled={movs.isFetchingNextPage}
          >
            {movs.isFetchingNextPage ? "Cargando…" : "Mostrar más"}
          </Button>
        )}
      </div>
    </>
  );
}
