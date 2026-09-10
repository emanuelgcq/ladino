import { useEffect, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useSesion } from "../app/session.js";

/**
 * El nombre del cliente de un documento.
 *
 * `/v1/documents` devuelve `customer_id` y nada más, así que la columna
 * «Cliente» se resuelve contra el maestro. Se pedían 100 clientes y punto: con
 * 151 en la empresa, los documentos apuntaban casi siempre a los que quedaban
 * fuera de esa primera página alfabética y la columna entera decía «—» —no una
 * fila suelta: TODAS— mientras el dato estaba a un `id` de distancia.
 *
 * Se piden todas las páginas y se cachea 60 s bajo una clave compartida, así
 * que Ventas y el panel lo resuelven una sola vez entre los dos.
 *
 * PENDIENTE (contrato, requiere aprobación): lo correcto de verdad es que
 * `/v1/documents` traiga el nombre resuelto. Bajar el maestro entero para
 * pintar 25 filas se sostiene con 151 clientes, no con 5.000.
 */
export function useNombresDeCliente(): Map<string, string> {
  const { empresa, llamar } = useSesion();
  const clientes = useInfiniteQuery({
    queryKey: ["clientes-mapa", empresa.id],
    staleTime: 60_000,
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      llamar<{ items: { id: string; legal_name: string }[]; total: number }>(
        `/v1/customers?per_page=100&page=${String(pageParam)}`,
      ),
    getNextPageParam: (ultima, todas) => {
      const cargados = todas.reduce((n, p) => n + p.items.length, 0);
      return cargados < ultima.total ? todas.length + 1 : undefined;
    },
  });

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = clientes;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return useMemo(() => {
    const m = new Map<string, string>();
    for (const pagina of clientes.data?.pages ?? []) {
      for (const c of pagina.items) m.set(c.id, c.legal_name);
    }
    return m;
  }, [clientes.data]);
}
