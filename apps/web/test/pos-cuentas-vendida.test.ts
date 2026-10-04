import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { crearSincronizador, RechazoDefinitivo, type CuentaNube } from "../src/pos-cuentas.js";

/**
 * ADR-0076 (M-01, M-03): la cuenta cobrada no resucita desde la caja.
 *
 * El test de la h. 85 (pos-cuentas.test.ts) prueba `olvidar` a 1 s, con el temporizador sin
 * disparar. El recorrido del 2026-09-24 encontró los caminos que ese test no veía: el PUT que
 * YA salió cuando se pulsó Cobrar (M-01), y el PUT en vuelo que falla y se reencola (M-03).
 */
const cuenta = (id: string, n: number): CuentaNube => ({
  id,
  label: `Cuenta ${n}`,
  customer_id: null,
  lines: Array.from({ length: n }, (_, i) => ({ product_id: `p${i}`, qty: "1" })),
});

describe("la cuenta vendida en el sincronizador (ADR-0076)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("M-01: esperar() adelanta la subida pendiente y espera a que aterrice ANTES de cobrar", async () => {
    let soltar: () => void = () => undefined;
    const subir = vi.fn(
      () =>
        new Promise<void>((r) => {
          soltar = r;
        }),
    );
    const s = crearSincronizador(subir, vi.fn().mockResolvedValue(undefined), 4000);

    s.guardar(cuenta("c", 2));
    let aterrizo = false;
    const espera = s.esperar("c").then(() => {
      aterrizo = true;
    });
    // No esperó los 4 s: la subida salió al pulsar Cobrar.
    await vi.advanceTimersByTimeAsync(0);
    expect(subir).toHaveBeenCalledTimes(1);
    expect(aterrizo).toBe(false);
    soltar();
    await espera;
    expect(aterrizo).toBe(true);
    // Y el temporizador no la vuelve a subir después de la venta.
    await vi.advanceTimersByTimeAsync(5000);
    expect(subir).toHaveBeenCalledTimes(1);
  });

  it("M-01: esperar() también espera el PUT que YA estaba en vuelo cuando se pulsó Cobrar", async () => {
    let soltar: () => void = () => undefined;
    const subir = vi.fn(
      () =>
        new Promise<void>((r) => {
          soltar = r;
        }),
    );
    const s = crearSincronizador(subir, vi.fn().mockResolvedValue(undefined), 4000);
    s.guardar(cuenta("c", 1));
    await vi.advanceTimersByTimeAsync(4000); // la subida dispara sola
    expect(subir).toHaveBeenCalledTimes(1);

    let aterrizo = false;
    const espera = s.esperar("c").then(() => {
      aterrizo = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(aterrizo).toBe(false);
    soltar();
    await espera;
    expect(aterrizo).toBe(true);
  });

  it("M-03: el PUT en vuelo de una cuenta ya cobrada que falla sin red NO se reencola", async () => {
    let fallar: (e: unknown) => void = () => undefined;
    const subir = vi.fn(
      () =>
        new Promise<void>((_, rej) => {
          fallar = rej;
        }),
    );
    const s = crearSincronizador(subir, vi.fn().mockResolvedValue(undefined), 4000);
    s.guardar(cuenta("vendida", 2));
    await vi.advanceTimersByTimeAsync(4000); // sale el PUT
    s.olvidar("vendida"); // la venta respondió
    fallar(new TypeError("sin red"));
    await vi.advanceTimersByTimeAsync(0);
    s.vaciar(); // cambio de pestaña o salir de la caja
    await vi.advanceTimersByTimeAsync(0);
    expect(subir).toHaveBeenCalledTimes(1);
    // Ni un toque posterior la revive.
    s.guardar(cuenta("vendida", 3));
    await vi.advanceTimersByTimeAsync(5000);
    expect(subir).toHaveBeenCalledTimes(1);
  });

  it("la nube dice «ya se cobró» (409 POS_CART_SOLD): la caja la suelta, avisa y no la reintenta", async () => {
    const subir = vi.fn().mockRejectedValue(new RechazoDefinitivo(true));
    const alSaberVendida = vi.fn();
    const s = crearSincronizador(subir, vi.fn().mockResolvedValue(undefined), 4000, alSaberVendida);
    s.guardar(cuenta("de-otra-pestana", 1));
    await vi.advanceTimersByTimeAsync(4000);
    expect(alSaberVendida).toHaveBeenCalledWith("de-otra-pestana");
    s.vaciar();
    s.guardar(cuenta("de-otra-pestana", 2));
    await vi.advanceTimersByTimeAsync(5000);
    expect(subir).toHaveBeenCalledTimes(1);
  });

  it("un fallo de red NO es definitivo: lo pendiente se reencola, como siempre", async () => {
    const subir = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("sin red"))
      .mockResolvedValue(undefined);
    const s = crearSincronizador(subir, vi.fn().mockResolvedValue(undefined), 4000);
    s.guardar(cuenta("viva", 1));
    await vi.advanceTimersByTimeAsync(4000);
    s.vaciar();
    await vi.advanceTimersByTimeAsync(0);
    expect(subir).toHaveBeenCalledTimes(2);
  });
});
