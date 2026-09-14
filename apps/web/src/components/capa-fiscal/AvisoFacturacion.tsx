import { Link } from "react-router";

/** La banda de la caja en modo recibos: vende con recibos, y cómo pasar a facturar. */
export function AvisoFacturacion(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-surface-muted/50 px-3 py-1.5 text-[0.82rem] text-muted-foreground">
      Estás vendiendo con recibos.{" "}
      <Link to="/empezar" className="text-accent-soft-foreground underline">
        Con tu RIF puedes facturar →
      </Link>
    </div>
  );
}
