import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { useSesion } from "../../app/session.js";
import { tieneRif } from "../../app/rif.js";
import { motivoDePausa, type MotivoDePausa, type TalonarioDeCaja } from "./caja-en-pausa.js";
import { salidaDeNumeracion } from "../../pages/ventas/salida-numeracion.js";

/**
 * A-02 (regla del dueño, 2026-09-28): con RIF se vende con FACTURA, y la factura sale del
 * talonario de la imprenta. Hasta que haya uno con papel, la caja está en pausa: se dice arriba,
 * con el enlace al talonario, y «Cobrar» no se ofrece. No hay recibos para quien tiene RIF.
 *
 * La regla es del servidor (que rechaza el cobro con el mismo motivo); aquí solo se dice antes.
 */
const TEXTO: Readonly<Record<MotivoDePausa, string>> = {
  regime_missing:
    "La caja está en pausa: con tu RIF vendes con factura, y falta decir cómo facturas y cargar tu talonario.",
  no_range:
    "La caja está en pausa: con tu RIF vendes con factura, y no hay un talonario con papel.",
  printer_data_incomplete:
    "La caja está en pausa: a tu talonario le faltan los datos de la imprenta.",
};

/**
 * null = la caja vende. Las consultas comparten clave con /empezar y con el cobro, y SIN
 * `staleTime`: quien acaba de cargar su talonario y vuelve a la caja no espera un minuto en pausa.
 */
export function useCajaEnPausa(): MotivoDePausa | null {
  const { empresa, llamar } = useSesion();
  const conRif = tieneRif(empresa);
  const setup = useQuery({
    queryKey: ["empezar-fiscal", empresa.id],
    enabled: conRif,
    queryFn: () => llamar<{ current_regime: string | null }>("/v1/fiscal/setup"),
  });
  const talonarios = useQuery({
    queryKey: ["talonarios-caja", empresa.id],
    enabled: conRif,
    queryFn: () => llamar<TalonarioDeCaja[]>("/v1/fiscal-number-ranges"),
  });
  return motivoDePausa({ conRif, setup: setup.data, talonarios: talonarios.data });
}

export function CajaEnPausa({ motivo }: { motivo: MotivoDePausa }): React.JSX.Element {
  const { puede } = useSesion();
  const salida = salidaDeNumeracion(motivo, puede);
  // Sin régimen, el enlace abre DIRECTO el paso de las facturas, donde está el talonario.
  const destino = motivo === "regime_missing" ? "/empezar?paso=facturas" : salida.enlace?.to;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-warning-soft px-3 py-2 text-[0.88rem] text-warning-soft-foreground"
    >
      {TEXTO[motivo]}{" "}
      {salida.enlace !== null && destino !== undefined ? (
        <Link to={destino} className="font-medium underline">
          {salida.enlace.texto} →
        </Link>
      ) : (
        <span>Pídele a quien administra el negocio que lo deje listo.</span>
      )}
    </div>
  );
}
