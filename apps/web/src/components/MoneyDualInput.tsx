import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSesion } from "../app/session.js";
import { MoneyInput, importeValido } from "./forms.js";
import { fechaLocal } from "../fechas.js";
import { tasaLimpia } from "../tasa.js";

/**
 * EL DINERO SE ESCRIBE UNA VEZ, EN LA MONEDA QUE SE TENGA A MANO (ADR-0066, entrega ii).
 *
 * Dos campos a la vista —bolívares y dólares—: la persona escribe en el que tiene delante y el
 * otro se rellena con lo que responde el SERVIDOR. El segundo campo es INFORMATIVO: con mala
 * conexión puede quedarse vacío y no bloquea nada, porque **la conversión que vale ocurre al
 * guardar**, dentro de la transacción y con la tasa del día del hecho. De aquí sale solo lo que
 * la persona escribió —importe y moneda—, nunca una tasa ni un convertido: la regla 7 y
 * `apps/web/CLAUDE.md` prohíben la aritmética monetaria en el cliente, incluso para previsualizar.
 *
 * Por eso tampoco se ve un «≈» calculado aquí: lo que se enseña al lado es la respuesta del
 * servidor, con su tasa y su día. La tasa se lee LIMPIA —«Tasa BCV: 848,5458»— y nada más: el
 * servicio por el que llegó se queda en su fila (dueño, 2026-09-16; lo asevera `tasa.test.ts`,
 * que cazó la primera versión de este componente pintando la fuente cruda). Si no hay tasa para
 * ese día, se dice y no se inventa.
 */
interface Vista {
  rate: string;
  source: string;
  rate_date: string;
  in_functional: string;
  in_anchor: string;
}

const ANCLA = "USD";

export function MoneyDualInput({
  valor,
  onChange,
  fecha,
  funcional = "VES",
  id,
  disabled,
}: {
  /** Lo que la persona escribió: importe y la moneda en la que lo escribió. */
  valor: { amount: string; currency: string };
  onChange: (v: { amount: string; currency: string }) => void;
  /** El día del hecho: la tasa que se enseña es la que se va a usar al guardar. */
  fecha: string;
  funcional?: string;
  id?: string;
  disabled?: boolean;
}): React.JSX.Element {
  // El texto de cada campo. El de la moneda de captura es el que manda; el otro lo pinta el
  // servidor, y se vacía en cuanto la persona toca el suyo para no enseñar un número viejo.
  const [enFuncional, setEnFuncional] = useState(valor.currency === funcional ? valor.amount : "");
  const [enAncla, setEnAncla] = useState(valor.currency === ANCLA ? valor.amount : "");
  const { llamar } = useSesion();

  const limpio = valor.amount.trim().replace(",", ".");
  const vista = useQuery({
    queryKey: ["dual", limpio, valor.currency, fecha],
    enabled: importeValido(limpio),
    staleTime: 60_000,
    queryFn: () =>
      llamar<Vista>(
        `/v1/exchange-rates/preview?amount=${limpio}&currency=${valor.currency}&date=${fecha}`,
      ),
  });

  // La respuesta del servidor llena el campo que la persona NO está escribiendo.
  useEffect(() => {
    if (vista.data === undefined) return;
    if (valor.currency === funcional) setEnAncla(vista.data.in_anchor);
    else setEnFuncional(vista.data.in_functional);
  }, [vista.data, valor.currency, funcional]);

  const escribir = (moneda: string, v: string): void => {
    if (moneda === funcional) {
      setEnFuncional(v);
      setEnAncla("");
    } else {
      setEnAncla(v);
      setEnFuncional("");
    }
    onChange({ amount: v, currency: moneda });
  };

  const sinTasa = vista.isError;
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={`${id ?? "dual"}-ves`} className="sr-only">
            Importe en bolívares
          </label>
          <MoneyInput
            id={`${id ?? "dual"}-ves`}
            value={enFuncional}
            onChange={(v) => escribir(funcional, v)}
            currency="Bs."
            {...(disabled === undefined ? {} : { disabled })}
          />
        </div>
        <div>
          <label htmlFor={`${id ?? "dual"}-usd`} className="sr-only">
            Importe en dólares
          </label>
          <MoneyInput
            id={`${id ?? "dual"}-usd`}
            value={enAncla}
            onChange={(v) => escribir(ANCLA, v)}
            currency={ANCLA}
            {...(disabled === undefined ? {} : { disabled })}
          />
        </div>
      </div>
      {sinTasa ? (
        <p role="alert" className="text-[0.8rem] text-warning-soft-foreground">
          No hay tasa del BCV para el {fechaLocal(fecha)}. Tráela en Mi dinero y vuelve.
        </p>
      ) : vista.data !== undefined ? (
        // La tasa se lee limpia y nada más (dueño, 2026-09-16): el servicio por el que llegó y la
        // marca de tiempo se quedan en su fila. Aquí solo el nombre, el número exacto y el día.
        <p className="text-[0.8rem] text-faint-foreground">
          {tasaLimpia(vista.data.rate, vista.data.source)} · del {fechaLocal(vista.data.rate_date)}
        </p>
      ) : (
        <p className="text-[0.8rem] text-faint-foreground">
          Escribe en Bs o en USD — el otro se calcula solo.
        </p>
      )}
    </div>
  );
}
