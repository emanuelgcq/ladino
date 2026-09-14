import { useSyncExternalStore } from "react";

/**
 * INSTALAR LADINO COMO APP (2026-09-14).
 *
 * Chrome en Android dispara `beforeinstallprompt` cuando el sitio es instalable
 * (manifest + service worker + https). Ese evento llega UNA vez y temprano, a
 * menudo antes de que exista el menú que ofrece instalar: por eso se captura al
 * arrancar (main.tsx) y se guarda aquí hasta que la persona pulse «Instalar».
 *
 * iPhone no tiene ese evento: allí la instalación es manual (Compartir →
 * Agregar a inicio) y lo único que se puede hacer es explicarlo.
 */

interface EventoInstalar extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let pendiente: EventoInstalar | null = null;
const oyentes = new Set<() => void>();
const avisar = (): void => oyentes.forEach((f) => f());

export function capturarInstalacion(): void {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    pendiente = e as EventoInstalar;
    avisar();
  });
  window.addEventListener("appinstalled", () => {
    pendiente = null;
    avisar();
  });
}

function suscribir(f: () => void): () => void {
  oyentes.add(f);
  return () => oyentes.delete(f);
}

/** Ya abierta como app instalada (no dentro del navegador). */
export function abiertaComoApp(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function esIphone(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function useInstalarApp(): {
  /** Hay algo que ofrecer: el diálogo de Chrome o las instrucciones de iPhone. */
  disponible: boolean;
  /** true si no hay diálogo automático y hay que explicar los pasos (iPhone). */
  manual: boolean;
  instalar: () => Promise<void>;
} {
  const evento = useSyncExternalStore(
    suscribir,
    () => pendiente,
    () => null,
  );
  const instalada = abiertaComoApp();
  const manual = evento === null && esIphone();
  return {
    disponible: !instalada && (evento !== null || manual),
    manual,
    instalar: async () => {
      if (pendiente === null) return;
      const e = pendiente;
      pendiente = null;
      avisar();
      await e.prompt();
      await e.userChoice.catch(() => undefined);
    },
  };
}
