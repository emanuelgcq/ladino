import { LlamadaApiError } from "./lib.js";

/**
 * LA LLAVE ES POR INTENTO (ADR-0076, RESPUESTA §2.9 — D-03, F-03, F-08, M-01).
 *
 * Una llave de idempotencia protege UN intento contra su propio reintento: la respuesta perdida
 * de un cobro que sí ocurrió. No es el nombre de la pantalla ni el de la cuenta. Antes, la llave
 * nacía una vez por pantalla (o era el id de la cuenta del POS): tras un rechazo, la persona
 * corregía un dato, el cuerpo cambiaba con la misma llave y el servidor respondía 409 durante 24 h
 * — «ya se registró con otros datos» sin haber registrado nada.
 *
 * La regla, en las dos direcciones:
 *   · un 4xx ES una respuesta: el servidor dijo que no, nada ocurrió → el próximo intento
 *     ESTRENA llave;
 *   · un fallo de red NO es respuesta (pudo ocurrir y perderse) → se CONSERVA la llave, y el
 *     reintento con el mismo cuerpo recibe la respuesta guardada, nunca un segundo efecto.
 *
 * La excepción que no es opcional: `IDEMPOTENCY_IN_PROGRESS` es un 409, pero dice que el intento
 * original SIGUE corriendo. Estrenar llave ahí lanzaría un segundo efecto en paralelo al primero.
 * Se conserva. Un 5xx también la conserva: el servidor dejó la reserva `failed` y el mismo cuerpo
 * se reintenta con la misma llave.
 */
export function debeEstrenarLlave(e: unknown): boolean {
  if (intentoAnteriorPudoQuedar(e)) return false;
  return (
    e instanceof LlamadaApiError &&
    e.status >= 400 &&
    e.status < 500 &&
    e.body.code !== "IDEMPOTENCY_IN_PROGRESS"
  );
}

/** Corre una llamada con la llave del intento actual y la estrena si la respuesta fue un 4xx. */
export async function conLlaveDeIntento<T>(
  llave: { current: string },
  llamada: (clave: string) => Promise<T>,
): Promise<T> {
  try {
    return await llamada(llave.current);
  } catch (e) {
    if (debeEstrenarLlave(e)) llave.current = crypto.randomUUID();
    throw e;
  }
}

/**
 * LA EXCEPCIÓN DEL DINERO (decidido por criterio, ADR-0076 — regla 4: nunca duplicar dinero).
 * `IDEMPOTENCY_BODY_MISMATCH` es un 4xx, pero si el servidor dice que el intento anterior con esa
 * llave quedó `completed` (o sigue `in_progress`), estrenar llave y reenviar podría registrar DOS
 * veces lo que ya se hizo: «tras un 4xx se estrena» no puede leerse así. La llave se conserva, la
 * persona revisa y decide. Con `failed`, nada quedó: se estrena. Alternativa: estrenar siempre.
 */
export function intentoAnteriorPudoQuedar(e: unknown): boolean {
  if (!(e instanceof LlamadaApiError) || e.body.code !== "IDEMPOTENCY_BODY_MISMATCH") return false;
  const previo = (e.body.details as { previous_status?: unknown } | undefined)?.previous_status;
  return previo === "completed" || previo === "in_progress";
}

/** El texto de reserva, solo si el servidor no mandó el suyo (una API anterior al despliegue). */
export const REVISA_EL_INTENTO_ANTERIOR =
  "El intento anterior pudo quedar registrado: revísalo antes de repetir.";

/**
 * Lo que la pantalla dice en ese caso: el `person_message` DEL SERVIDOR, que lo elige por
 * `previous_status` (ADR-0076 §12: «ya quedó registrada» no es lo mismo que «todavía se está
 * registrando»). La web no tiene texto propio para este código; el de reserva es para el hueco.
 */
export function textoDelIntentoAnterior(e: unknown): string {
  const delServidor = e instanceof LlamadaApiError ? (e.body.person_message ?? "").trim() : "";
  return delServidor === "" ? REVISA_EL_INTENTO_ANTERIOR : delServidor;
}
