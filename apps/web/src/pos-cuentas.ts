/**
 * CUENTAS ABIERTAS del POS: la persistencia de la venta en armado.
 *
 * Dos capas, cada una contra un desastre distinto:
 *
 *   1. el DISCO de la caja (localStorage), escrito SÍNCRONO en cada toque —
 *      es la capa antiapagón: cuando se va la luz se va también el módem,
 *      así que la nube no habría alcanzado de todas formas;
 *   2. la NUBE (PUT /v1/pos/carts/:id), disparada AL INSTANTE pero
 *      coalescida por cuenta: si ya hay un envío en vuelo, el estado nuevo
 *      espera a que aterrice y se manda UNA vez — cero timers, cero spam,
 *      y siempre acaba mandado lo último.
 *
 * Lo que viaja a la nube es la INTENCIÓN (producto y cantidad, cliente,
 * etiqueta) — nunca precios: al retomar, el POS recotiza a la tasa de HOY.
 * El nombre del producto y la marca de «venta sin identificar» son ayudas
 * locales de pantalla; si se restauran de la nube, el nombre lo trae la
 * cotización y la decisión se vuelve a tomar.
 */

export interface ClientePos {
  id: string;
  legal_name: string;
  tax_id: string | null;
  phone: string | null;
}

export interface LineaCuenta {
  product_id: string;
  qty: number;
  /** El nombre para pintar al instante; si falta, lo dice la cotización. */
  nombre: string;
  /**
   * La existencia del producto AL AGREGARLO (solo bienes): el tope local de
   * la caja — no se vende lo que no hay. Ayuda de pantalla: no viaja a la
   * nube y el control de verdad sigue siendo el kardex del servidor.
   */
  existencia?: string | null;
}

export interface CuentaAbierta {
  id: string;
  /** La etiqueta base («Cuenta 2»); con cliente puesto, se pinta su nombre. */
  etiqueta: string;
  cliente: ClientePos | null;
  sinIdentificar: boolean;
  lineas: LineaCuenta[];
}

/** Lo que la nube guarda de cada cuenta (el contrato del PUT). */
export interface CuentaNube {
  id: string;
  label: string;
  customer_id: string | null;
  lines: { product_id: string; qty: string }[];
}

// ── La capa local: síncrona, tragándose sus errores ──────────────────────────
// localStorage puede no existir (modo privado, datos bloqueados): la caja
// sigue vendiendo igual, solo que sin seguro antiapagón.

const clave = (companyId: string): string => `ladino.pos.cuentas.${companyId}`;

export function leerCuentasLocales(companyId: string): CuentaAbierta[] {
  try {
    const crudo = localStorage.getItem(clave(companyId));
    if (crudo === null) return [];
    const lista: unknown = JSON.parse(crudo);
    if (!Array.isArray(lista)) return [];
    return lista.filter(
      (c): c is CuentaAbierta =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as CuentaAbierta).id === "string" &&
        typeof (c as CuentaAbierta).etiqueta === "string" &&
        Array.isArray((c as CuentaAbierta).lineas),
    );
  } catch {
    return [];
  }
}

export function escribirCuentasLocales(companyId: string, cuentas: CuentaAbierta[]): void {
  try {
    localStorage.setItem(clave(companyId), JSON.stringify(cuentas));
  } catch {
    // Sin disco no hay seguro local; la nube sigue recibiendo lo suyo.
  }
}

// ── La capa de nube: DIFERIDA, con coalescencia por cuenta ───────────────────
//
// Antes subía en CADA toque. Con la base a un segundo de distancia, eso
// convertía escribir un carrito de diez renglones en diez viajes de red, y la
// caja pasaba más tiempo hablando con la nube que vendiendo (2026-09-10).
//
// Ahora la nube recibe el carrito cuando se queda QUIETO (`ESPERA_NUBE`), o
// de golpe en los momentos que importan — cambiar de cuenta, cobrar, cerrar
// la pantalla — vía `vaciar()`. Lo que NO cambia es el seguro de verdad: el
// disco de la caja se escribe en cada toque, es síncrono y no cuesta red.
// La nube nunca fue la capa antiapagón; es la que deja ver el carrito desde
// otra caja.

/** Cuánto se espera a que el carrito se quede quieto antes de subirlo. */
const ESPERA_NUBE = 4000;

export interface SincronizadorNube {
  guardar: (cuenta: CuentaNube) => void;
  borrar: (id: string) => void;
  /** Sube YA lo pendiente: al cambiar de cuenta, al cobrar, al salir. */
  vaciar: () => void;
}

export function crearSincronizador(
  subir: (cuenta: CuentaNube) => Promise<void>,
  bajar: (id: string) => Promise<void>,
  esperaMs: number = ESPERA_NUBE,
): SincronizadorNube {
  const enVuelo = new Set<string>();
  const sucias = new Map<string, CuentaNube>();
  const porBorrar = new Set<string>();
  const temporizadores = new Map<string, ReturnType<typeof setTimeout>>();

  function programar(id: string): void {
    const previo = temporizadores.get(id);
    if (previo !== undefined) clearTimeout(previo);
    temporizadores.set(
      id,
      setTimeout(() => {
        temporizadores.delete(id);
        void volar(id);
      }, esperaMs),
    );
  }

  async function volar(id: string): Promise<void> {
    if (enVuelo.has(id)) return; // ya hay uno en el aire: el estado quedó anotado
    enVuelo.add(id);
    try {
      while (sucias.has(id) || porBorrar.has(id)) {
        if (porBorrar.has(id)) {
          porBorrar.delete(id);
          sucias.delete(id); // borrar gana: no se sube lo que va a morir
          try {
            await bajar(id);
          } catch {
            // Sin red no se insiste: la purga del servidor la alcanzará.
          }
        } else {
          const cuenta = sucias.get(id)!;
          sucias.delete(id);
          try {
            await subir(cuenta);
          } catch {
            // Sin red, la copia local manda. Lo que falló se REENCOLA (si no
            // llegó un estado más nuevo mientras tanto) y se sale del bucle:
            // el próximo toque o `vaciar()` lo vuelve a intentar. Antes se
            // descartaba y una cuenta podía no llegar nunca a la nube
            // (auditoría 2026-09-11). Reintentar en caliente sería un bucle.
            if (!sucias.has(id)) sucias.set(id, cuenta);
            break;
          }
        }
      }
    } finally {
      enVuelo.delete(id);
    }
  }

  return {
    guardar(cuenta: CuentaNube): void {
      sucias.set(cuenta.id, cuenta);
      programar(cuenta.id);
    },
    /** Borrar NO espera: una cuenta que muere se retira de la nube ya. */
    borrar(id: string): void {
      const previo = temporizadores.get(id);
      if (previo !== undefined) clearTimeout(previo);
      temporizadores.delete(id);
      porBorrar.add(id);
      sucias.delete(id);
      void volar(id);
    },
    vaciar(): void {
      for (const [id, t] of temporizadores) {
        clearTimeout(t);
        temporizadores.delete(id);
      }
      // TODO lo pendiente, tenga temporizador o no: lo reencolado por un
      // fallo de red ya no tiene timer y también sale ahora.
      for (const id of new Set([...sucias.keys(), ...porBorrar])) void volar(id);
    },
  };
}

/** La cuenta de pantalla, reducida a lo que viaja (la intención). */
export function aNube(cuenta: CuentaAbierta): CuentaNube {
  // El nombre legal puede ser más largo que la etiqueta que el servidor
  // acepta (80): se recorta — es un rótulo de ficha, no un dato fiscal.
  const etiqueta = (cuenta.cliente?.legal_name.trim() || cuenta.etiqueta).slice(0, 80).trim();
  return {
    id: cuenta.id,
    label: etiqueta === "" ? cuenta.etiqueta : etiqueta,
    customer_id: cuenta.cliente?.id ?? null,
    lines: cuenta.lineas.map((l) => ({ product_id: l.product_id, qty: String(l.qty) })),
  };
}

/** La etiqueta libre más baja: «Cuenta 1», «Cuenta 2»… sin repetir. */
export function siguienteEtiqueta(cuentas: CuentaAbierta[]): string {
  const usadas = new Set(cuentas.map((c) => c.etiqueta));
  for (let n = 1; ; n += 1) {
    const candidata = `Cuenta ${String(n)}`;
    if (!usadas.has(candidata)) return candidata;
  }
}
