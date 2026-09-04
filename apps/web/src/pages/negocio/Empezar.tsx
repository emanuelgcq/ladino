import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  CircleDashed,
  FileSpreadsheet,
  Package,
  Plus,
  Store,
} from "lucide-react";
import { useSesion } from "../../app/session.js";
import { errorDePersona } from "../../lib.js";
import { mostrarCantidad } from "../../money.js";
import { Button } from "../../ui/button.js";
import { Card, CardContent } from "../../ui/card.js";
import { Input } from "../../ui/input.js";
import { useToast } from "../../ui/toast.js";
import { FormField } from "../../components/forms.js";
import { AltaSimple, ImportarExcel } from "./Productos.js";
import { CrearCuenta } from "./Dinero.js";
import { porcentajeAFraccion, fraccionAPorcentaje } from "./comunes.js";

/**
 * EMPEZAR (Fase C, PARTE 4): el primer día del negocio en cuatro pasos. Cada
 * paso lee su estado del servidor y se marca solo; el de productos se puede
 * saltar, el del dinero no — sin una cuenta no hay dónde caer un cobro.
 *
 * El paso fiscal es el delicado: Ladino NO decide cómo facturas ni qué IVA
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
  iva_general: { rate: string; legal_source: string } | null;
}
interface Resumen {
  tasa_del_dia: { rate: string; source: string; es_de_hoy: boolean } | null;
}

export function Empezar(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
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
  const hayTasa = resumen.data?.tasa_del_dia?.es_de_hoy === true;
  const facturacion = fiscal.data ?? null;
  const necesitaTalonario = facturacion?.current_regime === "formatos_libres";
  const hayTalonario = (rangos.data ?? []).some(
    (r) => r.kind === "invoice" && r.status === "active",
  );
  const fiscalListo =
    facturacion !== null &&
    facturacion.current_regime !== null &&
    (facturacion.current_regime === "sin_emision" ||
      (facturacion.iva_general !== null && (!necesitaTalonario || hayTalonario)));

  const pasos: { titulo: string; listo: boolean; saltable: boolean }[] = [
    { titulo: "Tus productos", listo: hayProductos, saltable: true },
    { titulo: "Tu dinero", listo: hayCuentas, saltable: false },
    { titulo: "La tasa del día", listo: hayTasa, saltable: false },
    { titulo: "Tus facturas", listo: fiscalListo, saltable: false },
  ];
  const todoListo = pasos.every((p) => p.listo);

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Empezar</h1>
        <p className="mt-1 text-[0.95rem] text-muted-foreground">
          Cuatro pasos y quedas listo para vender. Puedes salir y volver: cada paso queda guardado.
        </p>
      </div>

      {/* La escalera: cada paso con su estado real, tomado del servidor. */}
      <div className="flex items-center gap-1.5">
        {pasos.map((p, i) => (
          <button
            key={p.titulo}
            onClick={() => setPaso(i)}
            className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-[0.82rem] ${
              paso === i
                ? "border-accent bg-accent-soft text-accent-soft-foreground"
                : "border-border bg-surface text-muted-foreground hover:text-foreground"
            }`}
          >
            {p.listo ? (
              <Check className="size-4 text-success-soft-foreground" />
            ) : (
              <CircleDashed className="size-4" />
            )}
            <span className="truncate">{p.titulo}</span>
          </button>
        ))}
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
      {paso === 3 && facturacion !== null && (
        <PasoFacturas setup={facturacion} hayTalonario={hayTalonario} onCambio={recargar} />
      )}

      {todoListo && (
        <Card className="border-success-soft-foreground/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div>
              <p className="font-medium">¡Listo! Tu negocio ya puede vender.</p>
              <p className="text-[0.9rem] text-muted-foreground">
                Lo demás se va ajustando sobre la marcha.
              </p>
            </div>
            <Button variant="primary" size="lg" onClick={() => void navigate("/vender")}>
              <Store /> Ir a vender
            </Button>
          </CardContent>
        </Card>
      )}
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
  tasa: { rate: string; source: string; es_de_hoy: boolean } | null;
  onCambio: () => void;
  onSeguir: () => void;
}): React.JSX.Element {
  const { llamar } = useSesion();
  const toast = useToast();
  const [nueva, setNueva] = useState("");

  const confirmar = useMutation({
    mutationFn: () =>
      llamar("/v1/exchange-rates/keep", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ from_currency: "USD", to_currency: "VES" }),
      }),
    onSuccess: () => {
      toast.success("Tasa confirmada para hoy");
      onCambio();
    },
    onError: (e) => toast.error("No se pudo confirmar la tasa", errorDePersona(e)),
  });
  const cargar = useMutation({
    mutationFn: () =>
      llamar("/v1/exchange-rates", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          from_currency: "USD",
          to_currency: "VES",
          rate: nueva.trim().replace(",", "."),
          source: "Carga manual del negocio",
          // El día LOCAL de la persona, no el de UTC (CLAUDE.md §3).
          rate_date: new Date().toLocaleDateString("en-CA"),
        }),
      }),
    onSuccess: () => {
      toast.success("Tasa del día guardada");
      setNueva("");
      onCambio();
    },
    onError: (e) => toast.error("No se pudo guardar la tasa", errorDePersona(e)),
  });
  // El camino de UN clic: la oficial del BCV, vía DolarAPI, con fuente y día
  // publicados. El manual queda como fallback para cuando no haya internet.
  const traerBcv = useMutation({
    mutationFn: () =>
      llamar<{ rate: string }>("/v1/exchange-rates/bcv", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      }),
    onSuccess: (r) => {
      toast.success("Tasa del BCV traída", `Bs. ${mostrarCantidad(r.rate)} por dólar`);
      onCambio();
    },
    onError: (e) => toast.error("No se pudo traer la tasa", errorDePersona(e)),
  });

  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <div>
          <h2 className="text-[1.05rem] font-semibold">La tasa del día</h2>
          <p className="mt-1 text-[0.9rem] text-muted-foreground">
            Con ella Ladino convierte tus precios en dólares a bolívares. Se confirma cada día desde
            «Mi dinero» — hoy la dejamos puesta.
          </p>
        </div>
        {tasa !== null && tasa.es_de_hoy ? (
          <p className="flex items-center gap-2 text-[0.95rem]">
            <Check className="size-4 text-success-soft-foreground" />
            Hoy: Bs. {mostrarCantidad(tasa.rate)} por dólar · {tasa.source}
          </p>
        ) : (
          <div className="space-y-3">
            <Button
              variant="primary"
              disabled={traerBcv.isPending}
              onClick={() => traerBcv.mutate()}
            >
              {traerBcv.isPending ? "Consultando…" : "Traer la oficial del BCV"}
            </Button>
            {tasa !== null && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[0.9rem]">
                  La última fue Bs. {mostrarCantidad(tasa.rate)} por dólar.
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={confirmar.isPending}
                  onClick={() => confirmar.mutate()}
                >
                  Sigue igual
                </Button>
              </div>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <FormField label="O escríbela tú (Bs. por dólar)">
                {(p) => (
                  <Input
                    {...p}
                    value={nueva}
                    onChange={(e) => setNueva(e.target.value)}
                    placeholder="0,00"
                    inputMode="decimal"
                    className="w-40"
                  />
                )}
              </FormField>
              <Button
                variant="primary"
                disabled={nueva.trim() === "" || cargar.isPending}
                onClick={() => cargar.mutate()}
              >
                Guardar tasa
              </Button>
            </div>
          </div>
        )}
        <Button variant="ghost" disabled={tasa === null || !tasa.es_de_hoy} onClick={onSeguir}>
          Seguir <ChevronRight />
        </Button>
      </CardContent>
    </Card>
  );
}

function PasoFacturas({
  setup,
  hayTalonario,
  onCambio,
}: {
  setup: SetupFiscal;
  hayTalonario: boolean;
  onCambio: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  // Las dos preguntas que deciden la vía (PA 00071): a quién le vendes, y si
  // tienes máquina fiscal. La persona nunca ve la palabra técnica.
  const [vendeA, setVendeA] = useState<"negocios" | "personas" | "mitad" | null>(null);
  const [maquina, setMaquina] = useState<boolean | null>(null);
  const [porcentaje, setPorcentaje] = useState("16");
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
          <h2 className="text-[1.05rem] font-semibold">¿Vas a dar facturas?</h2>
          <p className="mt-1 text-[0.9rem] text-muted-foreground">
            Esto define cómo emite tu negocio. Se elige UNA vez: si más adelante cambia, se hace con
            tu contador desde el mundo de administración.
          </p>
        </div>

        {/* El domicilio fiscal va primero: la factura lo lleva (art. 13.5). */}
        {!hayDomicilio && (
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
                    className="w-72"
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

        {setup.current_regime === null ? (
          <div className={`space-y-4 ${hayDomicilio ? "" : "pointer-events-none opacity-50"}`}>
            <div className="space-y-1.5">
              <p className="font-medium">¿A quién le vendes principalmente?</p>
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ["negocios", "A negocios y empresas"],
                    ["personas", "A personas"],
                    ["mitad", "Mitad y mitad"],
                  ] as const
                ).map(([clave, etiqueta]) => (
                  <button
                    key={clave}
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
              <p className="font-medium">¿Tienes máquina fiscal?</p>
              <div className="flex gap-1.5">
                {(
                  [
                    [false, "No"],
                    [true, "Sí"],
                  ] as const
                ).map(([valor, etiqueta]) => (
                  <button
                    key={etiqueta}
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
                  Puedes usar todo lo demás — inventario, clientes, cuentas, compras, tu dinero — y
                  facturar por tu máquina mientras tanto. Cuando esa función llegue, te avisamos.
                </p>
              </div>
            )}
            {maquina === false && (vendeA === "personas" || vendeA === "mitad") && (
              <div className="rounded-md border border-warning-soft-foreground/40 bg-warning-soft p-3 text-[0.9rem] text-warning-soft-foreground">
                <p className="font-medium">Un aviso importante</p>
                <p className="mt-1">
                  Por tu tipo de negocio, es posible que la ley te exija máquina fiscal (art. 8, PA
                  00071: ventas del año pasado sobre 1.500 UT, ventas mayormente a consumidor final
                  y actividad listada — las tres a la vez; algunas actividades la exigen sin
                  importar el ingreso). Confírmalo con tu contador — y si te aplica, avísanos:
                  estamos preparando esa función.
                </p>
              </div>
            )}
            {maquina === false && formaLibre !== null && vendeA !== null && (
              <p className="text-[0.78rem] text-faint-foreground">
                Facturarás con formatos libres de imprenta autorizada · {formaLibre.legal_source}
              </p>
            )}

            <Button
              variant="primary"
              disabled={vendeA === null || maquina === null || asignar.isPending}
              onClick={() => asignar.mutate(maquina === true ? "sin_emision" : "formatos_libres")}
            >
              {maquina === true ? "Entendido, sigo sin facturar desde Ladino" : "Así facturo"}
            </Button>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="flex items-center gap-2 text-[0.95rem]">
              <Check className="size-4 text-success-soft-foreground" />
              {vigente?.name ?? setup.current_regime}
              {vigente !== null && (
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
          </div>
        )}

        {setup.current_regime !== null && setup.current_regime !== "sin_emision" && (
          <div className="space-y-2 border-t border-border pt-4">
            <h3 className="font-medium">El IVA que cobras</h3>
            {setup.iva_general !== null ? (
              <p className="flex items-center gap-2 text-[0.95rem]">
                <Check className="size-4 text-success-soft-foreground" />
                Quedó en {fraccionAPorcentaje(setup.iva_general.rate)}%, aceptado por ti.
              </p>
            ) : (
              <>
                <p className="text-[0.9rem] text-muted-foreground">
                  El porcentaje lo fija la ley, no Ladino: escríbelo tú y confírmalo con tu
                  contador. Al aceptar queda registrado con tu usuario y la fecha de hoy, y así
                  aparecerá en la auditoría.
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <FormField label="Porcentaje (%)">
                    {(p) => (
                      <Input
                        {...p}
                        value={porcentaje}
                        onChange={(e) => setPorcentaje(e.target.value)}
                        inputMode="decimal"
                        className="w-28"
                      />
                    )}
                  </FormField>
                  <Button
                    variant="primary"
                    disabled={aceptar.isPending || porcentajeAFraccion(porcentaje) === null}
                    onClick={() => aceptar.mutate()}
                  >
                    Acepto este porcentaje
                  </Button>
                </div>
              </>
            )}
          </div>
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
