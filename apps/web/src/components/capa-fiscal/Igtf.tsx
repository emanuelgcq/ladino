/**
 * Los textos del IGTF en la caja. Solo aparecen cuando el servidor dice que un
 * pago lo causó, y eso solo ocurre en una empresa que factura y lo activó (A7).
 */
export const SUFIJO_CON_IGTF = " con IGTF";

export function IncluyeIgtf({ importe }: { importe: string }): React.JSX.Element {
  return <p className="text-warning-soft-foreground">Incluye IGTF {importe}</p>;
}

export function IgtfCobradoEnVenta({ importe }: { importe: string }): React.JSX.Element {
  return (
    <p className="text-[0.88rem] text-muted-foreground tabular-nums">
      Se cobró además {importe} de IGTF por el pago en divisas.
    </p>
  );
}
