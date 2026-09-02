import { Hammer } from "lucide-react";

/**
 * Fechas RELATIVAS para el mundo del negocio (PARTE 16): «hoy», «ayer»,
 * «hace 3 días» — y a partir de la semana, la fecha corta de verdad. Compara
 * DÍAS calendario, no milisegundos: a las 8 am, lo de anoche es «ayer».
 */
export function fechaRelativa(iso: string): string {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return "—";
  const dia = (d: Date) => Math.floor(d.getTime() / 86_400_000 + d.getTimezoneOffset() / 1440);
  const diferencia = dia(new Date()) - dia(fecha);
  if (diferencia <= 0) return "hoy";
  if (diferencia === 1) return "ayer";
  if (diferencia < 7) return `hace ${diferencia} días`;
  return fecha.toLocaleDateString("es-VE", { day: "numeric", month: "short" });
}

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
