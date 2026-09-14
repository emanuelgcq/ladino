import { useEffect, useRef, useState } from "react";
import { Camera, ScanLine, X } from "lucide-react";
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
 * No decide nada de dinero ni de producto: devuelve el TEXTO leído y quien lo
 * usa lo busca en el servidor. Siempre hay un campo para teclear el código a
 * mano — una etiqueta rota no puede dejar la venta parada.
 */

const FORMATOS_NATIVOS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"];

interface DetectorNativo {
  detect: (fuente: HTMLVideoElement) => Promise<{ rawValue: string }[]>;
}
interface ConstructorDetector {
  new (opciones: { formats: string[] }): DetectorNativo;
  getSupportedFormats?: () => Promise<string[]>;
}

function mensajeDeError(e: unknown): string {
  const nombre = e instanceof DOMException ? e.name : "";
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

export function EscanerCodigo({
  abierto,
  onCerrar,
  onCodigo,
  titulo = "Leer código de barras",
}: {
  abierto: boolean;
  onCerrar: () => void;
  /** El texto leído (o tecleado). El escáner se cierra solo tras entregarlo. */
  onCodigo: (codigo: string) => void;
  titulo?: string;
}): React.JSX.Element {
  // El <video> vive dentro del portal del diálogo, que se monta al abrir: se
  // guarda como ESTADO para que la cámara arranque cuando el elemento existe,
  // no antes (con un ref, el efecto podía correr con el video aún sin montar).
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const alLeer = useRef(onCodigo);
  alLeer.current = onCodigo;
  const [error, setError] = useState<string | null>(null);
  const [preparando, setPreparando] = useState(true);
  const [manual, setManual] = useState("");

  useEffect(() => {
    if (!abierto || video === null) return;
    let vivo = true;
    let stream: MediaStream | null = null;
    let temporizador: number | undefined;
    let pararZxing: (() => void) | null = null;
    setError(null);
    setPreparando(true);
    setManual("");

    const entregar = (codigo: string): void => {
      if (!vivo) return;
      vivo = false;
      navigator.vibrate?.(60);
      alLeer.current(codigo.trim());
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
        if (!vivo) return;
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
              if (video.readyState >= 2) {
                const hallados = await detector.detect(video);
                const primero = hallados.find((h) => h.rawValue.trim() !== "");
                if (primero !== undefined) {
                  entregar(primero.rawValue);
                  return;
                }
              }
            } catch {
              /* un cuadro ilegible no es un error: se prueba el siguiente */
            }
            temporizador = window.setTimeout(() => void ciclo(), 180);
          };
          void ciclo();
          return;
        }

        // Sin detector nativo: ZXing, cargado solo ahora.
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        if (!vivo || stream === null) return;
        const lector = new BrowserMultiFormatReader(undefined, {
          delayBetweenScanAttempts: 180,
        });
        const controles = await lector.decodeFromStream(stream, video, (resultado) => {
          if (resultado !== undefined) entregar(resultado.getText());
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
      if (temporizador !== undefined) window.clearTimeout(temporizador);
      pararZxing?.();
      stream?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    };
  }, [abierto, video]);

  return (
    <BaseDialog.Root open={abierto} onOpenChange={(v) => !v && onCerrar()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-black/80" />
        <BaseDialog.Popup className="fixed inset-0 z-50 flex flex-col bg-black text-white outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-[36rem] sm:w-[28rem] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:overflow-hidden sm:rounded-lg">
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
              className="size-full object-cover"
              playsInline
              muted
              autoPlay
              aria-label="Vista de la cámara"
            />
            {error === null && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="h-40 w-[78%] max-w-sm rounded-lg border-2 border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
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
          </div>

          <div className="space-y-2 bg-black px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
            <p className="text-center text-[0.85rem] text-white/75">
              Apunta al código de barras; se lee solo.
            </p>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (manual.trim() !== "") onCodigo(manual.trim());
              }}
            >
              <Input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder="O escribe el código"
                aria-label="Escribir el código a mano"
                inputMode="numeric"
                className="border-white/30 bg-white/10 text-white placeholder:text-white/50"
              />
              <Button type="submit" variant="secondary" className="h-10 shrink-0 sm:h-8">
                Usar
              </Button>
            </form>
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
}: {
  onCodigo: (codigo: string) => void;
  etiqueta?: string;
  className?: string;
  titulo?: string;
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
        onCerrar={() => setAbierto(false)}
        {...(titulo === undefined ? {} : { titulo })}
        onCodigo={(c) => {
          setAbierto(false);
          onCodigo(c);
        }}
      />
    </>
  );
}
