import { Link } from "react-router";
import { textoDelIntentoAnterior } from "../llave-intento.js";

/**
 * El aviso de ADR-0076 (decidido por criterio): el servidor dice que el intento anterior con esa
 * llave quedó registrado o sigue en curso. La pantalla NO reintenta con otra llave —podría
 * registrar dos veces lo mismo—: lo dice y ofrece ir a verlo.
 */
export function RevisaIntentoAnterior({
  error,
  a,
  etiqueta,
  onIr,
}: {
  /** El rechazo del servidor: de ahí sale el texto (lo elige él por `previous_status`). */
  error: unknown;
  /** La ruta donde se ve lo registrado. */
  a?: string;
  etiqueta: string;
  /** O una acción (cerrar el diálogo y refrescar), si no hay ruta. */
  onIr?: () => void;
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-[0.88rem]"
    >
      <p className="font-medium text-warning-soft-foreground">{textoDelIntentoAnterior(error)}</p>
      {a !== undefined ? (
        <Link
          to={a}
          className="mt-1 inline-block font-medium text-accent-soft-foreground underline"
        >
          {etiqueta}
        </Link>
      ) : (
        <button
          type="button"
          className="mt-1 font-medium text-accent-soft-foreground underline"
          onClick={onIr}
        >
          {etiqueta}
        </button>
      )}
    </div>
  );
}
