import { mostrarImporte } from "../../money.js";

/**
 * Las filas «Sin impuesto» e «IVA» del carrito. Solo para una empresa que factura:
 * quien vende con recibos no repercute IVA y su precio ES el total (A4).
 */
export function FilasImpuesto({
  subtotal,
  impuesto,
  moneda,
}: {
  subtotal: string;
  impuesto: string;
  moneda: string;
}): React.JSX.Element {
  return (
    <>
      <div className="flex justify-between text-[0.88rem] text-muted-foreground">
        <span>Sin impuesto</span>
        <span className="tabular-nums">
          {mostrarImporte({ amount: subtotal, currency: moneda })}
        </span>
      </div>
      <div className="flex justify-between text-[0.88rem] text-muted-foreground">
        <span>IVA</span>
        <span className="tabular-nums">
          {mostrarImporte({ amount: impuesto, currency: moneda })}
        </span>
      </div>
    </>
  );
}
