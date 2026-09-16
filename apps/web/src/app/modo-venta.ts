import { useQuery } from "@tanstack/react-query";
import { useSesion } from "./session.js";
import { tieneRif } from "./rif.js";

export { tieneRif } from "./rif.js";

/**
 * EL MODO DE VENTA DE LA EMPRESA (migración 54): facturas, recibos o ninguno.
 *
 * La web NO lo deduce del nombre del régimen: lo lee de `GET /v1/fiscal/setup`,
 * que lo toma de `platform.sales_mode_at`, la única definición (el pgTAP 054 la
 * compara contra el trigger de emisión). Antes cuatro pantallas comparaban
 * `current_regime === "sin_facturacion"` por su cuenta.
 *
 * EL MODO ESCONDE, EL ROL MUESTRA: este modo decide si la capa fiscal existe
 * para ESTA empresa (para todos sus usuarios). Qué ve cada persona dentro de lo
 * que existe lo sigue decidiendo su permiso. Los dos filtros no se mezclan.
 */
export type ModoDeVenta = "facturas" | "recibos" | "ninguno";

export interface SetupFiscalBasico {
  current_regime: string | null;
  sales_mode: ModoDeVenta;
}

export function useModoDeVenta(): { modo: ModoDeVenta | null; cargando: boolean } {
  const { empresa, llamar } = useSesion();
  const q = useQuery({
    queryKey: ["empezar-fiscal", empresa.id],
    staleTime: 5 * 60_000,
    queryFn: () => llamar<SetupFiscalBasico>("/v1/fiscal/setup"),
  });
  return { modo: q.data?.sales_mode ?? null, cargando: q.isPending };
}

/** Vende con recibos: la capa fiscal no existe para esta empresa. */
export function esModoRecibos(modo: ModoDeVenta | null): boolean {
  return modo === "recibos";
}

/**
 * ¿Esta empresa factura? Es decir: ¿tiene RIF? (la regla, en ./rif.ts). Con RIF se ve todo lo
 * fiscal; sin RIF, recibos y lenguaje sencillo.
 */
export function useConFacturas(): boolean {
  const { empresa } = useSesion();
  return tieneRif(empresa);
}
