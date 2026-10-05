import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";

/**
 * UNA ACCIÓN PEDIDA POR LA DIRECCIÓN (P-06, ADR-0081): la paleta lleva a `/clientes?accion=nuevo`
 * o a `/dinero?accion=cerrar-caja`, y la pantalla de destino abre lo que se pidió.
 *
 * `lista` dice cuándo la pantalla ya puede atenderla (por ejemplo, con sus cuentas cargadas). El
 * parámetro se quita al atenderla: recargar la página o volver atrás no reabre el diálogo. Si la
 * pantalla decide no abrir nada (`alLlegar` no hace nada porque el rol no puede), la persona se
 * queda en la pantalla, que es donde vive el botón.
 */
export function useAccionPedida(nombre: string, lista: boolean, alLlegar: () => void): void {
  const [parametros, setParametros] = useSearchParams();
  const pedida = parametros.get("accion") === nombre;
  // Siempre la última: lo que dispara es que la acción se pida y la pantalla esté lista.
  const atender = useRef(alLlegar);
  atender.current = alLlegar;
  useEffect(() => {
    if (!pedida || !lista) return;
    atender.current();
    setParametros(
      (antes) => {
        const sin = new URLSearchParams(antes);
        sin.delete("accion");
        return sin;
      },
      { replace: true },
    );
  }, [pedida, lista, setParametros]);
}
