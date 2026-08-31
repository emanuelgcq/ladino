/**
 * Dark mode con estrategia de CLASE y tres estados de origen:
 *
 *   1. sin elección guardada → manda `prefers-color-scheme` (y sigue en vivo
 *      los cambios del sistema mientras el usuario no elija);
 *   2. elección manual → se persiste en localStorage y gana al sistema;
 *   3. «volver al sistema» → se borra la elección y vuelve el estado 1.
 *
 * La clase `.dark` va en <html> y es lo único que el CSS mira
 * (@custom-variant dark en theme.css). Light es el defecto ante cualquier duda.
 */
const STORAGE_KEY = "ladino.theme";

export type ThemeChoice = "light" | "dark" | "system";

function guardada(): ThemeChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function sistemaOscuro(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function aplicar(oscuro: boolean): void {
  document.documentElement.classList.toggle("dark", oscuro);
}

export function temaActual(): ThemeChoice {
  return guardada();
}

export function esOscuroAhora(): boolean {
  return document.documentElement.classList.contains("dark");
}

export function setTema(eleccion: ThemeChoice): void {
  try {
    if (eleccion === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, eleccion);
  } catch {
    /* almacenamiento bloqueado: el tema aplica igual, solo no persiste */
  }
  aplicar(eleccion === "system" ? sistemaOscuro() : eleccion === "dark");
}

/** Se llama UNA vez en main.tsx, antes del primer render, para evitar el flash. */
export function initTema(): void {
  aplicar(guardada() === "system" ? sistemaOscuro() : guardada() === "dark");
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (guardada() === "system") aplicar(e.matches);
  });
}
