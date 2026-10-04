import { useEffect, useId, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { readAmountText } from "@ladino/money/format";
import { cn } from "../ui/cn.js";
import { Input, Label } from "../ui/input.js";

/**
 * FormField — etiqueta + control + error/pista, con la asociación aria hecha.
 * El error viene de Zod (los esquemas de packages/schemas se reutilizan en el
 * cliente) o del servidor: el campo no decide qué es válido, lo pinta.
 */
export function FormField({
  label,
  error,
  hint,
  required = false,
  children,
  className,
}: {
  label: string;
  error?: string | undefined;
  hint?: string;
  required?: boolean;
  /** Recibe id y aria para el control. */
  children: (props: {
    id: string;
    "aria-invalid": boolean | undefined;
    "aria-describedby": string | undefined;
  }) => React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const id = useId();
  const describeId = `${id}-msg`;
  const hayError = error !== undefined && error !== "";
  return (
    <div className={cn("space-y-1", className)}>
      <Label htmlFor={id}>
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {children({
        id,
        "aria-invalid": hayError ? true : undefined,
        "aria-describedby": hayError || hint !== undefined ? describeId : undefined,
      })}
      {hayError ? (
        <p id={describeId} role="alert" className="text-[0.8rem] text-destructive-soft-foreground">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p id={describeId} className="text-[0.8rem] text-faint-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** El patrón de importe de packages/schemas: hasta 16 enteros y 8 decimales. */
const IMPORTE_RE = /^\d{1,16}(\.\d{1,8})?$/;

/**
 * F-06: lo tecleado, leído por la ÚNICA función que analiza importes (`readAmountText`, de
 * `@ladino/money/format`) y comprobado contra la forma que exige la API. O el importe con punto
 * decimal y sin agrupar, o POR QUÉ no se pudo leer, en palabras de persona. Cero aritmética.
 */
export function leerImporte(
  texto: string,
): { ok: true; importe: string } | { ok: false; motivo: string } {
  const leido = readAmountText(texto);
  if (!leido.ok) {
    if (leido.error === "EMPTY") return { ok: false, motivo: "Escribe el importe." };
    if (leido.error === "AMBIGUOUS") {
      return {
        ok: false,
        motivo: `«${texto.trim()}» se puede leer de dos maneras: con miles o con decimales. Escribe el número sin separador de miles (26003) o con sus céntimos (26.003,00).`,
      };
    }
    if (leido.error === "INCOMPLETE") {
      return {
        ok: false,
        motivo: `A «${texto.trim()}» le faltan los decimales. Escríbelos (5,00) o quita el separador (5).`,
      };
    }
    if (leido.error === "BAD_GROUPING") {
      return {
        ok: false,
        motivo: `En «${texto.trim()}» los miles no van de tres en tres. Escríbelo como 26.003,58 o sin separador de miles (26003,58).`,
      };
    }
    return {
      ok: false,
      motivo: "Eso no es un importe. Escribe solo el número, por ejemplo 26.003,58.",
    };
  }
  if (leido.value.startsWith("-")) {
    return { ok: false, motivo: "El importe no puede ser negativo." };
  }
  if (!IMPORTE_RE.test(leido.value)) {
    return {
      ok: false,
      motivo: "El importe admite hasta 16 cifras enteras y 8 decimales.",
    };
  }
  return { ok: true, importe: leido.value };
}

/** Lo tecleado como lo espera la API; si no se puede leer, el texto tal cual (y no valida). */
export function importeLimpio(texto: string): string {
  const r = leerImporte(texto);
  return r.ok ? r.importe : texto.trim();
}

/** La forma de cantidad, tasa o porcentaje que acepta la API: 16 enteros y 8 decimales. */
const CANTIDAD_RE = /^\d{1,16}(\.\d{1,8})?$/;

/**
 * F-06, el lector HERMANO: cantidades, tasas y porcentajes. No es dinero, y por eso no hereda la
 * regla simétrica de las tres cifras: «1,250 kg» y una tasa «36,500» son legítimos.
 *
 *   · UNA sola coma es el decimal, lleve las cifras que lleve: «1,250» = 1.250, «0,5» = 0.5.
 *   · UN solo punto seguido de exactamente tres cifras es AMBIGUO («1.250»: ¿mil doscientos
 *     cincuenta o uno con veinticinco?) y se rechaza diciéndolo. «0.125» y «1.5» no lo son.
 *   · Con los dos separadores, el último es el decimal y los miles van de tres en tres.
 *   · Varios puntos y ninguna coma son miles («1.000.000»); varias comas, ambiguo.
 *
 * Todo lo que no es «una sola coma» lo decide `readAmountText`: no hay un segundo análisis.
 * Devuelve la cifra con punto decimal, con los decimales tal como se teclearon. Cero aritmética.
 */
export function leerCantidad(
  texto: string,
): { ok: true; cantidad: string } | { ok: false; motivo: string } {
  // El patrón de espacio ya incluye U+00A0 y U+202F, los que deja un número copiado y pegado.
  const compacto = texto.replace(/\s/g, "");
  const leido: ReturnType<typeof readAmountText> = /^\d+,\d+$/.test(compacto)
    ? { ok: true, value: compacto.replace(",", ".") }
    : readAmountText(texto);
  if (!leido.ok) {
    if (leido.error === "EMPTY") return { ok: false, motivo: "Escribe la cantidad." };
    if (leido.error === "AMBIGUOUS") {
      return {
        ok: false,
        motivo: `«${texto.trim()}» se puede leer de dos maneras: con miles o con decimales. Escribe los decimales con coma (1,25) o el número sin separador de miles (1250).`,
      };
    }
    if (leido.error === "INCOMPLETE") {
      return {
        ok: false,
        motivo: `A «${texto.trim()}» le faltan los decimales. Escríbelos (0,5) o quita el separador.`,
      };
    }
    if (leido.error === "BAD_GROUPING") {
      return {
        ok: false,
        motivo: `En «${texto.trim()}» los miles no van de tres en tres. Escríbelo como 1.250,5 o sin separador de miles (1250,5).`,
      };
    }
    return {
      ok: false,
      motivo: "Eso no es un número. Escribe solo la cifra, por ejemplo 2 o 0,5.",
    };
  }
  if (leido.value.startsWith("-")) {
    return { ok: false, motivo: "No puede ser negativo." };
  }
  if (!CANTIDAD_RE.test(leido.value)) {
    return { ok: false, motivo: "Admite hasta 16 cifras enteras y 8 decimales." };
  }
  return { ok: true, cantidad: leido.value };
}

/** Lo tecleado como lo espera la API; si no se puede leer, el texto tal cual (y no valida). */
export function cantidadLimpia(texto: string): string {
  const r = leerCantidad(texto);
  return r.ok ? r.cantidad : texto.trim();
}

/** ¿Se pudo leer como cantidad, tasa o porcentaje? Para deshabilitar el envío, no para calcular. */
export function cantidadValida(texto: string): boolean {
  return leerCantidad(texto).ok;
}

/**
 * El motivo del rechazo para un campo que NO es `MoneyInput` (un `input` dentro de una tabla):
 * `null` si está vacío —vacío no es un error mientras se rellena— o si se pudo leer.
 */
export function motivoDeImporte(texto: string): string | null {
  if (texto.trim() === "") return null;
  const r = leerImporte(texto);
  return r.ok ? null : r.motivo;
}

export function motivoDeCantidad(texto: string): string | null {
  if (texto.trim() === "") return null;
  const r = leerCantidad(texto);
  return r.ok ? null : r.motivo;
}

/** Pinta el motivo junto al campo: nunca un botón apagado sin decir por qué (F-06). */
export function MotivoDeLectura({
  motivo,
  className,
}: {
  motivo: string | null;
  className?: string;
}): React.JSX.Element | null {
  if (motivo === null) return null;
  return (
    <p role="alert" className={cn("text-[0.8rem] text-destructive-soft-foreground", className)}>
      {motivo}
    </p>
  );
}

/**
 * MoneyInput — entrada de importes SIN aritmética: al perder foco lee lo tecleado (a la
 * venezolana —«26.003,58»— o con punto decimal), lo deja en la forma que exige la API y, si no
 * se puede leer, DICE POR QUÉ debajo del campo (F-06): nunca un botón apagado sin motivo. Nunca
 * redondea, nunca calcula.
 */
export function MoneyInput({
  value,
  onChange,
  currency,
  id,
  disabled,
  ariaInvalid,
  ariaDescribedby,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  currency: string;
  id?: string;
  disabled?: boolean;
  ariaInvalid?: boolean | undefined;
  ariaDescribedby?: string | undefined;
  className?: string;
}): React.JSX.Element {
  const [motivo, setMotivo] = useState<string | null>(null);
  const motivoId = useId();
  const malo = motivo !== null;
  return (
    <div className={cn("relative", className)}>
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        disabled={disabled ?? false}
        aria-invalid={ariaInvalid ?? (malo ? true : undefined)}
        aria-describedby={malo ? motivoId : ariaDescribedby}
        className="pr-12 text-right font-mono"
        onChange={(e) => {
          setMotivo(null);
          onChange(e.target.value);
        }}
        onBlur={() => {
          // Vacío no es un error mientras se rellena el formulario: quien lo exige es el envío.
          if (value.trim() === "") {
            setMotivo(null);
            return;
          }
          const leido = leerImporte(value);
          if (leido.ok) {
            if (leido.importe !== value) onChange(leido.importe);
            setMotivo(null);
          } else {
            setMotivo(leido.motivo);
          }
        }}
        placeholder="0,00"
      />
      <span className="pointer-events-none absolute right-2.5 top-0 flex h-10 items-center sm:h-8 text-[0.8rem] font-medium text-faint-foreground">
        {currency}
      </span>
      {malo && (
        <p
          id={motivoId}
          role="alert"
          className="mt-1 text-left text-[0.8rem] text-destructive-soft-foreground"
        >
          {motivo}
        </p>
      )}
    </div>
  );
}

/** ¿Cumple la forma que la API exige? Para deshabilitar el envío, no para calcular. */
export function importeValido(v: string): boolean {
  return leerImporte(v).ok;
}

/**
 * DatePicker y DateRangePicker sobre <input type="date">: nativo, accesible y
 * con teclado gratis. La fecha es SIEMPRE explícita — los reportes de Ladino
 * no aceptan «hoy» implícito y su UI tampoco.
 */
export function DatePicker({
  value,
  onChange,
  id,
  min,
  max,
  disabled,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  id?: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <Input
      id={id}
      type="date"
      value={value}
      min={min}
      max={max}
      disabled={disabled ?? false}
      onChange={(e) => onChange(e.target.value)}
      className={cn("w-36", className)}
    />
  );
}

export function DateRangePicker({
  from,
  to,
  onChange,
  className,
}: {
  from: string;
  to: string;
  onChange: (r: { from: string; to: string }) => void;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <DatePicker value={from} onChange={(v) => onChange({ from: v, to })} max={to} />
      <span className="text-faint-foreground">–</span>
      <DatePicker value={to} onChange={(v) => onChange({ from, to: v })} min={from} />
    </div>
  );
}

export interface EntityOption {
  readonly id: string;
  readonly label: string;
  readonly detalle?: string;
}

/**
 * EntityPicker — el combobox asíncrono genérico: productos, clientes,
 * proveedores o cuentas contables con el MISMO componente y distinta fuente.
 * `buscar` habla con la búsqueda del servidor; aquí solo hay debounce, teclado
 * y estados. Sin resultados no es silencio: se dice.
 */
export function EntityPicker({
  value,
  onChange,
  buscar,
  placeholder = "Buscar…",
  id,
  disabled,
  ariaInvalid,
  ariaDescribedby,
  className,
}: {
  value: EntityOption | null;
  onChange: (v: EntityOption | null) => void;
  buscar: (q: string) => Promise<EntityOption[]>;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  ariaInvalid?: boolean | undefined;
  ariaDescribedby?: string | undefined;
  className?: string;
}): React.JSX.Element {
  const [abierto, setAbierto] = useState(false);
  const [texto, setTexto] = useState("");
  const [opciones, setOpciones] = useState<EntityOption[] | null>(null);
  const [indice, setIndice] = useState(0);
  const [cargando, setCargando] = useState(false);
  const [fallo, setFallo] = useState(false);
  const raiz = useRef<HTMLDivElement>(null);
  const listaId = useId();

  useEffect(() => {
    if (!abierto) return;
    // La bandera vive en el CLEANUP del efecto, no dentro del timer: antes
    // se declaraba dentro del callback del setTimeout y su «cleanup» era el
    // valor de retorno de ese callback — que nadie ejecuta —, así que una
    // respuesta lenta pisaba a la más reciente (auditoría 2026-09-11).
    let vigente = true;
    setCargando(true);
    setFallo(false);
    const t = setTimeout(() => {
      buscar(texto.trim())
        .then((r) => {
          if (!vigente) return;
          setOpciones(r);
          setIndice(0);
        })
        .catch(() => {
          if (!vigente) return;
          setOpciones([]);
          setFallo(true);
        })
        .finally(() => {
          if (vigente) setCargando(false);
        });
    }, 250);
    return () => {
      vigente = false;
      clearTimeout(t);
    };
  }, [texto, abierto, buscar]);

  useEffect(() => {
    const fuera = (e: MouseEvent) => {
      if (raiz.current !== null && !raiz.current.contains(e.target as Node)) setAbierto(false);
    };
    document.addEventListener("mousedown", fuera);
    return () => document.removeEventListener("mousedown", fuera);
  }, []);

  function elegir(o: EntityOption): void {
    onChange(o);
    setAbierto(false);
    setTexto("");
  }

  if (value !== null) {
    return (
      <div
        className={cn(
          "flex h-8 items-center gap-2 rounded-sm border border-border-strong bg-surface px-2.5",
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate text-[0.92rem]">{value.label}</span>
        {value.detalle !== undefined && (
          <span className="shrink-0 text-[0.78rem] text-faint-foreground">{value.detalle}</span>
        )}
        <button
          type="button"
          aria-label="Quitar selección"
          className="rounded p-0.5 text-faint-foreground hover:bg-surface-muted hover:text-foreground"
          onClick={() => {
            onChange(null);
            setAbierto(true);
          }}
          disabled={disabled ?? false}
        >
          <X className="size-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div ref={raiz} className={cn("relative", className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint-foreground" />
        <Input
          id={id}
          role="combobox"
          aria-expanded={abierto}
          aria-controls={listaId}
          aria-invalid={ariaInvalid}
          aria-describedby={ariaDescribedby}
          aria-activedescendant={abierto && opciones !== null ? `${listaId}-${indice}` : undefined}
          disabled={disabled ?? false}
          className="pl-8"
          placeholder={placeholder}
          value={texto}
          onFocus={() => setAbierto(true)}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (!abierto || opciones === null) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndice((i) => Math.min(i + 1, opciones.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndice((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const o = opciones[indice];
              if (o !== undefined) elegir(o);
            } else if (e.key === "Escape") {
              setAbierto(false);
            }
          }}
        />
      </div>
      {abierto && (
        <ul
          id={listaId}
          role="listbox"
          className="absolute z-40 mt-1 max-h-60 w-full overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-overlay"
        >
          {cargando && opciones === null ? (
            <li className="px-3 py-2 text-[0.85rem] text-muted-foreground">Buscando…</li>
          ) : fallo ? (
            <li role="alert" className="px-3 py-2 text-[0.85rem] text-destructive-soft-foreground">
              No se pudo buscar. Revisa la conexión y escribe de nuevo.
            </li>
          ) : opciones === null || opciones.length === 0 ? (
            <li className="px-3 py-2 text-[0.85rem] text-muted-foreground">
              Sin resultados{texto.trim() === "" ? " todavía — escribe para buscar" : ""}.
            </li>
          ) : (
            opciones.map((o, i) => (
              <li
                key={o.id}
                id={`${listaId}-${i}`}
                role="option"
                aria-selected={i === indice}
                className={cn(
                  "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.9rem]",
                  i === indice && "bg-surface-muted",
                )}
                onMouseEnter={() => setIndice(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  elegir(o);
                }}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.detalle !== undefined && (
                  <span className="shrink-0 text-[0.78rem] text-faint-foreground">{o.detalle}</span>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
