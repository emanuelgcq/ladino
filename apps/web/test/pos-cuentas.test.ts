import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { crearSincronizador, type CuentaNube } from "../src/pos-cuentas.js";

/**
 * El SINCRONIZADOR de cuentas abiertas del POS.
 *
 * Cambió de semántica el 2026-09-10 (orden del dueño): subía en CADA toque, y
 * con la base a un segundo de distancia eso convertía escribir un carrito de
 * diez renglones en diez viajes de red. Ahora espera a que el carrito se quede
 * quieto. Lo que este fichero vigila es justo lo que puede romperse al
 * diferir: que se suba UNA vez con lo ÚLTIMO, que `vaciar()` no espere, y que
 * borrar no se quede en la cola detrás de una subida.
 *
 * El seguro antiapagón NO está aquí: es `escribirCuentasLocales`, síncrono y
 * sin red, que sigue corriendo en cada toque.
 */
const cuenta = (id: string, n: number): CuentaNube => ({
  id,
  label: `Cuenta ${n}`,
  customer_id: null,
  lines: Array.from({ length: n }, (_, i) => ({ product_id: `p${i}`, qty: "1" })),
});

describe("crearSincronizador", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("NO sube en el toque: espera a que el carrito se quede quieto", async () => {
    const subir = vi.fn().mockResolvedValue(undefined);
    const s = crearSincronizador(subir, vi.fn().mockResolvedValue(undefined), 4000);

    s.guardar(cuenta("a", 1));
    await vi.advanceTimersByTimeAsync(3000);
    expect(subir).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    expect(subir).toHaveBeenCalledTimes(1);
  });

  it("diez toques seguidos son UNA subida, con el último estado", async () => {
    const subir = vi.fn().mockResolvedValue(undefined);
    const s = crearSincronizador(subir, vi.fn().mockResolvedValue(undefined), 4000);

    for (let n = 1; n <= 10; n++) {
      s.guardar(cuenta("a", n));
      await vi.advanceTimersByTimeAsync(300); // la cajera teclea rápido
    }
    await vi.advanceTimersByTimeAsync(4100);

    expect(subir).toHaveBeenCalledTimes(1);
    // Lo que viaja es el carrito COMPLETO, no el primer renglón.
    expect((subir.mock.calls[0]![0] as CuentaNube).lines).toHaveLength(10);
  });

  it("`vaciar()` sube YA lo pendiente, sin esperar el reloj", async () => {
    const subir = vi.fn().mockResolvedValue(undefined);
    const s = crearSincronizador(subir, vi.fn().mockResolvedValue(undefined), 4000);

    s.guardar(cuenta("a", 3));
    s.vaciar();
    await vi.advanceTimersByTimeAsync(0);

    expect(subir).toHaveBeenCalledTimes(1);
    expect((subir.mock.calls[0]![0] as CuentaNube).lines).toHaveLength(3);
  });

  it("borrar NO espera, y gana a la subida pendiente de esa cuenta", async () => {
    const subir = vi.fn().mockResolvedValue(undefined);
    const bajar = vi.fn().mockResolvedValue(undefined);
    const s = crearSincronizador(subir, bajar, 4000);

    s.guardar(cuenta("a", 2));
    s.borrar("a");
    await vi.advanceTimersByTimeAsync(0);

    expect(bajar).toHaveBeenCalledWith("a");
    // No se sube lo que va a morir, ni siquiera cuando venza el temporizador.
    await vi.advanceTimersByTimeAsync(5000);
    expect(subir).not.toHaveBeenCalled();
  });

  it("dos cuentas distintas tienen su propio reloj", async () => {
    const subir = vi.fn().mockResolvedValue(undefined);
    const s = crearSincronizador(subir, vi.fn().mockResolvedValue(undefined), 4000);

    s.guardar(cuenta("a", 1));
    await vi.advanceTimersByTimeAsync(3000);
    s.guardar(cuenta("b", 1));
    await vi.advanceTimersByTimeAsync(1500); // vence la de «a», no la de «b»

    expect(subir).toHaveBeenCalledTimes(1);
    expect((subir.mock.calls[0]![0] as CuentaNube).id).toBe("a");

    await vi.advanceTimersByTimeAsync(3000);
    expect(subir).toHaveBeenCalledTimes(2);
  });
});
