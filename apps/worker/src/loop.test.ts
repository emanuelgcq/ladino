import { describe, expect, it } from "vitest";
import { crearBucle, type DepsBucle } from "./loop.js";

/**
 * R-10 cerrado: la máquina del bucle, probada frase a frase.
 *
 * Lo que estos tests protegen no es el consumo del outbox (eso ya tiene los
 * suyos): es la COMPOSICIÓN — el latido que el healthcheck de Docker lee, el
 * suicidio ruidoso que sustituye al reinicio que Docker NO hace sobre un
 * contenedor `unhealthy` (F-11), y el plazo que convierte un ciclo colgado en
 * un fallo contable en vez de en un silencio eterno.
 */
function deps(sobre: Partial<DepsBucle> & Pick<DepsBucle, "ciclo">): {
  d: DepsBucle;
  latidos: () => number;
  salidas: () => number[];
} {
  const latidos: number[] = [];
  const salidas: number[] = [];
  const d: DepsBucle = {
    latir: () => latidos.push(Date.now()),
    log: () => undefined,
    salir: (c) => salidas.push(c),
    dormir: () => Promise.resolve(),
    intervaloMs: 0,
    plazoCicloMs: 5_000,
    maxFallosSeguidos: 5,
    ...sobre,
  };
  return { d, latidos: () => latidos.length, salidas: () => salidas };
}

describe("crearBucle — la máquina del worker", () => {
  it("una vuelta sana LATE; el latido va después del veredicto, no antes", async () => {
    let vueltas = 0;
    const { d, latidos } = deps({
      ciclo: () => {
        vueltas += 1;
        return Promise.resolve();
      },
    });
    const bucle = crearBucle({
      ...d,
      dormir: () => {
        // Tras la tercera vuelta, parar: el test controla la duración.
        if (vueltas >= 3) bucle.parar();
        return Promise.resolve();
      },
    });
    await bucle.run();
    expect(vueltas).toBe(3);
    expect(latidos()).toBe(3);
  });

  it("una vuelta ROTA no late: el healthcheck debe ver el latido viejo", async () => {
    let vueltas = 0;
    const { d, latidos, salidas } = deps({
      ciclo: () => {
        vueltas += 1;
        return vueltas === 2 ? Promise.reject(new Error("lote roto")) : Promise.resolve();
      },
    });
    const bucle = crearBucle({
      ...d,
      dormir: () => {
        if (vueltas >= 3) bucle.parar();
        return Promise.resolve();
      },
    });
    await bucle.run();
    expect(vueltas).toBe(3);
    expect(latidos()).toBe(2); // la vuelta 2 falló y NO lató
    expect(salidas()).toEqual([]); // un fallo aislado no mata
  });

  it("al 5.º fallo SEGUIDO sale con código 1 — Docker reinicia procesos que salen, no unhealthy", async () => {
    const { d, salidas } = deps({ ciclo: () => Promise.reject(new Error("siempre roto")) });
    await crearBucle(d).run();
    expect(salidas()).toEqual([1]);
  });

  it("un éxito REINICIA el contador: 4 fallos + 1 sana + 4 fallos no es rendirse", async () => {
    let vueltas = 0;
    const { d, salidas } = deps({
      ciclo: () => {
        vueltas += 1;
        return vueltas === 5 ? Promise.resolve() : Promise.reject(new Error("intermitente"));
      },
    });
    const bucle = crearBucle({
      ...d,
      dormir: () => {
        if (vueltas >= 9) bucle.parar();
        return Promise.resolve();
      },
    });
    await bucle.run();
    // 4 fallos (1-4), sana (5), 4 fallos (6-9): nunca 5 seguidos.
    expect(vueltas).toBe(9);
    expect(salidas()).toEqual([]);
  });

  it("un ciclo COLGADO cuenta como fallo por el plazo, no como silencio", async () => {
    const { d, latidos, salidas } = deps({
      // Nunca resuelve: solo el plazo puede rescatar al bucle.
      ciclo: () => new Promise<void>(() => undefined),
      plazoCicloMs: 20,
      maxFallosSeguidos: 2,
    });
    await crearBucle(d).run();
    expect(latidos()).toBe(0);
    expect(salidas()).toEqual([1]);
  });

  it("parar() detiene el bucle sin salida forzada — el apagado de SIGTERM", async () => {
    let vueltas = 0;
    const { d, salidas } = deps({
      ciclo: () => {
        vueltas += 1;
        return Promise.resolve();
      },
    });
    const bucle = crearBucle({
      ...d,
      dormir: () => {
        bucle.parar();
        return Promise.resolve();
      },
    });
    await bucle.run();
    expect(vueltas).toBe(1);
    expect(salidas()).toEqual([]);
  });
});
