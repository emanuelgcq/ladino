import type { Context, Next } from "hono";

/**
 * Plazo máximo por petición. Si el handler no responde a tiempo, el cliente
 * recibe 504 `GATEWAY_TIMEOUT`; el handler sigue corriendo hasta terminar (no
 * hay forma portable de abortarlo) y su respuesta se descarta.
 *
 * Existe por la auditoría de S0.6a (F-10): el reaper de idempotencia libera
 * claves `in_progress` de más de 15 min, y sin un tope de petición «sigue en
 * curso a los 15 minutos» era alcanzable — la clave se liberaba con la
 * operación viva, el cliente reintentaba y dos ejecuciones competían. Con
 * este plazo (30 s por defecto) ninguna petición puede seguir viva cuando el
 * reaper mira. La relación 30 s ≪ 15 min es el invariante; está escrita en
 * config.ts junto a la cifra.
 *
 * No se usa `hono/timeout` porque lanza `HTTPException`, que nuestro
 * `onError` no mapea a un `code` estable del catálogo.
 */
export function timeoutMiddleware(ms: number) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    const plazo = new Promise<"timeout">((resolve) => {
      temporizador = setTimeout(() => resolve("timeout"), ms);
    });
    const resultado = await Promise.race([next().then(() => "ok" as const), plazo]);
    clearTimeout(temporizador);
    if (resultado === "timeout") {
      console.error(
        JSON.stringify({
          nivel: "error",
          evento: "api.request_timeout",
          ms,
          method: c.req.method,
          path: c.req.path,
        }),
      );
      return c.json(
        { code: "GATEWAY_TIMEOUT", message: `La petición superó el plazo de ${ms} ms.` },
        504,
      );
    }
  };
}
