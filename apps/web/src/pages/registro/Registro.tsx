import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Briefcase,
  Camera,
  Car,
  Check,
  Hammer,
  MoreHorizontal,
  Pill,
  Shirt,
  Store,
  Truck,
  UtensilsCrossed,
} from "lucide-react";
import { API_URL } from "../../lib.js";
import { LogoLadino } from "../../components/LogoLadino.js";
import { Button } from "../../ui/button.js";
import { formatearDocumento } from "../negocio/comunes.js";

/**
 * EL REGISTRO PREMIUM (orden del dueño, 2026-09-06): fundar el negocio con la
 * sensación de configurar un teléfono nuevo. UNA pregunta por pantalla,
 * tipografía grande, transiciones suaves, teclado primero (Enter avanza, Esc
 * retrocede), validación amable al avanzar — nunca un rojo mientras escribes.
 *
 * Vive FUERA del shell, como el Login: lo monta SessionProvider cuando la
 * sesión existe y no hay ninguna empresa. Al confirmar llama a los casos de
 * uso existentes (POST /v1/onboarding + POST /v1/companies/logo) — cero
 * lógica de negocio aquí — y desemboca SIN pantalla intermedia en /empezar
 * (history.replaceState antes de recargar la sesión).
 */

interface Props {
  readonly token: string;
  readonly correo: string;
  readonly onSalir: () => void;
  /** Recarga la sesión (la MISMA función del selector): en éxito Y en
   *  DUPLICATE — un reintento de un éxito responde 409 y se resuelve igual. */
  readonly onListo: () => void;
}

type Paso =
  | "bienvenida"
  | "nombre"
  | "rubro"
  | "rif"
  | "rif-numero"
  | "razon"
  | "direccion"
  | "logo"
  | "contacto"
  | "tu"
  | "resumen";

const RUBROS: {
  code: string;
  etiqueta: string;
  icono: React.ComponentType<{ className?: string }>;
}[] = [
  { code: "bodega", etiqueta: "Bodega y abastos", icono: Store },
  { code: "ropa", etiqueta: "Ropa y calzado", icono: Shirt },
  { code: "ferreteria", etiqueta: "Ferretería", icono: Hammer },
  { code: "farmacia", etiqueta: "Farmacia", icono: Pill },
  { code: "restaurante", etiqueta: "Restaurante o comida", icono: UtensilsCrossed },
  { code: "repuestos", etiqueta: "Repuestos", icono: Car },
  { code: "servicios", etiqueta: "Servicios", icono: Briefcase },
  { code: "distribuidora", etiqueta: "Distribuidora", icono: Truck },
  { code: "otro", etiqueta: "Otro", icono: MoreHorizontal },
];

/** Estados de Venezuela con sus ciudades principales (la última opción libre). */
const ESTADOS: Record<string, string[]> = {
  Amazonas: ["Puerto Ayacucho"],
  Anzoátegui: ["Barcelona", "Puerto La Cruz", "El Tigre", "Anaco"],
  Apure: ["San Fernando de Apure", "Guasdualito"],
  Aragua: ["Maracay", "Turmero", "La Victoria", "Cagua"],
  Barinas: ["Barinas", "Socopó"],
  Bolívar: ["Ciudad Guayana", "Ciudad Bolívar", "Upata"],
  Carabobo: ["Valencia", "Puerto Cabello", "Guacara", "Bejuma"],
  Cojedes: ["San Carlos", "Tinaquillo"],
  "Delta Amacuro": ["Tucupita"],
  "Distrito Capital": ["Caracas"],
  Falcón: ["Coro", "Punto Fijo"],
  Guárico: ["San Juan de los Morros", "Valle de la Pascua", "Calabozo"],
  "La Guaira": ["La Guaira", "Catia La Mar"],
  Lara: ["Barquisimeto", "Cabudare", "Carora", "El Tocuyo"],
  Mérida: ["Mérida", "El Vigía", "Ejido"],
  Miranda: ["Los Teques", "Guarenas", "Guatire", "Charallave", "Ocumare del Tuy"],
  Monagas: ["Maturín", "Punta de Mata"],
  "Nueva Esparta": ["Porlamar", "La Asunción", "Juan Griego"],
  Portuguesa: ["Guanare", "Acarigua", "Araure"],
  Sucre: ["Cumaná", "Carúpano"],
  Táchira: ["San Cristóbal", "Táriba", "Rubio", "La Fría"],
  Trujillo: ["Valera", "Trujillo", "Boconó"],
  Yaracuy: ["San Felipe", "Yaritagua", "Chivacoa"],
  Zulia: ["Maracaibo", "Cabimas", "Ciudad Ojeda", "Machiques"],
};

interface Datos {
  nombre: string;
  rubro: string | null;
  tieneRif: boolean | null;
  prefijoRif: string;
  numeroRif: string;
  razonSocial: string;
  direccion: string;
  logo: Blob | null;
  logoUrl: string | null; // objectURL para previsualizar
  telefono: string;
  estado: string | null;
  ciudad: string;
  duenoNombre: string;
  duenoCedula: string;
}

const REDUCIR = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Registro({ token, correo, onListo, onSalir }: Props): React.JSX.Element {
  const [paso, setPaso] = useState<Paso>("bienvenida");
  const [rumbo, setRumbo] = useState<1 | -1>(1);
  const [aviso, setAviso] = useState<string | null>(null);
  const [creando, setCreando] = useState(false);
  const [celebrando, setCelebrando] = useState(false);
  const [errorCrear, setErrorCrear] = useState<string | null>(null);
  const [d, setD] = useState<Datos>({
    nombre: "",
    rubro: null,
    tieneRif: null,
    prefijoRif: "J",
    numeroRif: "",
    razonSocial: "",
    direccion: "",
    logo: null,
    logoUrl: null,
    telefono: "",
    estado: null,
    ciudad: "",
    duenoNombre: "",
    duenoCedula: "",
  });
  const pon = useCallback(<K extends keyof Datos>(k: K, v: Datos[K]) => {
    setAviso(null);
    setD((prev) => ({ ...prev, [k]: v }));
  }, []);

  // El orden REAL del viaje según la rama elegida: la barra de progreso y el
  // Atrás salen de aquí, no de un contador suelto.
  const viaje = useMemo<Paso[]>(() => {
    const conRif = d.tieneRif === true;
    return [
      "bienvenida",
      "nombre",
      "rubro",
      "rif",
      ...(conRif ? (["rif-numero", "razon", "direccion"] as Paso[]) : []),
      "logo",
      "contacto",
      "tu",
      "resumen",
    ];
  }, [d.tieneRif]);
  const indice = viaje.indexOf(paso);

  const irA = useCallback((destino: Paso, dir: 1 | -1) => {
    setRumbo(dir);
    setAviso(null);
    setPaso(destino);
  }, []);

  /** Validación AMABLE: se pregunta al avanzar; la respuesta es una línea. */
  const avanzar = useCallback(() => {
    const siguiente = viaje[indice + 1];
    if (siguiente === undefined) return;
    if (paso === "nombre" && d.nombre.trim().length < 2) {
      setAviso("Necesitamos el nombre de tu negocio.");
      return;
    }
    if (paso === "rubro" && d.rubro === null) {
      setAviso("Elige a qué se dedica — puedes cambiarlo después.");
      return;
    }
    if (paso === "rif" && d.tieneRif === null) {
      setAviso("Dinos si ya tienes RIF — «Todavía no» también es una respuesta.");
      return;
    }
    if (paso === "rif-numero" && d.numeroRif.replace(/[^0-9A-Za-z]/g, "").length < 3) {
      setAviso("Necesitamos el número del RIF.");
      return;
    }
    if (paso === "razon" && d.razonSocial.trim().length < 3) {
      setAviso("Necesitamos la razón social, como aparece en el RIF.");
      return;
    }
    if (paso === "direccion" && d.direccion.trim().length < 5) {
      setAviso("Necesitamos la dirección registrada en el SENIAT.");
      return;
    }
    if (paso === "tu" && d.duenoNombre.trim().length < 2) {
      setAviso("Necesitamos tu nombre.");
      return;
    }
    irA(siguiente, 1);
  }, [paso, indice, viaje, d, irA]);

  const retroceder = useCallback(() => {
    const anterior = viaje[indice - 1];
    if (anterior !== undefined && !creando) irA(anterior, -1);
  }, [indice, viaje, creando, irA]);

  // Esc retrocede desde cualquier paso; Enter lo maneja cada formulario.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") retroceder();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [retroceder]);

  const rifNormalizado = `${d.prefijoRif}${d.numeroRif.replace(/[^0-9A-Za-z]/g, "")}`.toUpperCase();

  async function crear(): Promise<void> {
    if (creando) return;
    setCreando(true);
    setErrorCrear(null);
    try {
      const conRif = d.tieneRif === true;
      const r = await fetch(`${API_URL}/v1/onboarding`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          business_name: d.nombre.trim(),
          ...(conRif
            ? {
                tax_id: rifNormalizado,
                legal_name: d.razonSocial.trim(),
                fiscal_address: d.direccion.trim(),
              }
            : {}),
          ...(d.rubro === null ? {} : { business_type: d.rubro }),
          ...(d.telefono.trim() === ""
            ? {}
            : { phone: d.telefono.trim(), whatsapp: d.telefono.trim() }),
          ...(d.ciudad.trim() === "" ? {} : { city: d.ciudad.trim() }),
          ...(d.estado === null ? {} : { state: d.estado }),
          owner_full_name: d.duenoNombre.trim(),
          ...(d.duenoCedula.trim() === "" ? {} : { owner_national_id: d.duenoCedula.trim() }),
        }),
      });
      if (r.status === 409) {
        // Ya estaba fundado (reintento de un éxito): recargar lo resuelve.
        onListo();
        return;
      }
      if (!r.ok) {
        const cuerpo = (await r.json().catch(() => null)) as {
          person_message?: string;
          message?: string;
        } | null;
        setErrorCrear(cuerpo?.person_message ?? cuerpo?.message ?? "No se pudo crear el negocio.");
        setCreando(false);
        return;
      }
      const { company_id } = (await r.json()) as { company_id: string };
      if (d.logo !== null) {
        // El logo es un adorno: si su subida falla, el negocio YA existe y se
        // reintenta después desde Mi empresa — jamás se bloquea la fundación.
        const form = new FormData();
        form.append("file", new File([d.logo], "logo.png", { type: "image/png" }));
        await fetch(`${API_URL}/v1/companies/logo`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "X-Company-Id": company_id },
          body: form,
        }).catch(() => null);
      }
      // La micro-celebración sobria, y directo a /empezar sin pantalla
      // intermedia. El destino viaja por sessionStorage: el router nació con
      // la URL «/» congelada y el aterrizaje por rol lo consume UNA vez.
      setCelebrando(true);
      try {
        sessionStorage.setItem("ladino.aterrizar", "/empezar");
      } catch {
        // sin sessionStorage se aterriza por rol: peor no es
      }
      window.setTimeout(() => onListo(), REDUCIR() ? 0 : 450);
    } catch {
      setErrorCrear("No se pudo conectar. Revisa tu internet e intenta otra vez.");
      setCreando(false);
    }
  }

  const rubroElegido = RUBROS.find((r) => r.code === d.rubro);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background">
      {/* La cabecera mínima: la marca discreta, el progreso fino, el Atrás fantasma. */}
      <header className="sticky top-0 z-10 bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-xl items-center gap-3 px-6">
          {indice > 0 && !celebrando ? (
            <button
              onClick={retroceder}
              aria-label="Atrás"
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
            </button>
          ) : (
            <span className="size-8" />
          )}
          <LogoLadino alto="h-6" />
          <div className="flex flex-1 justify-center gap-1.5" aria-hidden>
            {viaje.slice(1).map((p, i) => (
              <span
                key={p}
                className={`h-1 rounded-full transition-all duration-300 ${
                  i < indice
                    ? "w-4 bg-accent"
                    : i === indice - 1
                      ? "w-6 bg-accent"
                      : "w-4 bg-border"
                }`}
              />
            ))}
          </div>
          <button
            onClick={onSalir}
            className="rounded-md px-2 py-1 text-[0.82rem] text-faint-foreground transition-colors hover:text-foreground"
          >
            Salir
          </button>
        </div>
      </header>

      <Pantalla clave={paso} rumbo={rumbo}>
        {paso === "bienvenida" && (
          <div className="text-center">
            <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-72 bg-[radial-gradient(ellipse_60%_80%_at_50%_-10%,var(--accent-soft),transparent)]" />
            <h1 className="text-balance text-[2.4rem] font-semibold leading-tight tracking-tight">
              Vamos a montar tu negocio en Ladino.
            </h1>
            <p className="mx-auto mt-3 max-w-md text-[1.05rem] text-muted-foreground">
              Te toma menos de dos minutos. Puedes ajustar todo después.
            </p>
            <Button
              variant="primary"
              size="lg"
              autoFocus
              className="mt-10 h-12 px-10 text-[1.05rem]"
              onClick={avanzar}
            >
              Empezar
            </Button>
          </div>
        )}

        {paso === "nombre" && (
          <Pregunta
            titulo="¿Cómo se llama tu negocio?"
            ayuda="El nombre con el que te conoce la gente."
            aviso={aviso}
            onSeguir={avanzar}
          >
            <CampoGrande
              valor={d.nombre}
              onCambiar={(v) => pon("nombre", v)}
              placeholder="Abastos La Bendición"
              etiqueta="Nombre del negocio"
            />
          </Pregunta>
        )}

        {paso === "rubro" && (
          <Pregunta
            titulo="¿A qué se dedica?"
            ayuda="Elige lo que más se parezca."
            aviso={aviso}
            onSeguir={avanzar}
          >
            <div
              role="radiogroup"
              aria-label="Rubro del negocio"
              className="grid grid-cols-2 gap-2.5 sm:grid-cols-3"
              onKeyDown={(e) => {
                const idx = RUBROS.findIndex((r) => r.code === d.rubro);
                const cols = 3;
                let destino = -1;
                if (e.key === "ArrowRight") destino = Math.min(idx + 1, RUBROS.length - 1);
                if (e.key === "ArrowLeft") destino = Math.max(idx - 1, 0);
                if (e.key === "ArrowDown") destino = Math.min(idx + cols, RUBROS.length - 1);
                if (e.key === "ArrowUp") destino = Math.max(idx - cols, 0);
                if (destino >= 0) {
                  e.preventDefault();
                  pon("rubro", RUBROS[destino]!.code);
                  document.getElementById(`rubro-${RUBROS[destino]!.code}`)?.focus();
                }
              }}
            >
              {RUBROS.map((r) => {
                const Icono = r.icono;
                const activo = d.rubro === r.code;
                return (
                  <button
                    key={r.code}
                    id={`rubro-${r.code}`}
                    role="radio"
                    aria-checked={activo}
                    autoFocus={r.code === "bodega"}
                    onClick={() => pon("rubro", r.code)}
                    onDoubleClick={avanzar}
                    className={`flex flex-col items-center gap-2 rounded-lg border p-4 text-center transition-all duration-150 ${
                      activo
                        ? "border-accent bg-accent-soft text-accent-soft-foreground shadow-soft"
                        : "border-border bg-surface text-muted-foreground hover:border-border-strong hover:text-foreground"
                    }`}
                  >
                    <Icono className="size-6" />
                    <span className="text-[0.88rem] font-medium leading-tight">{r.etiqueta}</span>
                  </button>
                );
              })}
            </div>
          </Pregunta>
        )}

        {paso === "rif" && (
          <Pregunta titulo="¿Tu negocio ya tiene RIF?" aviso={aviso} onSeguir={avanzar} sinSeguir>
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  [true, "Sí, tengo RIF", "Facturas legales desde el primer día."],
                  [false, "Todavía no", "Empiezas hoy mismo, sin papeleo."],
                ] as const
              ).map(([valor, titulo, detalle]) => (
                <button
                  key={String(valor)}
                  autoFocus={valor}
                  onClick={() => {
                    pon("tieneRif", valor);
                  }}
                  className={`rounded-xl border p-6 text-left transition-all duration-150 ${
                    d.tieneRif === valor
                      ? "border-accent bg-accent-soft shadow-soft"
                      : "border-border bg-surface hover:border-border-strong"
                  }`}
                >
                  <span className="block text-[1.15rem] font-semibold">{titulo}</span>
                  <span className="mt-1 block text-[0.9rem] text-muted-foreground">{detalle}</span>
                </button>
              ))}
            </div>
            {d.tieneRif === false && (
              <p className="mt-4 rounded-lg bg-surface-muted p-4 text-[0.95rem] text-muted-foreground">
                Perfecto. Vas a poder vender con recibos, llevar inventario, clientes y cuentas
                desde hoy. Cuando tengas tu RIF, activas las facturas en minutos.
              </p>
            )}
            {d.tieneRif !== null && (
              <Button
                variant="primary"
                size="lg"
                className="mt-6 h-11 w-full text-[1rem]"
                onClick={avanzar}
              >
                Continuar
              </Button>
            )}
          </Pregunta>
        )}

        {paso === "rif-numero" && (
          <Pregunta
            titulo="¿Cuál es el RIF?"
            ayuda="Tal como aparece en el certificado."
            aviso={aviso}
            onSeguir={avanzar}
          >
            <div className="flex gap-2">
              <select
                aria-label="Tipo de RIF"
                value={d.prefijoRif}
                onChange={(e) => pon("prefijoRif", e.target.value)}
                className="h-14 rounded-lg border border-border-strong bg-surface px-3 text-[1.2rem] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                {["J", "V", "E", "G"].map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <CampoGrande
                valor={d.numeroRif}
                onCambiar={(v) => pon("numeroRif", v.replace(/[^0-9A-Za-z]/g, ""))}
                placeholder="401234567"
                etiqueta="Número del RIF"
                mono
              />
            </div>
            {d.numeroRif !== "" && (
              <p className="mt-3 text-center font-mono text-[1.05rem] text-accent-soft-foreground tabular-nums">
                {formatearDocumento(rifNormalizado)}
              </p>
            )}
          </Pregunta>
        )}

        {paso === "razon" && (
          <Pregunta
            titulo="¿Cuál es la razón social?"
            ayuda="El nombre legal exacto, como aparece en el RIF."
            aviso={aviso}
            onSeguir={avanzar}
          >
            <CampoGrande
              valor={d.razonSocial}
              onCambiar={(v) => pon("razonSocial", v)}
              placeholder="Inversiones La Bendición, C.A."
              etiqueta="Razón social"
            />
          </Pregunta>
        )}

        {paso === "direccion" && (
          <Pregunta
            titulo="¿Cuál es la dirección fiscal?"
            ayuda="La dirección registrada en el SENIAT. Sale en tus facturas."
            aviso={aviso}
            onSeguir={avanzar}
          >
            <CampoGrande
              valor={d.direccion}
              onCambiar={(v) => pon("direccion", v)}
              placeholder="Av. Bolívar, local 7, Valencia, Carabobo"
              etiqueta="Dirección fiscal"
            />
          </Pregunta>
        )}

        {paso === "logo" && (
          <Pregunta
            titulo="Ponle la cara a tu negocio"
            ayuda="Tu logo saldrá en la app y en tus facturas. Puedes ponerlo después."
            aviso={aviso}
            onSeguir={avanzar}
            sinSeguir
          >
            <Recortador
              logoUrl={d.logoUrl}
              onLogo={(blob, url) => {
                pon("logo", blob);
                pon("logoUrl", url);
              }}
            />
            <div className="mt-6 flex gap-2">
              <Button variant="ghost" size="lg" className="h-11 flex-1" onClick={avanzar}>
                Después
              </Button>
              <Button
                variant="primary"
                size="lg"
                className="h-11 flex-1"
                disabled={d.logo === null}
                onClick={avanzar}
              >
                Continuar
              </Button>
            </div>
          </Pregunta>
        )}

        {paso === "contacto" && (
          <Pregunta
            titulo="¿Cómo te contactan?"
            ayuda="Para tus clientes y tus comprobantes."
            aviso={aviso}
            onSeguir={avanzar}
          >
            <div className="space-y-4">
              <CampoGrande
                valor={d.telefono}
                onCambiar={(v) => pon("telefono", v)}
                placeholder="0414-1234567"
                etiqueta="Teléfono / WhatsApp del negocio"
                inputMode="tel"
              />
              <div className="grid grid-cols-2 gap-2">
                <select
                  aria-label="Estado"
                  value={d.estado ?? ""}
                  onChange={(e) => {
                    pon("estado", e.target.value === "" ? null : e.target.value);
                    pon("ciudad", "");
                  }}
                  className="h-12 rounded-lg border border-border-strong bg-surface px-3 text-[1rem] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <option value="">Estado…</option>
                  {Object.keys(ESTADOS).map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
                {d.estado !== null && !ESTADOS[d.estado]!.includes(d.ciudad) && d.ciudad !== "" ? (
                  <input
                    aria-label="Ciudad"
                    value={d.ciudad}
                    onChange={(e) => pon("ciudad", e.target.value)}
                    className="h-12 rounded-lg border border-border-strong bg-surface px-3 text-[1rem] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  />
                ) : (
                  <select
                    aria-label="Ciudad"
                    value={d.ciudad}
                    disabled={d.estado === null}
                    onChange={(e) =>
                      pon("ciudad", e.target.value === "__otra__" ? " " : e.target.value)
                    }
                    className="h-12 rounded-lg border border-border-strong bg-surface px-3 text-[1rem] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
                  >
                    <option value="">Ciudad…</option>
                    {(d.estado === null ? [] : ESTADOS[d.estado]!).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                    <option value="__otra__">Otra…</option>
                  </select>
                )}
              </div>
            </div>
          </Pregunta>
        )}

        {paso === "tu" && (
          <Pregunta
            titulo="Ahora tú"
            ayuda="Quien administra la cuenta."
            aviso={aviso}
            onSeguir={avanzar}
          >
            <div className="space-y-4">
              <CampoGrande
                valor={d.duenoNombre}
                onCambiar={(v) => pon("duenoNombre", v)}
                placeholder="Tu nombre completo"
                etiqueta="Nombre completo"
              />
              <CampoGrande
                valor={d.duenoCedula}
                onCambiar={(v) => pon("duenoCedula", v)}
                placeholder="V-12345678 (opcional)"
                etiqueta="Cédula"
                sinFoco
              />
              <p className="text-center text-[0.9rem] text-faint-foreground">{correo}</p>
            </div>
          </Pregunta>
        )}

        {paso === "resumen" && (
          <div className="text-center">
            <h1 className="text-balance text-[2rem] font-semibold leading-tight tracking-tight">
              {celebrando ? "¡Listo!" : "Así se ve tu negocio"}
            </h1>
            {/* LA TARJETA: el primer «esto se ve profesional». */}
            <div className="relative mx-auto mt-8 max-w-sm rounded-xl border border-border bg-surface p-6 text-left shadow-overlay">
              {celebrando && (
                <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-surface/85 backdrop-blur-[1px]">
                  <span className="flex size-16 items-center justify-center rounded-full bg-accent text-accent-foreground shadow-overlay motion-safe:animate-[celebrar_400ms_ease-out]">
                    <Check className="size-8" strokeWidth={3} />
                  </span>
                </div>
              )}
              <div className="flex items-center gap-4">
                {d.logoUrl !== null ? (
                  <img
                    src={d.logoUrl}
                    alt=""
                    className="size-16 rounded-xl border border-border object-cover"
                  />
                ) : (
                  <span className="flex size-16 items-center justify-center rounded-xl bg-accent-soft text-2xl font-semibold text-accent-soft-foreground">
                    {d.nombre.trim().slice(0, 1).toUpperCase() || "L"}
                  </span>
                )}
                <div className="min-w-0">
                  <p className="truncate text-[1.2rem] font-semibold leading-tight">
                    {d.nombre.trim()}
                  </p>
                  <p className="text-[0.9rem] text-muted-foreground">
                    {rubroElegido?.etiqueta ?? "Negocio"}
                    {d.ciudad.trim() !== "" ? ` · ${d.ciudad.trim()}` : ""}
                  </p>
                </div>
              </div>
              {d.tieneRif === true && (
                <div className="mt-4 border-t border-border pt-3 text-[0.85rem] text-muted-foreground">
                  <p className="truncate">{d.razonSocial.trim()}</p>
                  <p className="font-mono tabular-nums">{formatearDocumento(rifNormalizado)}</p>
                </div>
              )}
            </div>
            {errorCrear !== null && (
              <p
                role="alert"
                className="mx-auto mt-4 max-w-sm rounded-md bg-destructive-soft px-3 py-2 text-[0.9rem] text-destructive-soft-foreground"
              >
                {errorCrear}
              </p>
            )}
            <Button
              variant="primary"
              size="lg"
              autoFocus
              disabled={creando}
              className="mt-8 h-12 px-10 text-[1.05rem]"
              onClick={() => void crear()}
            >
              {creando ? "Creando…" : "Crear mi negocio"}
            </Button>
          </div>
        )}
      </Pantalla>
      <style>{`@keyframes celebrar { from { transform: scale(0.6); opacity: 0 } to { transform: scale(1); opacity: 1 } }`}</style>
    </div>
  );
}

/** El lienzo de cada paso: centrado, con aire, y el deslizamiento suave. */
function Pantalla({
  clave,
  rumbo,
  children,
}: {
  clave: string;
  rumbo: 1 | -1;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-xl items-center px-6 pb-24 pt-6">
      <div
        key={clave}
        className="relative w-full motion-safe:animate-[entrar_240ms_ease-out]"
        style={{ "--desde": rumbo === 1 ? "24px" : "-24px" } as React.CSSProperties}
      >
        {children}
        <style>{`@keyframes entrar { from { opacity: 0; transform: translateX(var(--desde)) } to { opacity: 1; transform: none } }`}</style>
      </div>
    </main>
  );
}

/** Una pregunta: título display, ayuda tranquila, y Enter que avanza. */
function Pregunta({
  titulo,
  ayuda,
  aviso,
  onSeguir,
  sinSeguir = false,
  children,
}: {
  titulo: string;
  ayuda?: string;
  aviso: string | null;
  onSeguir: () => void;
  sinSeguir?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <form
      className="w-full"
      onSubmit={(e) => {
        e.preventDefault();
        onSeguir();
      }}
    >
      <h1 className="text-balance text-center text-[2rem] font-semibold leading-tight tracking-tight">
        {titulo}
      </h1>
      {ayuda !== undefined && (
        <p className="mt-2 text-center text-[0.98rem] text-muted-foreground">{ayuda}</p>
      )}
      <div className="mt-8">{children}</div>
      {aviso !== null && (
        <p role="alert" className="mt-3 text-center text-[0.92rem] text-warning-soft-foreground">
          {aviso}
        </p>
      )}
      {!sinSeguir && (
        <Button type="submit" variant="primary" size="lg" className="mt-8 h-11 w-full text-[1rem]">
          Continuar
        </Button>
      )}
    </form>
  );
}

/** El input protagonista: grande, línea tranquila, foco elegante. */
function CampoGrande({
  valor,
  onCambiar,
  placeholder,
  etiqueta,
  mono = false,
  sinFoco = false,
  inputMode,
}: {
  valor: string;
  onCambiar: (v: string) => void;
  placeholder: string;
  etiqueta: string;
  mono?: boolean;
  sinFoco?: boolean;
  inputMode?: "tel";
}): React.JSX.Element {
  return (
    <input
      aria-label={etiqueta}
      autoFocus={!sinFoco}
      value={valor}
      placeholder={placeholder}
      {...(inputMode === undefined ? {} : { inputMode })}
      onChange={(e) => onCambiar(e.target.value)}
      className={`h-14 w-full rounded-lg border border-border-strong bg-surface px-4 text-[1.2rem] placeholder:text-faint-foreground focus-visible:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
        mono ? "font-mono tabular-nums" : ""
      }`}
    />
  );
}

/**
 * El recorte del logo con canvas NATIVO (sin librerías): zona de arrastrar o
 * tocar, zoom con slider, y la previsualización EN VIVO cuadrada Y circular —
 * cómo se verá en la factura y en la app. El resultado sale como PNG 512.
 */
export function Recortador({
  logoUrl,
  onLogo,
}: {
  logoUrl: string | null;
  onLogo: (blob: Blob, url: string) => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [origen, setOrigen] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [arrastrando, setArrastrando] = useState(false);

  const recortar = useCallback(
    (img: HTMLImageElement, escala: number) => {
      const lienzo = document.createElement("canvas");
      lienzo.width = 512;
      lienzo.height = 512;
      const ctx = lienzo.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, 512, 512);
      const lado = Math.min(img.naturalWidth, img.naturalHeight) / escala;
      const sx = (img.naturalWidth - lado) / 2;
      const sy = (img.naturalHeight - lado) / 2;
      ctx.drawImage(img, sx, sy, lado, lado, 0, 0, 512, 512);
      lienzo.toBlob((blob) => {
        if (blob !== null) onLogo(blob, URL.createObjectURL(blob));
      }, "image/png");
    },
    [onLogo],
  );

  const cargar = useCallback(
    (f: File) => {
      const img = new Image();
      img.onload = () => {
        setOrigen(img);
        setZoom(1);
        recortar(img, 1);
      };
      img.src = URL.createObjectURL(f);
    },
    [recortar],
  );

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) cargar(f);
        }}
      />
      {logoUrl === null ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setArrastrando(true);
          }}
          onDragLeave={() => setArrastrando(false)}
          onDrop={(e) => {
            e.preventDefault();
            setArrastrando(false);
            const f = e.dataTransfer.files?.[0];
            if (f) cargar(f);
          }}
          className={`flex h-48 w-full flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed transition-colors ${
            arrastrando
              ? "border-accent bg-accent-soft/40"
              : "border-border-strong bg-surface-muted/40 hover:border-accent"
          }`}
        >
          <Camera className="size-8 text-muted-foreground" />
          <span className="text-[0.95rem] text-muted-foreground">
            Toca para elegir el logo, o arrástralo aquí
          </span>
        </button>
      ) : (
        <div className="flex flex-col items-center gap-4">
          <div className="flex items-end justify-center gap-8">
            <figure className="text-center">
              <img
                src={logoUrl}
                alt="El logo, cuadrado"
                className="size-28 rounded-xl border border-border object-cover shadow-soft"
              />
              <figcaption className="mt-2 text-[0.78rem] text-faint-foreground">
                En tu factura
              </figcaption>
            </figure>
            <figure className="text-center">
              <img
                src={logoUrl}
                alt="El logo, circular"
                className="size-20 rounded-full border border-border object-cover shadow-soft"
              />
              <figcaption className="mt-2 text-[0.78rem] text-faint-foreground">
                En la app
              </figcaption>
            </figure>
          </div>
          {origen !== null && (
            <label className="flex w-full max-w-xs items-center gap-3 text-[0.85rem] text-muted-foreground">
              Zoom
              <input
                type="range"
                min={1}
                max={2.5}
                step={0.05}
                value={zoom}
                onChange={(e) => {
                  const z = Number(e.target.value);
                  setZoom(z);
                  recortar(origen, z);
                }}
                className="flex-1 accent-[var(--accent)]"
              />
            </label>
          )}
          <Button variant="ghost" size="sm" onClick={() => inputRef.current?.click()}>
            Elegir otra imagen
          </Button>
        </div>
      )}
    </div>
  );
}
