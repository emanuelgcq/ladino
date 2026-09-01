import { useEffect, useId, useRef, useState } from "react";
import { Search, X } from "lucide-react";
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
 * MoneyInput — entrada de importes SIN aritmética: valida la FORMA al perder
 * foco (el mismo patrón que exige la API) y a lo sumo recorta espacios y
 * cambia coma por punto. Nunca redondea, nunca calcula.
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
  const [malo, setMalo] = useState(false);
  return (
    <div className={cn("relative", className)}>
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        disabled={disabled ?? false}
        aria-invalid={ariaInvalid ?? (malo ? true : undefined)}
        aria-describedby={ariaDescribedby}
        className="pr-12 text-right font-mono"
        onChange={(e) => {
          setMalo(false);
          onChange(e.target.value);
        }}
        onBlur={() => {
          const limpio = value.trim().replace(",", ".");
          if (limpio !== value) onChange(limpio);
          setMalo(limpio !== "" && !IMPORTE_RE.test(limpio));
        }}
        placeholder="0.00"
      />
      <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[0.8rem] font-medium text-faint-foreground">
        {currency}
      </span>
    </div>
  );
}

/** ¿Cumple la forma que la API exige? Para deshabilitar el envío, no para calcular. */
export function importeValido(v: string): boolean {
  return IMPORTE_RE.test(v.trim());
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
    <div className={cn("flex items-center gap-1.5", className)}>
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
  const raiz = useRef<HTMLDivElement>(null);
  const listaId = useId();

  useEffect(() => {
    if (!abierto) return;
    setCargando(true);
    const t = setTimeout(() => {
      let vigente = true;
      buscar(texto.trim())
        .then((r) => {
          if (vigente) {
            setOpciones(r);
            setIndice(0);
          }
        })
        .catch(() => {
          if (vigente) setOpciones([]);
        })
        .finally(() => {
          if (vigente) setCargando(false);
        });
      return () => {
        vigente = false;
      };
    }, 250);
    return () => clearTimeout(t);
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
