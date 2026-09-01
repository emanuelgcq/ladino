/**
 * El BUCLE del worker, separado de su cableado (R-10).
 *
 * `main.ts` compone: sql real, transmisor real, fichero de latido real,
 * `process.exit` real. Esto de aquí es la MÁQUINA: vuelta → plazo → latido si
 * la vuelta fue sana → contador de fallos seguidos → suicidio ruidoso al
 * quinto. Con las dependencias inyectadas, cada una de esas frases es un test
 * en vez de una esperanza.
 *
 * El latido lo escribe EL BUCLE y solo tras una vuelta sana — no la vuelta por
 * dentro. Es la semántica que el healthcheck de Docker necesita: un latido
 * fresco significa «el ciclo completo terminó bien hace poco», nunca «el
 * proceso vive aunque todo falle».
 */
export interface DepsBucle {
  /** Una vuelta completa: mantenimiento si toca + lote del outbox. */
  readonly ciclo: () => Promise<void>;
  /** Escribe el latido que lee el healthcheck. Solo se llama tras vuelta sana. */
  readonly latir: () => void;
  readonly log: (nivel: "info" | "error", evento: string, extra?: Record<string, unknown>) => void;
  /**
   * Salida RUIDOSA del proceso. Docker no reinicia un contenedor `unhealthy`;
   * reinicia uno que SALIÓ (F-11). Por eso el bucle se mata en vez de quedarse
   * enfermo esperando a un enfermero que no existe.
   */
  readonly salir: (codigo: number) => void;
  readonly dormir: (ms: number) => Promise<void>;
  readonly intervaloMs: number;
  readonly plazoCicloMs: number;
  readonly maxFallosSeguidos: number;
}

export interface Bucle {
  /** Corre hasta `parar()` o hasta el suicidio por fallos seguidos. */
  readonly run: () => Promise<void>;
  readonly parar: () => void;
}

function conPlazo<T>(p: Promise<T>, ms: number): Promise<T> {
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      temporizador = setTimeout(() => reject(new Error(`ciclo sin terminar en ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(temporizador));
}

export function crearBucle(deps: DepsBucle): Bucle {
  let parando = false;
  let fallosSeguidos = 0;

  async function run(): Promise<void> {
    while (!parando) {
      try {
        await conPlazo(deps.ciclo(), deps.plazoCicloMs);
        // El orden importa: primero se sabe que la vuelta fue sana, LUEGO se
        // late. Un latido antes del veredicto convertiría el healthcheck en
        // un detector de que el reloj funciona.
        deps.latir();
        fallosSeguidos = 0;
      } catch (e) {
        fallosSeguidos += 1;
        deps.log("error", "worker.ciclo_failed", { fallosSeguidos, error: String(e) });
        if (fallosSeguidos >= deps.maxFallosSeguidos) {
          deps.log("error", "worker.giving_up", { fallosSeguidos });
          deps.salir(1);
          return;
        }
      }
      if (!parando) await deps.dormir(deps.intervaloMs);
    }
  }

  return {
    run,
    parar: () => {
      parando = true;
    },
  };
}
