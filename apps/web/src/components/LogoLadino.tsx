import { useState } from "react";

/**
 * EL LOGO DE LADINO — el archivo real de la marca, tal cual (decisión del
 * dueño, 2026-09-07: el logo no se toca). Vive en `public/brand/` y esta
 * pieza lo pinta con dos cuidados:
 *
 *   · FALLBACK: si el archivo no está (bundle sin la imagen, 404), cae al
 *     monograma «L» con el nombre — la app jamás enseña un icono roto;
 *   · MODO OSCURO: el trazo del logo es azul marino y sobre negro no se lee;
 *     en oscuro va sobre una pastilla blanca sutil, que es la práctica
 *     estándar para marcas de trazo oscuro — el logo mismo no cambia.
 */
export function LogoLadino({
  alto = "h-10",
  className = "",
}: {
  /** Clase de altura del logo (el ancho es auto). */
  alto?: string;
  className?: string;
}): React.JSX.Element {
  const [roto, setRoto] = useState(false);
  if (roto) {
    return (
      <span className={`flex items-center gap-2 ${className}`}>
        <span className="flex size-8 items-center justify-center rounded-md bg-accent font-semibold text-accent-foreground">
          L
        </span>
        <span className="text-[1.05rem] font-semibold">Ladino</span>
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center rounded-lg dark:bg-white/95 dark:px-2.5 dark:py-1.5 ${className}`}
    >
      <img
        src="/brand/ladino-logo.png"
        alt="Ladino"
        className={`${alto} w-auto`}
        onError={() => setRoto(true)}
      />
    </span>
  );
}
