import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, FileSpreadsheet, Package, Plus, Store } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { tieneRif as tieneRifEmpresa } from "../../app/rif.js";
import { LogoLadino } from "../../components/LogoLadino.js";
import { errorDePersona } from "../../lib.js";
import { tasaLimpia } from "../../tasa.js";
import { fechaLocal } from "../../fechas.js";
import { Button } from "../../ui/button.js";
import { Card, CardContent } from "../../ui/card.js";
import { Input } from "../../ui/input.js";
import { useToast } from "../../ui/toast.js";
import { FormField } from "../../components/forms.js";
import { AltaSimple, ImportarExcel } from "./Productos.js";
import { CrearCuenta } from "./Dinero.js";
import { IvaQueCobras } from "../../components/capa-fiscal/IvaQueCobras.js";
import { TipoDeContribuyente } from "../../components/capa-fiscal/TipoDeContribuyente.js";
import { porcentajeAFraccion, fraccionAPorcentaje } from "./comunes.js";

/**
 * EMPEZAR (Fase C, PARTE 4): el primer día del negocio en cuatro pasos. Cada
 * paso lee su estado del servidor y se marca solo; el de productos se puede
 * saltar, el del dinero no — sin una cuenta no hay dónde caer un cobro.
 *
 * El paso fiscal es el delicado: Ladino NO decide cómo facturas ni qué impuesto
 * cobras. Enseña las opciones CON su norma (viene del servidor, citada en la
 * migración) y el porcentaje lo escribe y lo ACEPTA la persona: queda
 * registrado con su usuario y la fecha. El servidor lo marca
 * VALIDAR-TRIBUTARIO hasta que un humano lo confirme contra la ley vigente.
 */

interface FormaDeFacturar {
  code: string;
  name: string;
  description: string;
  numbering_mode: string;
  legal_source: string;
}
interface SetupFiscal {
  regimes: FormaDeFacturar[];
  current_regime: string | null;
  /** Definición única del modo (migración 54). */
  sales_mode: "facturas" | "recibos" | "ninguno";
  iva_general: { rate: string; legal_source: string } | null;
}
interface Resumen {
  tasa_del_dia: { rate: string; rate_date: string; es_de_hoy: boolean } | null;
}

export function Empezar(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const conRif = tieneRifEmpresa(empresa);
  // El tipo de contribuyente (h. 62): con RIF, sin él no se registra ninguna compra.
  const miEmpresa = useQuery({
    queryKey: ["mi-empresa", empresa.id],
    enabled: conRif,
    queryFn: async () => {
      const lista =
        await llamar<{ id: string; taxpayer_type_code: string | null }[]>("/v1/companies");
      return lista.find((e) => e.id === empresa.id) ?? null;
    },
  });
  const tipoContribuyente = miEmpresa.data?.taxpayer_type_code ?? null;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [paso, setPaso] = useState(0);

  const productos = useQuery({
    queryKey: ["empezar-productos", empresa.id],
    queryFn: () => llamar<{ total: number }>("/v1/products?per_page=1"),
  });
  const cuentas = useQuery({
    queryKey: ["cuentas", empresa.id],
    queryFn: () =>
      llamar<{ accounts: { id: string; name: string; currency: string }[] }>(
        "/v1/treasury/accounts",
      ),
  });
  const resumen = useQuery({
    queryKey: ["negocio-resumen", empresa.id],
    queryFn: () => llamar<Resumen>("/v1/negocio/resumen"),
  });
  const fiscal = useQuery({
    queryKey: ["empezar-fiscal", empresa.id],
    queryFn: () => llamar<SetupFiscal>("/v1/fiscal/setup"),
  });
  const rangos = useQuery({
    queryKey: ["empezar-rangos", empresa.id],
    queryFn: () => llamar<{ kind: string; status: string }[]>("/v1/fiscal-number-ranges"),
  });

  const recargar = () => {
    void qc.invalidateQueries({ queryKey: ["empezar-productos", empresa.id] });
    void qc.invalidateQueries({ queryKey: ["cuentas", empresa.id] });
    void qc.invalidateQueries({ queryKey: ["negocio-resumen", empresa.id] });
    void qc.invalidateQueries({ queryKey: ["empezar-fiscal", empresa.id] });
    void qc.invalidateQueries({ queryKey: ["empezar-rangos", empresa.id] });
  };

  const hayProductos = (productos.data?.total ?? 0) > 0;
  const hayCuentas = (cuentas.data?.accounts.length ?? 0) > 0;
  // Solo existe la tasa del BCV (ADR-0064 §1): la última publicada vale, sea de hoy o no.
  const hayTasa = (resumen.data?.tasa_del_dia ?? null) !== null;
  const facturacion = fiscal.data ?? null;
  const necesitaTalonario = facturacion?.current_regime === "formatos_libres";
  const hayTalonario = (rangos.data ?? []).some(
    (r) => r.kind === "invoice" && r.status === "active",
  );
  const fiscalListo =
    facturacion !== null &&
    facturacion.current_regime !== null &&
    (!conRif || facturacion.sales_mode !== "facturas" || tipoContribuyente !== null) &&
    (facturacion.current_regime === "sin_emision" ||
      facturacion.sales_mode === "recibos" ||
      (facturacion.iva_general !== null && (!necesitaTalonario || hayTalonario)));

  const pasos: { titulo: string; listo: boolean; saltable: boolean }[] = [
    { titulo: "Tus productos", listo: hayProductos, saltable: true },
    { titulo: "Tu dinero", listo: hayCuentas, saltable: false },
    { titulo: "La tasa BCV", listo: hayTasa, saltable: false },
    // Sin RIF no hay facturas: el paso es «Tus recibos» (regla del dueño, 2026-09-16).
    { titulo: conRif ? "Tus facturas" : "Tus recibos", listo: fiscalListo, saltable: false },
  ];
  const todoListo = pasos.every((p) => p.listo);
  // La puerta de salida abre cuando lo OBLIGATORIO está listo: productos es
  // saltable a propósito (se puede vender describiendo la venta), y a pantalla
  // completa un último paso «listo» sin botón de salida es una pared.
  const listoParaVender = pasos.every((p) => p.listo || p.saltable);

  // P10 del registro premium: /empezar habla el MISMO idioma visual — pantalla
  // completa, una cosa a la vez, progreso fino, transición suave. La LÓGICA no
  // cambió: mismos pasos, mismas consultas, mismos endpoints; solo la piel.
  const AYUDAS = [
    "Con dos o tres basta para arrancar. Puedes traerlos desde Excel.",
    "Dónde te pagan: efectivo, pago móvil, tu cuenta del banco.",
    "Un toque al día y todos tus precios quedan al día.",
    conRif
      ? "Cómo factura tu negocio, con su norma delante. Tú decides."
      : "Tus ventas salen como recibos. Cuando tengas RIF, das facturas.",
  ];
  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-background">
      <header className="sticky top-0 z-10 bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-4 px-6">
          <LogoLadino alto="h-6" />
          {/* La escalera, en versión hilo: estado REAL de cada paso, clicable. */}
          <div className="flex flex-1 items-center justify-center gap-1.5">
            {pasos.map((p, i) => (
              <button
                key={p.titulo}
                onClick={() => setPaso(i)}
                aria-label={`${p.titulo}${p.listo ? " — listo" : ""}`}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  paso === i ? "w-10" : "w-6"
                } ${p.listo ? "bg-accent" : paso === i ? "bg-border-strong" : "bg-border"}`}
              />
            ))}
          </div>
          <button
            onClick={() => void navigate("/")}
            className="rounded-md px-2 py-1 text-[0.82rem] text-faint-foreground transition-colors hover:text-foreground"
          >
            Ir a la app
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-6 pb-24 pt-8">
        <div key={paso} className="motion-safe:animate-[empezar-entrar_240ms_ease-out]">
          <div className="mb-6 text-center">
            <p className="text-[0.82rem] font-medium uppercase tracking-wider text-faint-foreground">
              Paso {paso + 1} de {pasos.length}
              {pasos[paso]!.listo ? " · listo" : ""}
            </p>
            <h1 className="mt-1 text-balance text-[2rem] font-semibold leading-tight tracking-tight">
              {pasos[paso]!.titulo}
            </h1>
            <p className="mt-2 text-[0.98rem] text-muted-foreground">{AYUDAS[paso]}</p>
          </div>

          {paso === 0 && (
            <PasoProductos
              hayProductos={hayProductos}
              total={productos.data?.total ?? 0}
              onCambio={recargar}
              onSeguir={() => setPaso(1)}
            />
          )}
          {paso === 1 && (
            <PasoCuentas
              cuentas={cuentas.data?.accounts ?? []}
              onCambio={recargar}
              onSeguir={() => setPaso(2)}
            />
          )}
          {paso === 2 && (
            <PasoTasa
              tasa={resumen.data?.tasa_del_dia ?? null}
              onCambio={recargar}
              onSeguir={() => setPaso(3)}
            />
          )}
          {paso === 3 && fiscal.isError && (
            <Card role="alert">
              <CardContent className="py-6 text-center">
                <p className="font-medium">No se pudo cargar cómo factura tu negocio</p>
                <p className="mx-auto mt-1 max-w-sm text-[0.9rem] text-muted-foreground">
                  {errorDePersona(fiscal.error)}
                </p>
                <Button variant="secondary" className="mt-3" onClick={() => void fiscal.refetch()}>
                  Reintentar
                </Button>
              </CardContent>
            </Card>
          )}
          {paso === 3 && facturacion !== null && (
            <PasoFacturas
              setup={facturacion}
              hayTalonario={hayTalonario}
              tipoContribuyente={conRif ? tipoContribuyente : "no_aplica"}
              onCambio={() => {
                recargar();
                void miEmpresa.refetch();
              }}
            />
          )}
        </div>

        {listoParaVender && (
          <Card className="mt-6 border-success-soft-foreground/40">
            <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div>
                <p className="font-medium">¡Listo! Tu negocio ya puede vender.</p>
                <p className="text-[0.9rem] text-muted-foreground">
                  {todoListo
                    ? "Lo demás se va ajustando sobre la marcha."
                    : "Puedes vender describiendo la venta y cargar tus productos después."}
                </p>
              </div>
              <Button variant="primary" size="lg" onClick={() => void navigate("/vender")}>
                <Store /> Ir a vender
              </Button>
            </CardContent>
          </Card>
        )}
      </main>
      <style>{`@keyframes empezar-entrar { from { opacity: 0; transform: translateX(24px) } to { opacity: 1; transform: none } }`}</style>
    </div>
  );
}

function PasoProductos({
  hayProductos,
  total,
  onCambio,
  onSeguir,
}: {
  hayProductos: boolean;
  total: number;
  onCambio: () => void;
  onSeguir: () => void;
}): React.JSX.Element {
  const [alta, setAlta] = useState(false);
  const [importar, setImportar] = useState(false);
  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <div>
          <h2 className="text-[1.05rem] font-semibold">¿Qué vendes?</h2>
          <p className="mt-1 text-[0.9rem] text-muted-foreground">
            {hayProductos
              ? `Ya tienes ${total} producto${total === 1 ? "" : "s"}. Puedes agregar más o seguir.`
              : "Agrega tus productos con foto y precio, o tráelos todos de una vez desde Excel. Si prefieres, hazlo después: también se puede vender describiendo la venta."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => setAlta(true)}>
            <Plus /> Agregar producto
          </Button>
          <Button variant="secondary" onClick={() => setImportar(true)}>
            <FileSpreadsheet /> Traer desde Excel
          </Button>
          <Button variant="ghost" onClick={onSeguir}>
            {hayProductos ? "Seguir" : "Lo hago después"} <ChevronRight />
          </Button>
        </div>
        {alta && (
          <AltaSimple
            onCerrar={() => setAlta(false)}
            onCreado={() => {
              setAlta(false);
              onCambio();
            }}
          />
        )}
        {importar && (
          <ImportarExcel
            onCerrar={() => setImportar(false)}
            onListo={() => {
              setImportar(false);
              onCambio();
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function PasoCuentas({
  cuentas,
  onCambio,
  onSeguir,
}: {
  cuentas: { id: string; name: string; currency: string }[];
  onCambio: () => void;
  onSeguir: () => void;
}): React.JSX.Element {
  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <div>
          <h2 className="text-[1.05rem] font-semibold">¿Dónde guardas tu dinero?</h2>
          <p className="mt-1 text-[0.9rem] text-muted-foreground">
            La caja del local, el banco, el Zelle. Cada cobro va a caer en una de estas cuentas —
            por eso este paso no se puede saltar.
          </p>
        </div>
        {cuentas.length > 0 && (
          <ul className="space-y-1.5">
            {cuentas.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[0.9rem]"
              >
                <Check className="size-4 text-success-soft-foreground" />
                {c.name} · {c.currency}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <CrearCuenta onCreada={onCambio} />
          <Button variant="primary" disabled={cuentas.length === 0} onClick={onSeguir}>
            Seguir <ChevronRight />
          </Button>
          {cuentas.length === 0 && (
            <span className="text-[0.82rem] text-muted-foreground">
              Crea al menos una para seguir.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PasoTasa({
  tasa,
  onCambio,
  onSeguir,
}: {
  tasa: { rate: string; rate_date: string; es_de_hoy: boolean } | null;
  onCambio: () => void;
  onSeguir: () => void;
}): React.JSX.Element {
  const { llamar } = useSesion();
  const toast = useToast();

  // Solo existe la tasa del BCV (ADR-0064 §1): se actualiza sola y este botón la pide ya. No se
  // escribe a mano: un día sin publicación rige la última tasa del BCV.
  const traerBcv = useMutation({
    mutationFn: () =>
      llamar<{ rate: string }>("/v1/exchange-rates/bcv", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      }),
    onSuccess: (r) => {
      toast.success("Tasa BCV traída", tasaLimpia(r.rate));
      onCambio();
    },
    onError: (e) => toast.error("No se pudo traer la tasa", errorDePersona(e)),
  });

  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <div>
          <h2 className="text-[1.05rem] font-semibold">La tasa BCV</h2>
          <p className="mt-1 text-[0.9rem] text-muted-foreground">
            Con ella Ladino convierte tus precios en dólares a bolívares. Se actualiza sola cada
            día; la ves en «Mi dinero».
          </p>
        </div>
        {tasa !== null ? (
          <p className="flex items-center gap-2 text-[0.95rem]">
            <Check className="size-4 text-success-soft-foreground" />
            {tasaLimpia(tasa.rate)}
            {!tasa.es_de_hoy && (
              <span className="text-muted-foreground">
                · la última publicada, del {fechaLocal(tasa.rate_date)}
              </span>
            )}
          </p>
        ) : (
          <p className="text-[0.9rem] text-muted-foreground">Todavía no llegó la tasa del BCV.</p>
        )}
        {(tasa === null || !tasa.es_de_hoy) && (
          <Button
            variant={tasa === null ? "primary" : "secondary"}
            disabled={traerBcv.isPending}
            onClick={() => traerBcv.mutate()}
          >
            {traerBcv.isPending ? "Consultando…" : "Traer del BCV"}
          </Button>
        )}
        <Button variant="ghost" disabled={tasa === null} onClick={onSeguir}>
          Seguir <ChevronRight />
        </Button>
      </CardContent>
    </Card>
  );
}

function PasoFacturas({
  setup,
  hayTalonario,
  tipoContribuyente,
  onCambio,
}: {
  setup: SetupFiscal;
  hayTalonario: boolean;
  /** El de la empresa con RIF (null si falta); «no_aplica» sin RIF. */
  tipoContribuyente: string | null;
  onCambio: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  // La PRIMERA pregunta (migración 37): ¿ya tienes RIF? Sin RIF no existe
  // factura (art. 13.5) — pero el negocio arranca HOY vendiendo con recibos.
  // Si el registro ya trajo el RIF (no es PEND-*), no se vuelve a preguntar: la ferretería que
  // cargó J-… en el registro veía otra vez «¿Tu negocio ya tiene RIF?» y podía responder
  // «Todavía no» teniéndolo (QA de pantalla 2026-09-15, h. 53).
  // LA REGLA (dueño, 2026-09-16): con RIF facturas, sin RIF recibos. Ya no se pregunta
  // «¿tienes RIF?»: lo dice la empresa. Quien lo saca, lo pone en Configuración y vuelve.
  const rifDelRegistro = tieneRifEmpresa(empresa);
  const [tieneRif, setTieneRif] = useState<boolean | null>(rifDelRegistro);
  // Y si viene del modo recibos con su RIF nuevo, este flag reabre el flujo.
  const [activandoFacturacion, setActivandoFacturacion] = useState(false);
  // Las dos preguntas que deciden la vía (PA 00071): a quién le vendes, y si
  // tienes máquina fiscal. La persona nunca ve la palabra técnica.
  const [vendeA, setVendeA] = useState<"negocios" | "personas" | "mitad" | null>(null);
  const [maquina, setMaquina] = useState<boolean | null>(null);
  // VACÍO a propósito: el porcentaje lo escribe la persona. Un «16» puesto
  // por Ladino era un porcentaje que se aceptaba sin haberla tecleado
  // (auditoría 2026-09-11); el número vigente va en la AYUDA, con su fuente.
  const [porcentaje, setPorcentaje] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [serie, setSerie] = useState("A");
  const [imprenta, setImprenta] = useState("");
  // El domicilio fiscal (art. 13.5): la factura lo lleva, así que se pide
  // ANTES de elegir cómo facturar. La sesión se refresca al recargar; mientras
  // tanto este flag local evita pedirlo dos veces.
  const [direccion, setDireccion] = useState("");
  const [direccionGuardada, setDireccionGuardada] = useState(false);
  const hayDomicilio = empresa.fiscal_address !== null || direccionGuardada;

  const vigente = setup.regimes.find((r) => r.code === setup.current_regime) ?? null;
  const formaLibre = setup.regimes.find((r) => r.code === "formatos_libres") ?? null;

  const guardarDomicilio = useMutation({
    mutationFn: () =>
      llamar("/v1/companies/fiscal-address", {
        method: "PUT",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ fiscal_address: direccion.trim() }),
      }),
    onSuccess: () => {
      toast.success("Dirección guardada");
      setDireccionGuardada(true);
      onCambio();
    },
    onError: (e) => toast.error("No se pudo guardar la dirección", errorDePersona(e)),
  });

  const asignar = useMutation({
    mutationFn: (code: string) =>
      llamar("/v1/fiscal/regime", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ regime_code: code }),
      }),
    onSuccess: () => {
      toast.success("Guardado");
      onCambio();
    },
    onError: (e) => toast.error("No se pudo guardar", errorDePersona(e)),
  });

  const aceptar = useMutation({
    mutationFn: () => {
      const fraccion = porcentajeAFraccion(porcentaje);
      if (fraccion === null) throw new Error("Escribe el porcentaje como un número: 16, o 12,5.");
      return llamar("/v1/fiscal/iva-general", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ rate: fraccion }),
      });
    },
    onSuccess: () => {
      toast.success("Quedó registrado con tu usuario y la fecha de hoy");
      onCambio();
    },
    onError: (e) => toast.error("No se pudo registrar", errorDePersona(e)),
  });

  const talonario = useMutation({
    mutationFn: () =>
      llamar("/v1/fiscal-number-ranges", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          kind: "invoice",
          series: serie.trim() === "" ? "A" : serie.trim(),
          range_from: desde.trim(),
          range_to: hasta.trim(),
          printer_source: imprenta.trim(),
        }),
      }),
    onSuccess: () => {
      toast.success("Talonario registrado");
      onCambio();
    },
    onError: (e) => toast.error("No se pudo registrar el talonario", errorDePersona(e)),
  });

  return (
    <Card>
      <CardContent className="space-y-5 py-5">
        <div>
          {rifDelRegistro ? (
            <>
              <h2 className="text-[1.05rem] font-semibold">¿Vas a dar facturas?</h2>
              <p className="mt-1 text-[0.9rem] text-muted-foreground">
                Esto define cómo emite tu negocio. Se elige UNA vez: si más adelante cambia, se hace
                con tu contador desde el mundo de administración.
              </p>
            </>
          ) : (
            <>
              <h2 className="text-[1.05rem] font-semibold">Tus recibos</h2>
              <p className="mt-1 text-[0.9rem] text-muted-foreground">
                Sin RIF, cada venta sale con un recibo para tu cliente.
              </p>
            </>
          )}
        </div>

        {/* El domicilio fiscal va primero: la factura lo lleva (art. 13.5).
            Solo aplica al camino CON RIF — el recibo no es factura. */}
        {tieneRif === true && !hayDomicilio && (
          <div className="space-y-2 rounded-md border border-border bg-surface-muted/40 p-3">
            <p className="text-[0.9rem]">
              Antes de nada: la <span className="font-medium">dirección fiscal</span> de tu negocio.
              Va impresa en cada factura.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <FormField label="Dirección fiscal" required>
                {(p) => (
                  <Input
                    {...p}
                    value={direccion}
                    onChange={(e) => setDireccion(e.target.value)}
                    placeholder="Av. Bolívar, local 3, Valencia"
                    className="w-full sm:w-72"
                  />
                )}
              </FormField>
              <Button
                variant="primary"
                disabled={direccion.trim().length < 5 || guardarDomicilio.isPending}
                onClick={() => guardarDomicilio.mutate()}
              >
                Guardar dirección
              </Button>
            </div>
          </div>
        )}

        {setup.current_regime === null ||
        (setup.sales_mode === "recibos" && activandoFacturacion) ? (
          <div className="space-y-4">
            {rifDelRegistro ? (
              <p className="text-[0.9rem] text-muted-foreground">
                Tu RIF ya está cargado desde el registro. Solo falta decir cómo facturas.
              </p>
            ) : (
              <div className="space-y-1.5">
                <p className="font-medium" id="empezar-rif-titulo">
                  ¿Tu negocio ya tiene RIF?
                </p>
                <div
                  className="flex gap-1.5"
                  role="radiogroup"
                  aria-labelledby="empezar-rif-titulo"
                >
                  {(
                    [
                      [true, "Sí"],
                      [false, "Todavía no"],
                    ] as const
                  ).map(([valor, etiqueta]) => (
                    <button
                      key={etiqueta}
                      type="button"
                      role="radio"
                      aria-checked={tieneRif === valor}
                      onClick={() => setTieneRif(valor)}
                      className={`rounded-full border px-4 py-1.5 text-[0.88rem] ${
                        tieneRif === valor
                          ? "border-accent bg-accent-soft text-accent-soft-foreground"
                          : "border-border bg-surface hover:border-accent"
                      }`}
                    >
                      {etiqueta}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {tieneRif === false && (
              <div className="space-y-3 rounded-md border border-border bg-surface-muted/40 p-3">
                <p className="text-[0.92rem]">
                  Puedes usar todo Ladino desde hoy: vender con recibos, inventario, clientes,
                  deudas, cuentas y gastos. Cuando tengas tu RIF, activas la facturación en minutos.
                </p>
                <p className="text-[0.82rem] text-muted-foreground">
                  Tus ventas saldrán como <span className="font-medium">recibos</span>. El día que
                  saques tu RIF, lo pones en Configuración y empiezas a dar facturas.
                </p>
                <Button
                  variant="primary"
                  disabled={asignar.isPending}
                  onClick={() => asignar.mutate("sin_facturacion")}
                >
                  Vender con recibos desde hoy
                </Button>
              </div>
            )}

            {tieneRif === true && (
              // `inert`, no `pointer-events-none`: sin domicilio el bloque
              // queda fuera del teclado y del lector de pantalla también.
              <div
                className={`space-y-4 ${hayDomicilio ? "" : "opacity-50"}`}
                inert={!hayDomicilio}
              >
                <div className="space-y-1.5">
                  <p className="font-medium" id="empezar-vende-titulo">
                    ¿A quién le vendes principalmente?
                  </p>
                  <div
                    className="flex flex-wrap gap-1.5"
                    role="radiogroup"
                    aria-labelledby="empezar-vende-titulo"
                  >
                    {(
                      [
                        ["negocios", "A negocios y empresas"],
                        ["personas", "A personas"],
                        ["mitad", "Mitad y mitad"],
                      ] as const
                    ).map(([clave, etiqueta]) => (
                      <button
                        key={clave}
                        type="button"
                        role="radio"
                        aria-checked={vendeA === clave}
                        onClick={() => setVendeA(clave)}
                        className={`rounded-full border px-3 py-1.5 text-[0.88rem] ${
                          vendeA === clave
                            ? "border-accent bg-accent-soft text-accent-soft-foreground"
                            : "border-border bg-surface hover:border-accent"
                        }`}
                      >
                        {etiqueta}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <p className="font-medium" id="empezar-maquina-titulo">
                    ¿Tienes máquina fiscal?
                  </p>
                  <div
                    className="flex gap-1.5"
                    role="radiogroup"
                    aria-labelledby="empezar-maquina-titulo"
                  >
                    {(
                      [
                        [false, "No"],
                        [true, "Sí"],
                      ] as const
                    ).map(([valor, etiqueta]) => (
                      <button
                        key={etiqueta}
                        type="button"
                        role="radio"
                        aria-checked={maquina === valor}
                        onClick={() => setMaquina(valor)}
                        className={`rounded-full border px-4 py-1.5 text-[0.88rem] ${
                          maquina === valor
                            ? "border-accent bg-accent-soft text-accent-soft-foreground"
                            : "border-border bg-surface hover:border-accent"
                        }`}
                      >
                        {etiqueta}
                      </button>
                    ))}
                  </div>
                </div>

                {maquina === true && (
                  <div className="rounded-md border border-border bg-surface-muted/40 p-3 text-[0.9rem]">
                    <p className="font-medium">Ladino todavía no imprime por máquina fiscal.</p>
                    <p className="mt-1 text-muted-foreground">
                      Puedes usar todo lo demás — inventario, clientes, cuentas, compras, tu dinero
                      — y facturar por tu máquina mientras tanto. Cuando esa función llegue, te
                      avisamos.
                    </p>
                  </div>
                )}
                {maquina === false && (vendeA === "personas" || vendeA === "mitad") && (
                  <div className="rounded-md border border-warning-soft-foreground/40 bg-warning-soft p-3 text-[0.9rem] text-warning-soft-foreground">
                    <p className="font-medium">Un aviso importante</p>
                    <p className="mt-1">
                      Por tu tipo de negocio, es posible que la ley te exija máquina fiscal (PA
                      SNAT/2011/00071, art. 8: ventas del año pasado sobre 1.500 UT, ventas
                      mayormente a consumidor final y actividad listada — las tres a la vez; algunas
                      actividades la exigen sin importar el ingreso). Confírmalo con tu contador — y
                      si te aplica, avísanos: estamos preparando esa función.
                    </p>
                  </div>
                )}
                {maquina === false && formaLibre !== null && vendeA !== null && (
                  <p className="text-[0.78rem] text-faint-foreground">
                    Facturarás con formatos libres de imprenta autorizada ·{" "}
                    {formaLibre.legal_source}
                  </p>
                )}

                <Button
                  variant="primary"
                  disabled={vendeA === null || maquina === null || asignar.isPending}
                  onClick={() =>
                    asignar.mutate(maquina === true ? "sin_emision" : "formatos_libres")
                  }
                >
                  {maquina === true ? "Entendido, sigo sin facturar desde Ladino" : "Así facturo"}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            <p className="flex items-center gap-2 text-[0.95rem]">
              <Check className="size-4 text-success-soft-foreground" />
              {setup.sales_mode === "recibos"
                ? "Vendes con recibos"
                : (vigente?.name ?? setup.current_regime)}
              {vigente !== null && setup.sales_mode !== "recibos" && (
                <span className="text-[0.78rem] text-faint-foreground">
                  · {vigente.legal_source}
                </span>
              )}
            </p>
            {setup.current_regime === "sin_emision" && (
              <p className="text-[0.85rem] text-muted-foreground">
                Facturas por tu máquina fiscal; Ladino te lleva todo lo demás. Si eso cambia, se
                ajusta desde el mundo de administración.
              </p>
            )}
            {setup.sales_mode === "recibos" && (
              <div className="space-y-2">
                <p className="text-[0.85rem] text-muted-foreground">
                  Todo lo demás — inventario, clientes, deudas, cuentas, gastos — funciona completo.
                </p>
                {rifDelRegistro ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setTieneRif(true);
                      setActivandoFacturacion(true);
                    }}
                  >
                    Ya puse mi RIF: activar facturas
                  </Button>
                ) : (
                  <Link
                    to="/admin/configuracion"
                    className="inline-block text-[0.85rem] text-accent-soft-foreground underline"
                  >
                    ¿Ya sacaste tu RIF? Ponlo aquí
                  </Link>
                )}
              </div>
            )}
          </div>
        )}

        {/* Con RIF y facturando: el tipo de contribuyente, que las compras necesitan (h. 62). */}
        {setup.sales_mode === "facturas" && tipoContribuyente !== "no_aplica" && (
          <TipoDeContribuyente actual={tipoContribuyente} onCambio={onCambio} />
        )}

        {setup.current_regime !== null &&
          setup.current_regime !== "sin_emision" &&
          setup.sales_mode !== "recibos" && (
            <IvaQueCobras
              aceptado={
                setup.iva_general !== null ? fraccionAPorcentaje(setup.iva_general.rate) : null
              }
              valor={porcentaje}
              onValor={setPorcentaje}
              puedeAceptar={!aceptar.isPending && porcentajeAFraccion(porcentaje) !== null}
              onAceptar={() => aceptar.mutate()}
            />
          )}

        {setup.current_regime === "formatos_libres" && setup.iva_general !== null && (
          <div className="space-y-2 border-t border-border pt-4">
            <h3 className="font-medium">Tu talonario de la imprenta</h3>
            {hayTalonario ? (
              <p className="flex items-center gap-2 text-[0.95rem]">
                <Check className="size-4 text-success-soft-foreground" />
                Talonario registrado. Cuando se acabe, registras el siguiente desde administración.
              </p>
            ) : (
              <>
                <p className="text-[0.9rem] text-muted-foreground">
                  Tus facturas vienen impresas con números. Dime el primero y el último del
                  talonario, y de qué imprenta es.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <FormField label="Del número">
                    {(p) => (
                      <Input
                        {...p}
                        value={desde}
                        onChange={(e) => setDesde(e.target.value)}
                        inputMode="numeric"
                        placeholder="1"
                      />
                    )}
                  </FormField>
                  <FormField label="Al número">
                    {(p) => (
                      <Input
                        {...p}
                        value={hasta}
                        onChange={(e) => setHasta(e.target.value)}
                        inputMode="numeric"
                        placeholder="5000"
                      />
                    )}
                  </FormField>
                  <FormField label="Serie (como aparece impresa)">
                    {(p) => (
                      <Input {...p} value={serie} onChange={(e) => setSerie(e.target.value)} />
                    )}
                  </FormField>
                  <FormField label="Imprenta">
                    {(p) => (
                      <Input
                        {...p}
                        value={imprenta}
                        onChange={(e) => setImprenta(e.target.value)}
                        placeholder="Gráficas El Sol, C.A."
                      />
                    )}
                  </FormField>
                </div>
                <Button
                  variant="primary"
                  disabled={
                    talonario.isPending ||
                    !/^\d+$/.test(desde.trim()) ||
                    !/^\d+$/.test(hasta.trim()) ||
                    imprenta.trim() === ""
                  }
                  onClick={() => talonario.mutate()}
                >
                  <Package /> Registrar talonario
                </Button>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
