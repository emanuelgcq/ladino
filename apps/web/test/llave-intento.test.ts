import { describe, expect, it, vi } from "vitest";

// lib.ts crea el cliente de Supabase al importarse; aquí solo interesa LlamadaApiError.
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: {} }) }));
import { LlamadaApiError } from "../src/lib.js";
import {
  conLlaveDeIntento,
  debeEstrenarLlave,
  intentoAnteriorPudoQuedar,
  REVISA_EL_INTENTO_ANTERIOR,
  textoDelIntentoAnterior,
} from "../src/llave-intento.js";

/**
 * ADR-0076 (D-03, F-03, F-08, M-01): la llave es por INTENTO. Tras un 4xx se estrena; tras un
 * fallo de red se conserva; y un 409 IDEMPOTENCY_IN_PROGRESS la conserva SIEMPRE, porque el
 * intento original sigue corriendo y estrenar llave lanzaría un segundo efecto en paralelo.
 */
const api = (status: number, code: string): LlamadaApiError =>
  new LlamadaApiError(status, { code, message: code });

describe("la llave por intento", () => {
  it("un 4xx estrena llave: el servidor dijo que no y nada ocurrió", () => {
    expect(debeEstrenarLlave(api(422, "VALIDATION_FAILED"))).toBe(true);
    expect(debeEstrenarLlave(api(409, "INSUFFICIENT_FUNDS"))).toBe(true);
    expect(debeEstrenarLlave(api(409, "IDEMPOTENCY_BODY_MISMATCH"))).toBe(true);
  });

  it("un fallo de red, un 5xx o un IN_PROGRESS la conservan: pudo ocurrir", () => {
    expect(debeEstrenarLlave(new TypeError("Failed to fetch"))).toBe(false);
    expect(debeEstrenarLlave(api(500, "INTERNAL"))).toBe(false);
    expect(debeEstrenarLlave(api(409, "IDEMPOTENCY_IN_PROGRESS"))).toBe(false);
  });

  it("conLlaveDeIntento: tras el 422 el reintento corregido viaja con OTRA llave (F-03)", async () => {
    const llave = { current: "k-1" };
    const usadas: string[] = [];
    await expect(
      conLlaveDeIntento(llave, (k) => {
        usadas.push(k);
        return Promise.reject(api(422, "VALIDATION_FAILED"));
      }),
    ).rejects.toBeInstanceOf(LlamadaApiError);
    await conLlaveDeIntento(llave, (k) => {
      usadas.push(k);
      return Promise.resolve("ok");
    });
    expect(usadas[0]).toBe("k-1");
    expect(usadas[1]).not.toBe("k-1");
  });

  it("conLlaveDeIntento: tras un fallo de red el reintento conserva la llave (no cobra dos veces)", async () => {
    const llave = { current: "k-1" };
    await expect(
      conLlaveDeIntento(llave, () => Promise.reject(new TypeError("Failed to fetch"))),
    ).rejects.toBeInstanceOf(TypeError);
    expect(llave.current).toBe("k-1");
  });

  // Decidido por criterio (ADR-0076, regla 4): un BODY_MISMATCH sobre un intento que quedó hecho
  // o sigue en curso NO estrena llave — reenviar con otra podría registrar dos veces lo mismo.
  const mismatch = (previo: string): LlamadaApiError =>
    new LlamadaApiError(409, {
      code: "IDEMPOTENCY_BODY_MISMATCH",
      message: "x",
      details: { previous_status: previo },
    });

  it("BODY_MISMATCH con el intento anterior completed o in_progress: se conserva la llave y se revisa", () => {
    for (const previo of ["completed", "in_progress"]) {
      expect(intentoAnteriorPudoQuedar(mismatch(previo))).toBe(true);
      expect(debeEstrenarLlave(mismatch(previo))).toBe(false);
    }
  });

  it("BODY_MISMATCH con el intento anterior failed: nada quedó, se estrena", () => {
    expect(intentoAnteriorPudoQuedar(mismatch("failed"))).toBe(false);
    expect(debeEstrenarLlave(mismatch("failed"))).toBe(true);
  });

  it("conLlaveDeIntento: tras un BODY_MISMATCH sobre un intento completado la llave NO cambia", async () => {
    const llave = { current: "k-1" };
    await expect(
      conLlaveDeIntento(llave, () => Promise.reject(mismatch("completed"))),
    ).rejects.toBeInstanceOf(LlamadaApiError);
    expect(llave.current).toBe("k-1");
  });

  // ADR-0076 §12: el texto del aviso es el del SERVIDOR (lo elige por previous_status); la web
  // no tiene uno propio para este código, salvo la reserva si el servidor no manda ninguno.
  it("el aviso dice el person_message del servidor, y solo sin él cae en el texto de reserva", () => {
    const delServidor = new LlamadaApiError(409, {
      code: "IDEMPOTENCY_BODY_MISMATCH",
      message: "x",
      person_message:
        "Esa operación todavía se está registrando. Espera un momento y revisa si quedó.",
      details: { previous_status: "in_progress" },
    });
    expect(textoDelIntentoAnterior(delServidor)).toBe(
      "Esa operación todavía se está registrando. Espera un momento y revisa si quedó.",
    );
    expect(textoDelIntentoAnterior(mismatch("completed"))).toBe(REVISA_EL_INTENTO_ANTERIOR);
  });
});
