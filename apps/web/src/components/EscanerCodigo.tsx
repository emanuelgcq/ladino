import { useEffect, useRef, useState, type RefObject } from "react";
import { Camera, CheckCircle2, CircleAlert, Pause, Play, ScanLine, X } from "lucide-react";
import { Dialog as BaseDialog } from "@base-ui-components/react/dialog";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { cn } from "../ui/cn.js";

/**
 * EL LECTOR DE CÓDIGOS POR CÁMARA (2026-09-14): la cámara del teléfono hace de
 * lector de mostrador. Lee EAN-13/8, UPC-A/E, Code 128/39 y QR — lo que traen
 * los productos de supermercado y las etiquetas propias.
 *
 * Dos motores, el mejor disponible:
 *   · el detector NATIVO del navegador (`BarcodeDetector`: Chrome en Android),
 *     rápido y sin descargar nada;
 *   · ZXing en JavaScript cuando no existe (Safari en iPhone). Se carga SOLO
 *     entonces, en su propio fragmento: quien no lo necesita no lo descarga.
 *
 * Dos modos:
 *   · UNA lectura (buscar un producto, llenar un campo): lee y se cierra;
 *   · CONTINUO (la caja): la cámara queda abierta y cada código leído se
 *     entrega en el acto, con bip, vibración, marco verde y el resultado a la
 *     vista. Se cierra con «Listo»; «Pausar» congela la lectura sin apagar la
 *     cámara (para acomodar la mercancía sin que lea lo que no toca).
 *
 * Las dos defensas del modo continuo son las de los lectores profesionales:
 *   · CONSENSO: un código se acepta cuando dos cuadros seguidos dicen lo mismo
 *     — una lectura falsa de un cuadro borroso no llega a la cuenta;
 *   · TIEMPO DE OLVIDO: el código recién entregado NO se vuelve a contar
 *     mientras siga a la vista. Para anotar otro igual, se retira de la
 *     cámara un momento y se vuelve a mostrar.
 *
 * No decide nada de dinero ni de producto: entrega el TEXTO leído y quien lo
 * usa lo busca en el servidor. Siempre hay un campo para teclear el código a
 * mano — una etiqueta rota no puede dejar la venta parada.
 */

const FORMATOS_NATIVOS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"];
/** Cuadros iguales seguidos para aceptar un código. */
const CONSENSO = 2;
/** Un código entregado se ignora mientras se siga viendo, y hasta este tiempo después. */
const OLVIDO_MS = 1500;
/** Separación mínima entre dos entregas (dos etiquetas juntas en el mismo cuadro). */
const SEPARACION_MS = 700;
const INTERVALO_MS = 150;

/** Lo que quien usa el lector responde a una lectura, para mostrarlo sobre la cámara. */
export interface Lectura {
  ok: boolean;
  texto: string;
}

interface DetectorNativo {
  detect: (fuente: HTMLVideoElement) => Promise<{ rawValue: string }[]>;
}
interface ConstructorDetector {
  new (opciones: { formats: string[] }): DetectorNativo;
  getSupportedFormats?: () => Promise<string[]>;
}

function mensajeDeError(e: unknown): string {
  const nombre = e instanceof DOMException ? e.name : "";
  if (e instanceof Error && e.message === "ACTUALIZAR") {
    return "Hay una versión nueva de Ladino. Recarga la página para usar la cámara.";
  }
  if (!window.isSecureContext) {
    return "La cámara solo funciona con conexión segura (https).";
  }
  if (nombre === "NotAllowedError" || nombre === "SecurityError") {
    return "Ladino no tiene permiso para usar la cámara. Actívalo en los permisos del navegador para este sitio y vuelve a intentar.";
  }
  if (nombre === "NotFoundError" || nombre === "OverconstrainedError") {
    return "No se encontró una cámara en este dispositivo.";
  }
  if (nombre === "NotReadableError") {
    return "La cámara está ocupada por otra aplicación. Ciérrala y vuelve a intentar.";
  }
  return "No se pudo abrir la cámara. Escribe el código a mano.";
}

/** Bip corto (agudo si entró, grave si no). Sin audio disponible, silencio. */
function bip(audio: RefObject<AudioContext | null>, ok: boolean): void {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctx === undefined) return;
    audio.current ??= new Ctx();
    const ctx = audio.current;
    const osc = ctx.createOscillator();
    const vol = ctx.createGain();
    osc.frequency.value = ok ? 1760 : 440;
    vol.gain.setValueAtTime(0.12, ctx.currentTime);
    vol.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (ok ? 0.09 : 0.25));
    osc.connect(vol).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + (ok ? 0.1 : 0.26));
  } catch {
    /* sin sonido no pasa nada */
  }
}

export function EscanerCodigo({
  abierto,
  onCerrar,
  onCodigo,
  titulo = "Leer código de barras",
  focoAlCerrar,
  continuo = false,
}: {
  /** Adónde vuelve el foco al cerrar (el POS: su buscador, para el lector USB). */
  focoAlCerrar?: RefObject<HTMLElement | null>;
  abierto: boolean;
  onCerrar: () => void;
  /**
   * El texto leído (o tecleado). En modo de una lectura el escáner se cierra
   * tras entregarlo; en continuo sigue abierto y muestra la `Lectura` que se
   * devuelva.
   */
  onCodigo: (codigo: string) => void | Promise<Lectura | void>;
  titulo?: string;
  continuo?: boolean;
}): React.JSX.Element {
  // El <video> vive dentro del portal del diálogo, que se monta al abrir: se
  // guarda como ESTADO para que la cámara arranque cuando el elemento existe,
  // no antes (con un ref, el efecto podía correr con el video aún sin montar).
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const alLeer = useRef(onCodigo);
  alLeer.current = onCodigo;
  // En modo de una lectura: UNA entrega por apertura, cámara o campo manual.
  const entregado = useRef(false);
  const pausado = useRef(false);
  const audio = useRef<AudioContext | null>(null);
  const [enPausa, setEnPausa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preparando, setPreparando] = useState(true);
  const [manual, setManual] = useState("");
  const [lecturas, setLecturas] = useState<(Lectura & { id: number })[]>([]);
  const [destello, setDestello] = useState<"ok" | "mal" | null>(null);
  const [leidos, setLeidos] = useState(0);
  const entregarRef = useRef<(codigo: string) => void>(() => undefined);

  useEffect(() => {
    if (!abierto || video === null) return;
    let vivo = true;
    let stream: MediaStream | null = null;
    let temporizador: number | undefined;
    let pararZxing: (() => void) | null = null;
    let apagarDestello: number | undefined;
    setError(null);
    setPreparando(true);
    setManual("");
    setLecturas([]);
    setLeidos(0);
    setDestello(null);
    setEnPausa(false);
    pausado.current = false;
    entregado.current = false;

    const candidato = { valor: "", veces: 0 };
    const vistos = new Map<string, number>();
    let ultimaEntrega = 0;
    let secuencia = 0;

    const avisar = (l: Lectura, id: number): void => {
      if (!vivo) return;
      bip(audio, l.ok);
      if (!l.ok) navigator.vibrate?.([40, 60, 40]);
      setDestello(l.ok ? "ok" : "mal");
      window.clearTimeout(apagarDestello);
      apagarDestello = window.setTimeout(() => setDestello(null), 700);
      setLecturas((prev) => prev.map((x) => (x.id === id ? { ...l, id } : x)));
    };

    /** Entrega un código ya aceptado (de la cámara o del campo manual). */
    const entregar = (codigo: string): void => {
      if (!vivo) return;
      if (!continuo) {
        if (entregado.current) return;
        entregado.current = true;
        vivo = false;
        navigator.vibrate?.(60);
        void alLeer.current(codigo);
        return;
      }
      ultimaEntrega = Date.now();
      const id = ++secuencia;
      navigator.vibrate?.(60);
      setLeidos((n) => n + 1);
      setLecturas((prev) => [{ id, ok: true, texto: `Leído ${codigo}…` }, ...prev].slice(0, 4));
      void Promise.resolve(alLeer.current(codigo))
        .then((r) => avisar(r ?? { ok: true, texto: `Leído ${codigo}` }, id))
        .catch(() => avisar({ ok: false, texto: `No se pudo usar ${codigo}` }, id));
    };
    entregarRef.current = entregar;

    /** Cada cuadro con un código pasa por aquí: pausa, consenso y olvido. */
    const ver = (bruto: string): void => {
      const valor = bruto.trim();
      if (!vivo || valor === "" || pausado.current) return;
      const ahora = Date.now();
      const visto = vistos.get(valor);
      if (visto !== undefined && ahora - visto < OLVIDO_MS) {
        vistos.set(valor, ahora); // sigue a la vista: el olvido se renueva
        return;
      }
      if (candidato.valor !== valor) {
        candidato.valor = valor;
        candidato.veces = 1;
      } else {
        candidato.veces += 1;
      }
      if (candidato.veces < CONSENSO) return;
      if (continuo && ahora - ultimaEntrega < SEPARACION_MS) return;
      candidato.valor = "";
      candidato.veces = 0;
      vistos.set(valor, ahora);
      entregar(valor);
    };

    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new DOMException("sin cámara", "NotFoundError");
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        // Cerrado mientras el navegador pedía permiso: la cámara que acaba de
        // llegar se apaga aquí — la limpieza ya corrió sin nada que parar.
        if (!vivo) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        setPreparando(false);

        const Nativo = (window as unknown as { BarcodeDetector?: ConstructorDetector })
          .BarcodeDetector;
        const soportados = Nativo?.getSupportedFormats
          ? await Nativo.getSupportedFormats().catch(() => [] as string[])
          : [];
        const formatos = FORMATOS_NATIVOS.filter((f) => soportados.includes(f));

        if (Nativo !== undefined && formatos.length > 0) {
          const detector = new Nativo({ formats: formatos });
          const ciclo = async (): Promise<void> => {
            if (!vivo) return;
            try {
              if (video.readyState >= 2 && !pausado.current) {
                const hallados = await detector.detect(video);
                const primero = hallados.find((h) => h.rawValue.trim() !== "");
                if (primero !== undefined) ver(primero.rawValue);
                else candidato.veces = 0;
              }
            } catch {
              /* un cuadro ilegible no es un error: se prueba el siguiente */
            }
            if (vivo) temporizador = window.setTimeout(() => void ciclo(), INTERVALO_MS);
          };
          void ciclo();
          return;
        }

        // Sin detector nativo: ZXing, cargado solo ahora. Si falla la carga es
        // casi siempre un deploy nuevo con la pestaña vieja abierta.
        const { BrowserMultiFormatReader } = await import("@zxing/browser").catch(() => {
          throw new Error("ACTUALIZAR");
        });
        if (!vivo || stream === null) return;
        const lector = new BrowserMultiFormatReader(undefined, {
          delayBetweenScanAttempts: INTERVALO_MS,
        });
        const controles = await lector.decodeFromStream(stream, video, (resultado) => {
          if (resultado !== undefined) ver(resultado.getText());
          else candidato.veces = 0;
        });
        pararZxing = () => controles.stop();
        if (!vivo) pararZxing();
      } catch (e) {
        if (vivo) {
          setError(mensajeDeError(e));
          setPreparando(false);
        }
      }
    })();

    return () => {
      vivo = false;
      window.clearTimeout(temporizador);
      window.clearTimeout(apagarDestello);
      pararZxing?.();
      stream?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      entregarRef.current = () => undefined;
    };
  }, [abierto, video, continuo]);

  // El audio se cierra con el lector (y se vuelve a crear en la próxima lectura).
  useEffect(() => {
    if (abierto) return;
    void audio.current?.close().catch(() => undefined);
    audio.current = null;
  }, [abierto]);

  function alternarPausa(): void {
    pausado.current = !pausado.current;
    setEnPausa(pausado.current);
  }

  return (
    <BaseDialog.Root open={abierto} onOpenChange={(v) => !v && onCerrar()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-black/80" />
        <BaseDialog.Popup
          {...(focoAlCerrar === undefined ? {} : { finalFocus: focoAlCerrar })}
          className="fixed inset-0 z-50 flex flex-col bg-black text-white outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-[38rem] sm:w-[28rem] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:overflow-hidden sm:rounded-lg"
        >
          <div className="flex items-center justify-between px-3 py-2">
            <BaseDialog.Title className="flex items-center gap-2 text-[1rem] font-semibold">
              <ScanLine className="size-5" /> {titulo}
            </BaseDialog.Title>
            <BaseDialog.Close
              aria-label="Cerrar lector"
              className="flex size-10 items-center justify-center rounded-md text-white/80 hover:bg-white/10"
            >
              <X className="size-5" />
            </BaseDialog.Close>
          </div>

          <div className="relative flex-1 overflow-hidden">
            <video
              ref={setVideo}
              className={cn("size-full object-cover transition-opacity", enPausa && "opacity-40")}
              playsInline
              muted
              autoPlay
              aria-label="Vista de la cámara"
            />
            {error === null && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div
                  className={cn(
                    "h-40 w-[78%] max-w-sm rounded-lg border-2 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)] transition-colors duration-150",
                    destello === "ok"
                      ? "border-emerald-400 bg-emerald-400/15"
                      : destello === "mal"
                        ? "border-red-400 bg-red-400/15"
                        : "border-white/90",
                  )}
                />
              </div>
            )}
            {enPausa && error === null && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <p className="rounded-full bg-black/70 px-4 py-2 text-[0.95rem] font-medium">
                  En pausa
                </p>
              </div>
            )}
            {(preparando || error !== null) && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                <Camera className="size-9 text-white/70" />
                <p
                  className={cn("text-[0.95rem]", error !== null && "text-amber-200")}
                  role={error !== null ? "alert" : undefined}
                >
                  {error ?? "Abriendo la cámara…"}
                </p>
              </div>
            )}
            {continuo && lecturas.length > 0 && (
              <ul
                className="absolute inset-x-2 bottom-2 space-y-1"
                aria-live="polite"
                aria-label="Últimas lecturas"
              >
                {lecturas.map((l, i) => (
                  <li
                    key={l.id}
                    className={cn(
                      "flex items-center gap-2 rounded-md bg-black/75 px-2.5 py-1.5 text-[0.88rem]",
                      i > 0 && "opacity-60",
                    )}
                  >
                    {l.ok ? (
                      <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                    ) : (
                      <CircleAlert className="size-4 shrink-0 text-red-400" />
                    )}
                    <span className="truncate">{l.texto}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2 bg-black px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
            <p className="text-center text-[0.85rem] text-white/75">
              {continuo
                ? "Pasa los productos uno a uno. Para otro igual, retíralo y vuelve a mostrarlo."
                : "Apunta al código de barras; se lee solo."}
            </p>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const codigo = manual.trim();
                if (codigo === "") return;
                setManual("");
                entregarRef.current(codigo);
              }}
            >
              <Input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder="O escribe el código"
                aria-label="Escribir el código a mano"
                className="border-white/30 bg-white/10 text-white placeholder:text-white/50"
              />
              <Button
                type="submit"
                variant="secondary"
                className="h-10 shrink-0 sm:h-8"
                disabled={manual.trim() === ""}
              >
                Usar
              </Button>
            </form>
            {continuo && (
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  className="h-11"
                  disabled={error !== null || preparando}
                  onClick={alternarPausa}
                >
                  {enPausa ? <Play /> : <Pause />}
                  {enPausa ? "Seguir" : "Pausar"}
                </Button>
                <Button type="button" variant="primary" className="h-11" onClick={onCerrar}>
                  Listo{leidos > 0 ? ` · ${leidos} ${leidos === 1 ? "leído" : "leídos"}` : ""}
                </Button>
              </div>
            )}
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/** Botón de cámara para poner junto a un buscador o un campo de código. */
export function BotonEscanear({
  onCodigo,
  etiqueta = "Leer código con la cámara",
  className,
  titulo,
  focoAlCerrar,
  continuo = false,
}: {
  focoAlCerrar?: RefObject<HTMLElement | null>;
  onCodigo: (codigo: string) => void | Promise<Lectura | void>;
  etiqueta?: string;
  className?: string;
  titulo?: string;
  /** La cámara queda abierta leyendo un código tras otro (la caja). */
  continuo?: boolean;
}): React.JSX.Element {
  const [abierto, setAbierto] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="icon"
        aria-label={etiqueta}
        title={etiqueta}
        className={cn("h-10 w-10 shrink-0 sm:h-8 sm:w-8", className)}
        onClick={() => setAbierto(true)}
      >
        <ScanLine />
      </Button>
      <EscanerCodigo
        abierto={abierto}
        continuo={continuo}
        onCerrar={() => setAbierto(false)}
        {...(titulo === undefined ? {} : { titulo })}
        {...(focoAlCerrar === undefined ? {} : { focoAlCerrar })}
        onCodigo={(c) => {
          if (continuo) return onCodigo(c);
          setAbierto(false);
          void onCodigo(c);
        }}
      />
    </>
  );
}
