import { Hammer } from "lucide-react";

/**
 * Pantalla provisional del mundo de la persona: honesta, en su voz, y sin
 * fingir que hay algo detrás. Cada una desaparece cuando su pantalla real
 * llega — la fase no se cierra con ninguna de estas en pie.
 */
export function PantallaEnCamino({ titulo }: { titulo: string }): React.JSX.Element {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <Hammer className="mx-auto size-8 text-faint-foreground" />
      <h1 className="mt-3 text-lg font-semibold">{titulo}</h1>
      <p className="mt-1 text-[0.95rem] text-muted-foreground">
        Estamos armando esta pantalla. Llega en esta misma fase.
      </p>
    </div>
  );
}
