import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useSesion } from "../../app/session.js";
import { AVISO_YA_FACTURAS } from "./textos.js";

/**
 * La banda de la caja en modo recibos: vende con recibos, y cómo pasar a facturar.
 *
 * M-06: el enlace lleva al paso de las facturas de /empezar (el cuarto; sin RIF se llama «Tus
 * recibos» y tiene «Ya puse mi RIF: activar facturas»), no al paso 1 «Tus productos».
 */
export function AvisoFacturacion(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-surface-muted/50 px-3 py-1.5 text-[0.82rem] text-muted-foreground">
      Estás vendiendo con recibos.{" "}
      <Link to="/empezar?paso=facturas" className="text-accent-soft-foreground underline">
        Con tu RIF puedes facturar →
      </Link>
    </div>
  );
}

/**
 * M-09: la caja de un negocio que PASÓ de recibos a facturas lo dice. Antes la banda de recibos
 * desaparecía y nada la sustituía. Cuándo se enseña lo decide el servidor (`invoicing_notice` de
 * `GET /v1/fiscal/setup`: 30 días y hasta la primera factura, lo que tarde más); aquí solo se
 * pinta. Comparte la consulta —y la caché— con `useModoDeVenta`.
 */
export function AvisoYaFacturas(): React.JSX.Element | null {
  const { empresa, llamar } = useSesion();
  const setup = useQuery({
    queryKey: ["empezar-fiscal", empresa.id],
    staleTime: 5 * 60_000,
    queryFn: () => llamar<{ invoicing_notice?: boolean }>("/v1/fiscal/setup"),
  });
  if (setup.data?.invoicing_notice !== true) return null;
  return (
    <div
      role="status"
      className="rounded-md border border-border bg-surface-muted/50 px-3 py-1.5 text-[0.82rem] text-muted-foreground"
    >
      {AVISO_YA_FACTURAS}
    </div>
  );
}
