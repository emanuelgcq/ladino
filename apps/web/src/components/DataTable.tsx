import { useMemo, useRef, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { cn } from "../ui/cn.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { Skeleton } from "../ui/card.js";
import { EmptyState, type EmptyStateProps } from "./EmptyState.js";

/**
 * DataTable — la tabla del sistema, una vez, para los 12 módulos.
 *
 * Sobre TanStack Table v8: columnas tipadas, sorting por cabecera, búsqueda
 * global opcional, paginación DE SERVIDOR (los endpoints ya la tienen — aquí
 * no se pagina en memoria lo que el servidor ya recortó), virtualización
 * activable para kardex/mayor, exportación CSV de lo visible, densidad
 * configurable y estados de carga/vacío/error integrados: una tabla jamás se
 * muestra en blanco sin decir por qué.
 */
export interface DataTableProps<T> {
  columns: ColumnDef<T, unknown>[];
  /** undefined = cargando (skeleton); [] = vacío (EmptyState). */
  data: T[] | undefined;
  error?: string | null;
  onRetry?: () => void;
  empty: Omit<EmptyStateProps, "className">;
  /** Paginación de servidor: total de filas + página actual (1-based). */
  pagination?: {
    total: number;
    page: number;
    perPage: number;
    onPageChange: (page: number) => void;
  };
  /** Búsqueda: contra el SERVIDOR si quien llama la conecta a su query. */
  search?: { value: string; onChange: (v: string) => void; placeholder?: string };
  /** Filtros y acciones propios de la pantalla, a la derecha de la búsqueda. */
  toolbar?: React.ReactNode;
  onRowClick?: (row: T) => void;
  /** Virtualización para listados largos sin paginar (kardex, mayor). */
  virtualized?: boolean;
  density?: "normal" | "compact";
  /** Exporta las filas visibles con los valores YA formateados en pantalla. */
  exportCsv?: { filename: string };
  getRowId?: (row: T) => string;
}

export function DataTable<T>({
  columns,
  data,
  error,
  onRetry,
  empty,
  pagination,
  search,
  toolbar,
  onRowClick,
  virtualized = false,
  density = "normal",
  exportCsv,
  getRowId,
}: DataTableProps<T>): React.JSX.Element {
  const [sorting, setSorting] = useState<SortingState>([]);
  const filas = useMemo(() => data ?? [], [data]);

  const table = useReactTable({
    data: filas,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    ...(getRowId === undefined ? {} : { getRowId }),
  });

  const alturaFila = density === "compact" ? 34 : 38;
  const contenedorRef = useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => contenedorRef.current,
    estimateSize: () => alturaFila,
    overscan: 12,
    enabled: virtualized,
  });

  function exportar(): void {
    if (exportCsv === undefined) return;
    const visibles = table.getVisibleLeafColumns();
    const escapar = (v: unknown): string => {
      // Solo primitivos: un objeto en una celda exportada sería `[object Object]`,
      // y una celda ilegible es peor que una vacía declarada.
      const s =
        typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "";
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const cabecera = visibles.map((c) => escapar(c.id)).join(",");
    const cuerpo = rows
      .map((r) => visibles.map((c) => escapar(r.getValue(c.id))).join(","))
      .join("\r\n");
    const blob = new Blob([`${cabecera}\r\n${cuerpo}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportCsv.filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const hayBarra = search !== undefined || toolbar !== undefined || exportCsv !== undefined;

  return (
    <div className="rounded-md border border-border bg-surface shadow-soft">
      {hayBarra && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          {search !== undefined && (
            <Input
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              placeholder={search.placeholder ?? "Buscar…"}
              className="h-7 w-56"
              aria-label={search.placeholder ?? "Buscar"}
            />
          )}
          {toolbar}
          <div className="flex-1" />
          {exportCsv !== undefined && (
            <Button variant="ghost" size="sm" onClick={exportar} disabled={rows.length === 0}>
              <Download /> CSV
            </Button>
          )}
        </div>
      )}

      {error != null && error !== "" ? (
        <div className="px-4 py-8 text-center">
          <p className="text-[0.9rem] text-destructive-soft-foreground">{error}</p>
          {onRetry !== undefined && (
            <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
              Reintentar
            </Button>
          )}
        </div>
      ) : data === undefined ? (
        <div className="space-y-2 p-3" aria-busy="true" aria-label="Cargando">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-11/12" />
          <Skeleton className="h-7 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState {...empty} className="border-0 shadow-none" />
      ) : (
        <div
          ref={contenedorRef}
          className={cn("w-full overflow-x-auto", virtualized && "max-h-[32rem] overflow-y-auto")}
        >
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10 bg-surface-muted">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id} className="border-b border-border">
                  {hg.headers.map((h) => {
                    const orden = h.column.getIsSorted();
                    const puedeOrdenar = h.column.getCanSort();
                    return (
                      <th
                        key={h.id}
                        className="h-8 whitespace-nowrap px-2.5 text-left text-[0.8rem] font-medium text-muted-foreground first:pl-3 last:pr-3"
                      >
                        {h.isPlaceholder ? null : puedeOrdenar ? (
                          <button
                            className="inline-flex items-center gap-1 hover:text-foreground"
                            onClick={h.column.getToggleSortingHandler()}
                            aria-label={`Ordenar por ${h.column.id}`}
                          >
                            {flexRender(h.column.columnDef.header, h.getContext())}
                            {orden === "asc" ? (
                              <ArrowUp className="size-3" />
                            ) : orden === "desc" ? (
                              <ArrowDown className="size-3" />
                            ) : (
                              <ArrowUpDown className="size-3 opacity-40" />
                            )}
                          </button>
                        ) : (
                          flexRender(h.column.columnDef.header, h.getContext())
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            {virtualized ? (
              <tbody
                style={{ height: virtualizer.getTotalSize(), position: "relative" }}
                className="block"
              >
                {virtualizer.getVirtualItems().map((vi) => {
                  const row = rows[vi.index];
                  if (row === undefined) return null;
                  return (
                    <FilaTabla
                      key={row.id}
                      row={row}
                      onRowClick={onRowClick}
                      density={density}
                      style={{
                        position: "absolute",
                        top: 0,
                        transform: `translateY(${vi.start}px)`,
                        width: "100%",
                        display: "table",
                        tableLayout: "fixed",
                      }}
                    />
                  );
                })}
              </tbody>
            ) : (
              <tbody>
                {rows.map((row) => (
                  <FilaTabla key={row.id} row={row} onRowClick={onRowClick} density={density} />
                ))}
              </tbody>
            )}
          </table>
        </div>
      )}

      {pagination !== undefined && pagination.total > pagination.perPage && (
        <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-[0.82rem] text-muted-foreground">
          <span>
            {pagination.total} filas · página {pagination.page} de{" "}
            {Math.max(1, Math.ceil(pagination.total / pagination.perPage))}
          </span>
          <span className="flex gap-1">
            <Button
              variant="ghost"
              size="iconSm"
              disabled={pagination.page <= 1}
              onClick={() => pagination.onPageChange(pagination.page - 1)}
              aria-label="Página anterior"
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="ghost"
              size="iconSm"
              disabled={pagination.page >= Math.ceil(pagination.total / pagination.perPage)}
              onClick={() => pagination.onPageChange(pagination.page + 1)}
              aria-label="Página siguiente"
            >
              <ChevronRight />
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}

function FilaTabla<T>({
  row,
  onRowClick,
  density,
  style,
}: {
  row: Row<T>;
  onRowClick?: ((row: T) => void) | undefined;
  density: "normal" | "compact";
  style?: React.CSSProperties;
}): React.JSX.Element {
  const clicable = onRowClick !== undefined;
  return (
    <tr
      style={style}
      className={cn(
        "border-b border-border transition-colors last:border-0 hover:bg-surface-muted/60",
        clicable && "cursor-pointer",
      )}
      onClick={clicable ? () => onRowClick(row.original) : undefined}
      // Fila clicable navegable por teclado: la accesibilidad no se rompe.
      tabIndex={clicable ? 0 : undefined}
      onKeyDown={
        clicable
          ? (e) => {
              if (e.key === "Enter") onRowClick(row.original);
            }
          : undefined
      }
    >
      {row.getVisibleCells().map((cell) => (
        <td
          key={cell.id}
          className={cn(
            "whitespace-nowrap px-2.5 align-middle text-[0.88rem] first:pl-3 last:pr-3",
            density === "compact" ? "py-1.5" : "py-2",
          )}
        >
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </td>
      ))}
    </tr>
  );
}
