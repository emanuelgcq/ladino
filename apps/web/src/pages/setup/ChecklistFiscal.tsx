import { useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed, FlaskConical, ShieldAlert } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { PageHeader } from "../../components/PageHeader.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import {
  FormField,
  MoneyInput,
  DatePicker,
  EntityPicker,
  importeValido,
  type EntityOption,
} from "../../components/forms.js";
import { Button } from "../../ui/button.js";
import { Input } from "../../ui/input.js";
import { SimpleSelect } from "../../ui/select.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card.js";
import { Badge } from "../../ui/badge.js";
import { useToast } from "../../ui/toast.js";
import { LlamadaApiError } from "../../lib.js";
import { mostrarCantidad, mostrarImporte } from "../../money.js";
import { mostrarPorcentaje } from "../../porcentaje.js";
import { MensajeError } from "../ventas/comunes.js";
import { porcentajeAFraccion } from "../negocio/comunes.js";
import { fechaLocal, hoyLocal } from "../../fechas.js";

/**
 * PUESTA A PUNTO FISCAL — R-16 resuelto como diseño.
 *
 * El sistema no puede emitir una factura hasta que alguien cargue: la alícuota
 * de IVA con fuente legal, la tasa BCV, el régimen fiscal y el rango de
 * numeración. Sin esta pantalla, esos cuatro requisitos se descubren como
 * cuatro 409 al intentar emitir — averías aparentes que en realidad son pasos.
 * Aquí cada uno es una casilla con su estado, su acción directa y su sello
 * VALIDAR donde el dato es una afirmación legal que un humano debe confirmar.
 *
 * Los cinco pasos se COMPRUEBAN contra la API: alícuota y régimen salen de
 * `GET /v1/fiscal/setup` (el mismo que usa /empezar), tasa y rango de sus
 * listados. La VERIFICACIÓN REAL de abajo —una cotización de prueba— sigue
 * siendo la prueba de fuego: lee la respuesta del motor, no una casilla.
 */

/** Lo que trae `GET /v1/fiscal/setup` (apps/api/src/routes/fiscal-setup.ts). */
interface RegimenFiscal {
  code: string;
  name: string;
  description: string;
  numbering_mode: string;
  legal_source: string;
}
interface SetupFiscal {
  regimes: RegimenFiscal[];
  current_regime: string | null;
  /** La alícuota general VIGENTE (fracción en string) con su fuente, o null. */
  iva_general: { rate: string; legal_source: string } | null;
}

/** «BCV oficial vía DolarAPI (2026-09-11T00:00:00-04:00)» → «BCV oficial vía DolarAPI». */
function fuenteCorta(source: string): string {
  return source.replace(/\s*\([^)]*\)\s*$/, "");
}
function AlertaRangos(): React.JSX.Element | null {
  const { empresa, llamar } = useSesion();
  // La ruta devuelve el ARRAY directamente (sales.ts): leer `.items` dejaba la
  // alerta muda para siempre (auditoría 2026-09-11).
  const q = useQuery({
    queryKey: ["rangos-agotandose", empresa.id],
    queryFn: () =>
      llamar<
        {
          range_id: string;
          kind: string;
          series: string;
          remaining: number;
          total: number;
          pct_remaining: string;
        }[]
      >("/v1/fiscal-number-ranges/exhaustion"),
  });
  const items = q.data ?? [];
  if (items.length === 0) return null;
  return (
    <div className="mb-4 rounded-md border border-warning-soft bg-warning-soft/40 p-3">
      <p className="text-[0.9rem] font-medium text-warning-soft-foreground">
        Rangos de numeración por agotarse — pide el siguiente a la imprenta ANTES de quedarte sin
        números:
      </p>
      <ul className="mt-1 space-y-0.5 text-[0.88rem]">
        {items.map((r) => (
          <li key={r.range_id} className="tabular-nums">
            Serie {r.series} ({r.kind === "invoice" ? "facturas" : r.kind}): quedan {r.remaining} de{" "}
            {r.total}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChecklistFiscal(): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();

  // La misma clave que /empezar y el POS: una carga aquí se ve allá sin recargar.
  const setup = useQuery({
    queryKey: ["empezar-fiscal", empresa.id],
    queryFn: () => llamar<SetupFiscal>("/v1/fiscal/setup"),
  });
  const tasas = useQuery({
    queryKey: ["tasas", empresa.id, "USD-VES"],
    queryFn: () =>
      llamar<{ rate: string; source: string; rate_date: string }[]>("/v1/exchange-rates"),
  });
  // La «última» tasa es la que usa el dominio: la de `rate_date` más reciente
  // y, a igual fecha, la última creada. La lista llega ordenada por
  // `rate_date desc` y sin `created_at`, así que se toma la primera fila tal
  // como llega. PENDIENTE (contrato): la API ordenará con desempate por
  // creación; hasta entonces, dos tasas del mismo día pueden enseñarse en el
  // orden que Postgres quiera.
  const ultimaTasa = tasas.data?.[0];
  // En un `const` local: el estrechamiento de `setup.data` no sobrevive
  // dentro del callback de `find`, el de una constante sí.
  const datos = setup.data;
  const ivaVigente = datos?.iva_general ?? null;
  const regimenVigente =
    datos === undefined || datos.current_regime === null
      ? null
      : (datos.regimes.find((r) => r.code === datos.current_regime) ?? {
          code: datos.current_regime,
          name: datos.current_regime,
          description: "",
          numbering_mode: "",
          legal_source: "",
        });
  // Solo desde «sin régimen» o «sin facturación» deja la API asignar aquí; el
  // resto es un acto del mundo técnico (/admin/facturacion-fiscal).
  const puedeAsignarRegimen =
    puede("fiscal.regime.manage") &&
    (setup.data?.current_regime === null || setup.data?.current_regime === "sin_facturacion");
  const rangos = useQuery({
    queryKey: ["rangos", empresa.id],
    queryFn: () =>
      llamar<{ id: string; kind: string; series: string; status: string; remaining: number }[]>(
        "/v1/fiscal-number-ranges",
      ),
  });

  const tasaOk = (tasas.data?.length ?? 0) > 0;
  const rangoOk = (rangos.data ?? []).some((r) => r.kind === "invoice" && r.status === "active");
  const contingencias = useQuery({
    queryKey: ["contingencias", empresa.id],
    queryFn: () => llamar<{ items: RangoContingencia[] }>("/v1/fiscal/contingency-ranges"),
  });

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Puesta a punto fiscal"
        description={`Lo que ${empresa.legal_name} necesita antes de su primera factura. Cada paso pendiente responde un 409 al emitir — no es una avería, es esta lista.`}
      />
      <AlertaRangos />

      {/*
        En ORDEN: antes iban los comprobables primero y los manuales al final, y
        la lista se leía «Paso 2, Paso 4, Paso 5, Paso 1, Paso 3». Un número que
        no sigue al anterior no numera nada.
      */}
      <div className="space-y-4">
        <Paso
          numero={1}
          titulo="Alícuota de IVA con fuente legal"
          estado={
            setup.isPending
              ? "cargando"
              : setup.isError
                ? "error"
                : ivaVigente !== null
                  ? "completo"
                  : "pendiente"
          }
          codigo409="TAX_RULE_MISSING"
          resumen={
            setup.isError
              ? "No se pudo consultar la puesta a punto fiscal."
              : ivaVigente !== null
                ? `Alícuota general vigente: ${mostrarPorcentaje(ivaVigente.rate)}. Fuente: ${ivaVigente.legal_source}`
                : "Sin alícuota general vigente: no se emite (ADR-0038 — el sistema no adivina alícuotas). Se carga en /empezar, o aquí mismo si tienes el permiso."
          }
          sello="VALIDAR-SENIAT: la alícuota y su vigencia deben venir de la norma, citada en legal_source."
          extra={
            setup.isError ? (
              <Reintentar error={setup.error} reintentar={() => void setup.refetch()} />
            ) : ivaVigente === null && !puede("tax.rules.manage") ? (
              <EnlaceEmpezar />
            ) : undefined
          }
        >
          {ivaVigente === null && puede("tax.rules.manage") ? <AceptarIva /> : undefined}
        </Paso>

        <Paso
          numero={2}
          titulo="Tasa de cambio BCV"
          estado={
            tasas.isPending
              ? "cargando"
              : tasas.isError
                ? "error"
                : tasaOk
                  ? "completo"
                  : "pendiente"
          }
          codigo409="EXCHANGE_RATE_MISSING"
          resumen={
            tasas.isError
              ? "No se pudieron consultar las tasas."
              : ultimaTasa !== undefined
                ? `Última: ${mostrarCantidad(ultimaTasa.rate)} Bs/USD · ${fuenteCorta(ultimaTasa.source)} · ${fechaLocal(ultimaTasa.rate_date)}`
                : "Sin tasa cargada: cualquier operación en divisa fallará."
          }
          extra={
            tasas.isError ? (
              <Reintentar error={tasas.error} reintentar={() => void tasas.refetch()} />
            ) : puede("fx.rate.manage") ? (
              <TraerDelBcv />
            ) : undefined
          }
        >
          <CargarTasa />
        </Paso>

        <Paso
          numero={3}
          titulo="Régimen fiscal de la empresa"
          estado={
            setup.isPending
              ? "cargando"
              : setup.isError
                ? "error"
                : regimenVigente !== null
                  ? "completo"
                  : "pendiente"
          }
          codigo409="FISCAL_NUMBERING_INVALID"
          resumen={
            setup.isError
              ? "No se pudo consultar la puesta a punto fiscal."
              : regimenVigente !== null
                ? `Régimen vigente: ${regimenVigente.name}${regimenVigente.legal_source === "" ? "" : ` · ${regimenVigente.legal_source}`}. El régimen decide cómo se numera (company_fiscal_regimes, ADR-0029).`
                : "Sin régimen vigente: el régimen (formatos libres, máquina fiscal…) decide cómo se numera. Se asigna en /empezar, o aquí mismo si tienes el permiso."
          }
          sello="VALIDAR-SENIAT: qué régimen corresponde a la empresa lo confirma su contador."
          extra={
            setup.isError ? (
              <Reintentar error={setup.error} reintentar={() => void setup.refetch()} />
            ) : regimenVigente === null && !puedeAsignarRegimen ? (
              <EnlaceEmpezar />
            ) : undefined
          }
        >
          {puedeAsignarRegimen && setup.data !== undefined ? (
            <AsignarRegimen regimenes={setup.data.regimes} />
          ) : undefined}
        </Paso>

        <Paso
          numero={4}
          titulo="Rango de numeración autorizado"
          estado={rangos.isPending ? "cargando" : rangoOk ? "completo" : "pendiente"}
          codigo409="FISCAL_NUMBERING_INVALID"
          resumen={
            rangoOk
              ? `Rangos activos: ${(rangos.data ?? [])
                  .filter((r) => r.status === "active")
                  .map((r) => `${r.kind} ${r.series} (quedan ${r.remaining})`)
                  .join(" · ")}`
              : "Sin rango de la imprenta autorizada no se asigna número de control."
          }
        >
          <CargarRango />
        </Paso>

        <Paso
          numero={5}
          titulo="Contingencia (PA 102)"
          estado={
            contingencias.isPending
              ? "cargando"
              : (contingencias.data?.items.length ?? 0) > 0
                ? "completo"
                : "pendiente"
          }
          codigo409="FISCAL_NUMBERING_INVALID"
          resumen={
            (contingencias.data?.items.length ?? 0) > 0
              ? `Talonarios de contingencia: ${(contingencias.data?.items ?? [])
                  .map(
                    (r) =>
                      `${r.series} (quedan ${r.remaining}${r.failure_ended_at === null ? ", falla abierta" : ""})`,
                  )
                  .join(" · ")}`
              : "Sin talonario físico registrado. Cuando el sistema o la imprenta fallen, se factura en papel y se registra aquí a posteriori."
          }
        >
          <Contingencia rangos={contingencias.data?.items ?? []} />
        </Paso>

        <VerificacionReal />
      </div>
    </div>
  );
}

/** El fallo de una consulta, dicho en voz de persona y con su reintento. */
function Reintentar({
  error,
  reintentar,
}: {
  error: unknown;
  reintentar: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <MensajeError error={error} />
      <Button variant="secondary" size="sm" onClick={reintentar}>
        Reintentar
      </Button>
    </div>
  );
}

/** Quien no tiene el permiso para cargarlo aquí, lo carga (o lo pide) desde el asistente. */
function EnlaceEmpezar(): React.JSX.Element {
  return (
    <p className="text-[0.85rem] text-muted-foreground">
      Se carga desde el asistente:{" "}
      <Link to="/empezar" className="text-accent-soft-foreground underline">
        ir a Empezar →
      </Link>
    </p>
  );
}

function Paso({
  numero,
  titulo,
  estado,
  resumen,
  codigo409,
  sello,
  extra,
  children,
}: {
  numero: number;
  titulo: string;
  estado: "completo" | "pendiente" | "cargando" | "error";
  resumen: string;
  codigo409: string;
  sello?: string;
  /** Lo que se enseña SIEMPRE bajo el resumen (un enlace, un reintento, un botón directo). */
  extra?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  const [abierto, setAbierto] = useState(false);
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2.5">
          {estado === "completo" ? (
            <CheckCircle2 className="size-5 text-accent" />
          ) : (
            <CircleDashed className="size-5 text-faint-foreground" />
          )}
          <CardTitle>
            Paso {numero} · {titulo}
          </CardTitle>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="outline" className="font-mono">
            409 {codigo409}
          </Badge>
          {estado === "completo" && <Badge tone="accent">Completo</Badge>}
          {estado === "pendiente" && <Badge tone="warning">Pendiente</Badge>}
          {estado === "error" && <Badge tone="destructive">Sin comprobar</Badge>}
        </div>
      </CardHeader>
      <CardContent>
        <CardDescription>{resumen}</CardDescription>
        {sello !== undefined && (
          <p className="mt-2 flex items-start gap-1.5 rounded-sm bg-warning-soft px-2.5 py-1.5 text-[0.82rem] text-warning-soft-foreground">
            <ShieldAlert className="mt-px size-3.5 shrink-0" /> {sello}
          </p>
        )}
        {extra !== undefined && <div className="mt-3">{extra}</div>}
        {children !== undefined && (
          <div className="mt-3">
            {abierto ? (
              children
            ) : (
              <Button variant="secondary" size="sm" onClick={() => setAbierto(true)}>
                {estado === "completo" ? "Cargar otra" : "Cargar ahora"}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * ACEPTAR la alícuota general — el mismo acto y el mismo cuerpo que el
 * asistente de /empezar (`POST /v1/fiscal/iva-general`, `{ rate }` como
 * fracción en string). Ladino no la afirma: la escribe y la acepta la persona,
 * y queda su acta con usuario y fecha. Exige `tax.rules.manage` en servidor.
 */
function AceptarIva(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const qc = useQueryClient();
  const toast = useToast();
  const [porcentaje, setPorcentaje] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);

  async function aceptar(): Promise<void> {
    const fraccion = porcentajeAFraccion(porcentaje);
    if (fraccion === null) return;
    setError(null);
    setOcupado(true);
    try {
      await llamar("/v1/fiscal/iva-general", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ rate: fraccion }),
      });
      toast.success("Alícuota aceptada", "Queda en la auditoría con tu usuario y la fecha.");
      await qc.invalidateQueries({ queryKey: ["empezar-fiscal", empresa.id] });
    } catch (e) {
      setError(e);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface-muted/40 p-3">
      <p className="text-[0.88rem] text-muted-foreground">
        El porcentaje lo fija la ley, no Ladino: escríbelo tú y confírmalo con tu contador. Al
        aceptar queda registrado con tu usuario y la fecha de hoy.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <FormField label="Porcentaje (%)" required>
          {(a) => (
            <Input
              id={a.id}
              value={porcentaje}
              onChange={(e) => setPorcentaje(e.target.value)}
              inputMode="decimal"
              className="w-28"
            />
          )}
        </FormField>
        <Button
          variant="primary"
          size="sm"
          disabled={ocupado || porcentajeAFraccion(porcentaje) === null}
          onClick={() => void aceptar()}
        >
          Acepto este porcentaje
        </Button>
      </div>
      {error !== null && <MensajeError error={error} />}
    </div>
  );
}

/**
 * ASIGNAR el régimen — el mismo cuerpo que /empezar (`POST /v1/fiscal/regime`,
 * `{ regime_code }`, y `reason` solo si la empresa ya emitió documentos). El
 * catálogo viene del servidor con su norma citada; aquí no se inventa ninguno.
 * Exige `fiscal.regime.manage` en servidor.
 */
function AsignarRegimen({ regimenes }: { regimenes: RegimenFiscal[] }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const qc = useQueryClient();
  const toast = useToast();
  const [codigo, setCodigo] = useState<string | null>(null);
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);
  const elegido = regimenes.find((r) => r.code === codigo) ?? null;

  async function asignar(): Promise<void> {
    if (codigo === null) return;
    setError(null);
    setOcupado(true);
    try {
      await llamar("/v1/fiscal/regime", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          regime_code: codigo,
          ...(motivo.trim() === "" ? {} : { reason: motivo.trim() }),
        }),
      });
      toast.success("Régimen asignado");
      await qc.invalidateQueries({ queryKey: ["empezar-fiscal", empresa.id] });
    } catch (e) {
      setError(e);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface-muted/40 p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Régimen" required>
          {(a) => (
            <SimpleSelect
              id={a.id}
              value={codigo}
              onValueChange={setCodigo}
              options={regimenes.map((r) => ({ value: r.code, label: r.name }))}
            />
          )}
        </FormField>
        <FormField
          label="Motivo (solo si ya emitiste documentos fiscales)"
          hint="Queda en la auditoría como acta del cambio."
        >
          {(a) => <Input id={a.id} value={motivo} onChange={(e) => setMotivo(e.target.value)} />}
        </FormField>
      </div>
      {elegido !== null && (
        <p className="text-[0.82rem] text-muted-foreground">
          {elegido.description}
          {elegido.legal_source === "" ? "" : ` · ${elegido.legal_source}`}
        </p>
      )}
      {error !== null && <MensajeError error={error} />}
      <Button
        variant="primary"
        size="sm"
        disabled={ocupado || codigo === null}
        onClick={() => void asignar()}
      >
        Asignar el régimen
      </Button>
    </div>
  );
}

/**
 * La tasa OFICIAL, traída del adaptador BCV del servidor (`POST
 * /v1/exchange-rates/bcv`): el mismo día publicado dos veces es UNA fila.
 * Exige `fx.rate.manage` en servidor; la carga manual de abajo sigue siendo
 * el fallback sin internet.
 */
function TraerDelBcv(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);

  async function traer(): Promise<void> {
    setError(null);
    setOcupado(true);
    try {
      const r = await llamar<{ rate: string; rate_date: string }>("/v1/exchange-rates/bcv", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      toast.success(
        "Tasa del BCV traída",
        `${mostrarCantidad(r.rate)} Bs/USD del ${fechaLocal(r.rate_date)}`,
      );
      await qc.invalidateQueries({ queryKey: ["tasas", empresa.id] });
    } catch (e) {
      setError(e);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button variant="secondary" size="sm" disabled={ocupado} onClick={() => void traer()}>
        {ocupado ? "Consultando al BCV…" : "Traer del BCV"}
      </Button>
      {error !== null && <MensajeError error={error} />}
    </div>
  );
}

function CargarTasa(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const qc = useQueryClient();
  const toast = useToast();
  const hoy = hoyLocal();
  const [rate, setRate] = useState("");
  const [source, setSource] = useState("BCV");
  const [fecha, setFecha] = useState(hoy);
  const [error, setError] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);

  async function cargar(): Promise<void> {
    setError(null);
    setOcupado(true);
    try {
      await llamar("/v1/exchange-rates", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          from_currency: "USD",
          to_currency: "VES",
          rate: rate.trim(),
          source,
          rate_date: fecha,
        }),
      });
      toast.success("Tasa cargada");
      // La clave real es ["tasas", empresa.id, "USD-VES"]: con ["tasas",
      // "USD-VES"] el prefijo no coincidía y el Paso 2 seguía en «Pendiente»
      // después de cargar (auditoría 2026-09-11).
      await qc.invalidateQueries({ queryKey: ["tasas", empresa.id] });
    } catch (e) {
      setError(e);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface-muted/40 p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <FormField label="Tasa USD→VES" required>
          {(a) => <MoneyInput id={a.id} value={rate} onChange={setRate} currency="Bs/USD" />}
        </FormField>
        <FormField label="Fuente" required hint="De dónde salió: BCV, con fecha.">
          {(a) => <Input id={a.id} value={source} onChange={(e) => setSource(e.target.value)} />}
        </FormField>
        <FormField label="Fecha de la tasa" required>
          {(a) => <DatePicker id={a.id} value={fecha} onChange={setFecha} max={hoy} />}
        </FormField>
      </div>
      {error !== null && <MensajeError error={error} />}
      <Button
        variant="primary"
        size="sm"
        disabled={!importeValido(rate) || ocupado}
        onClick={() => void cargar()}
      >
        Cargar tasa
      </Button>
    </div>
  );
}

function CargarRango(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const qc = useQueryClient();
  const toast = useToast();
  const [forma, setForma] = useState({
    series: "A",
    range_from: "1",
    range_to: "",
    printer_source: "",
  });
  const [error, setError] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);

  async function cargar(): Promise<void> {
    setError(null);
    setOcupado(true);
    try {
      await llamar("/v1/fiscal-number-ranges", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id, kind: "invoice", ...forma }),
      });
      toast.success("Rango cargado");
      await qc.invalidateQueries({ queryKey: ["rangos", empresa.id] });
    } catch (e) {
      setError(e);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface-muted/40 p-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <FormField label="Serie" required>
          {(a) => (
            <Input
              id={a.id}
              value={forma.series}
              onChange={(e) => setForma({ ...forma, series: e.target.value })}
            />
          )}
        </FormField>
        <FormField label="Desde" required>
          {(a) => (
            <Input
              id={a.id}
              inputMode="numeric"
              className="font-mono"
              value={forma.range_from}
              onChange={(e) => setForma({ ...forma, range_from: e.target.value })}
            />
          )}
        </FormField>
        <FormField label="Hasta" required>
          {(a) => (
            <Input
              id={a.id}
              inputMode="numeric"
              className="font-mono"
              value={forma.range_to}
              onChange={(e) => setForma({ ...forma, range_to: e.target.value })}
            />
          )}
        </FormField>
        <FormField label="Imprenta autorizada" required hint="Quién autorizó el rango.">
          {(a) => (
            <Input
              id={a.id}
              value={forma.printer_source}
              onChange={(e) => setForma({ ...forma, printer_source: e.target.value })}
            />
          )}
        </FormField>
      </div>
      {error !== null && <MensajeError error={error} />}
      <Button
        variant="primary"
        size="sm"
        disabled={ocupado || forma.range_to.trim() === "" || forma.printer_source.trim() === ""}
        onClick={() => void cargar()}
      >
        Cargar rango
      </Button>
    </div>
  );
}

/**
 * La verificación de verdad: una COTIZACIÓN de prueba contra el motor real.
 * No toca stock ni numeración fiscal, pero SÍ queda guardada como cotización —
 * por eso es un acto explícito con el efecto dicho, nunca un ping silencioso.
 */
function VerificacionReal(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const [cliente, setCliente] = useState<EntityOption | null>(null);
  const [producto, setProducto] = useState<EntityOption | null>(null);
  const [resultado, setResultado] = useState<React.ReactNode>(null);
  const [ocupado, setOcupado] = useState(false);

  async function probar(): Promise<void> {
    setOcupado(true);
    setResultado(null);
    try {
      const q = await llamar<{
        series: string;
        document_number: number | null;
        tax_amount: string;
        functional_currency: string;
      }>("/v1/quotes", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          customer_id: cliente?.id ?? "",
          lines: [{ product_id: producto?.id ?? "", quantity: "1" }],
          notes: "Cotización de verificación de puesta a punto",
        }),
      });
      setResultado(
        <p className="flex items-center gap-1.5 text-[0.88rem] text-accent-soft-foreground">
          <CheckCircle2 className="size-4" /> El motor emitió la cotización con IVA{" "}
          {mostrarImporte({ amount: q.tax_amount, currency: q.functional_currency })}: alícuota y
          tasa están cargadas. (La cotización quedó guardada en Ventas.)
        </p>,
      );
    } catch (e) {
      if (e instanceof LlamadaApiError) {
        setResultado(<MensajeError error={e} />);
      } else {
        setResultado(
          <p className="text-[0.88rem] text-destructive-soft-foreground">{String(e)}</p>,
        );
      }
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <FlaskConical className="size-5 text-info" />
          <CardTitle>Verificación real</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <CardDescription>
          Guarda una <strong>cotización de prueba</strong> (queda en Ventas, no toca stock ni
          numeración fiscal) y lee la respuesta del motor: si falta la alícuota o la tasa, el 409 te
          lo dice con nombre y apellido — el mismo que verías al emitir.
        </CardDescription>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <EntityPicker
            placeholder="Cliente de prueba…"
            value={cliente}
            onChange={setCliente}
            buscar={async (q) => {
              const r = await llamar<{ items: { id: string; legal_name: string }[] }>(
                `/v1/customers?search=${encodeURIComponent(q)}&per_page=8`,
              );
              return r.items.map((c) => ({ id: c.id, label: c.legal_name }));
            }}
          />
          <EntityPicker
            placeholder="Producto de prueba…"
            value={producto}
            onChange={setProducto}
            buscar={async (q) => {
              const r = await llamar<{ items: { id: string; name: string; sku: string }[] }>(
                `/v1/products?search=${encodeURIComponent(q)}&per_page=8`,
              );
              return r.items.map((p) => ({ id: p.id, label: p.name, detalle: p.sku }));
            }}
          />
        </div>
        {resultado}
        <Button
          variant="secondary"
          size="sm"
          disabled={cliente === null || producto === null || ocupado}
          onClick={() => void probar()}
        >
          {ocupado ? "Consultando al motor…" : "Guardar cotización de prueba"}
        </Button>
      </CardContent>
    </Card>
  );
}

interface RangoContingencia {
  id: string;
  series: string;
  range_from: number;
  range_to: number;
  next_available: number;
  remaining: number;
  status: string;
  reason: string;
  failure_started_at: string;
  failure_ended_at: string | null;
}

/**
 * CONTINGENCIA (PA 102, migración 35). Pantalla deliberadamente simple: el
 * talonario físico se registra con su serie «contingencia…», su motivo y el
 * inicio de la falla; cada factura emitida EN PAPEL durante la falla se
 * registra a posteriori con sus números impresos — y entra por la emisión
 * completa (kardex, impuestos, asiento, libros), en el ORDEN del talonario.
 */
function Contingencia({ rangos }: { rangos: RangoContingencia[] }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);
  const [talonario, setTalonario] = useState({
    series: "contingencia-1",
    range_from: "1",
    range_to: "",
    printer_source: "",
    reason: "",
    failure_started_at: "",
  });
  const abiertos = rangos.filter((r) => r.failure_ended_at === null && r.status === "active");
  const [rangoElegido, setRangoElegido] = useState<string | null>(null);
  const [cliente, setCliente] = useState<EntityOption | null>(null);
  const [producto, setProducto] = useState<EntityOption | null>(null);
  // El depósito se ELIGE: antes se tomaba `almacenes[0]` a ciegas, y en una
  // empresa con dos depósitos la factura de papel descontaba stock del que
  // Postgres listara primero.
  const [deposito, setDeposito] = useState<string | null>(null);
  const [factura, setFactura] = useState({
    cantidad: "1",
    emitida: "",
    papel_numero: "",
    papel_control: "",
  });
  // Cerrar la falla es irreversible: pasa por confirmación (UX no negociable).
  const [cerrando, setCerrando] = useState<RangoContingencia | null>(null);

  const depositos = useQuery({
    queryKey: ["depositos", empresa.id],
    queryFn: () => llamar<{ id: string; code: string; name: string }[]>("/v1/warehouses"),
  });
  // Con un solo depósito no hay nada que elegir: se toma ese.
  const unicoDeposito = depositos.data?.length === 1 ? (depositos.data[0]?.id ?? null) : null;
  const depositoElegido = deposito ?? unicoDeposito;

  const recargar = () => qc.invalidateQueries({ queryKey: ["contingencias", empresa.id] });

  async function registrarTalonario(): Promise<void> {
    setError(null);
    setOcupado(true);
    try {
      await llamar("/v1/fiscal/contingency-ranges", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          series: talonario.series.trim(),
          range_from: talonario.range_from.trim(),
          range_to: talonario.range_to.trim(),
          printer_source: talonario.printer_source.trim(),
          reason: talonario.reason.trim(),
          failure_started_at: new Date(talonario.failure_started_at).toISOString(),
        }),
      });
      toast.success("Talonario de contingencia registrado");
      await recargar();
    } catch (e) {
      setError(e);
    } finally {
      setOcupado(false);
    }
  }

  async function registrarFactura(): Promise<void> {
    if (depositoElegido === null) return;
    setError(null);
    setOcupado(true);
    try {
      await llamar("/v1/fiscal/contingency-invoices", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          contingency_range_id: rangoElegido,
          customer_id: cliente?.id,
          warehouse_id: depositoElegido,
          issued_at: new Date(factura.emitida).toISOString(),
          lines: [{ product_id: producto?.id, quantity: factura.cantidad.trim() }],
          paper_document_number: factura.papel_numero.trim(),
          paper_control_number: factura.papel_control.trim(),
        }),
      });
      toast.success("Factura de papel registrada: entró a inventario, contabilidad y libros");
      setFactura({ cantidad: "1", emitida: "", papel_numero: "", papel_control: "" });
      await recargar();
    } catch (e) {
      setError(e);
    } finally {
      setOcupado(false);
    }
  }

  async function cerrar(id: string): Promise<void> {
    setError(null);
    setOcupado(true);
    try {
      await llamar(`/v1/fiscal/contingency-ranges/${id}/close`, {
        method: "PUT",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          failure_ended_at: new Date().toISOString(),
        }),
      });
      toast.success("Período de contingencia cerrado");
      await recargar();
    } catch (e) {
      setError(e);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="space-y-4 rounded-md border border-border bg-surface-muted/40 p-3">
      <ConfirmDialog
        open={cerrando !== null}
        onOpenChange={(v) => {
          if (!v) setCerrando(null);
        }}
        title="Cerrar la falla"
        confirmLabel="Cerrar la falla"
        destructive
        onConfirm={async () => {
          if (cerrando !== null) await cerrar(cerrando.id);
        }}
      >
        Se cierra el período de contingencia del talonario{" "}
        <span className="font-mono">{cerrando?.series}</span> con la hora de ahora. Después de
        cerrarlo no se puede registrar ninguna factura de papel más contra él; las que falten quedan
        fuera y no hay vuelta atrás.
      </ConfirmDialog>
      {rangos.length > 0 && (
        <ul className="space-y-1 text-sm">
          {rangos.map((r) => (
            <li key={r.id} className="flex items-center gap-2">
              <span className="font-mono">{r.series}</span>
              <span className="text-muted-foreground">
                {r.range_from}–{r.range_to} · quedan {r.remaining} · {r.reason}
              </span>
              {r.failure_ended_at === null ? (
                <Button variant="ghost" size="sm" disabled={ocupado} onClick={() => setCerrando(r)}>
                  Cerrar la falla…
                </Button>
              ) : (
                <Badge tone="outline">cerrada</Badge>
              )}
            </li>
          ))}
        </ul>
      )}

      <div>
        <p className="pb-2 text-sm font-medium">Registrar talonario físico</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <FormField label="Serie impresa" required hint="Debe empezar por «contingencia».">
            {(a) => (
              <Input
                id={a.id}
                value={talonario.series}
                onChange={(e) => setTalonario({ ...talonario, series: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="Desde" required>
            {(a) => (
              <Input
                id={a.id}
                inputMode="numeric"
                className="font-mono"
                value={talonario.range_from}
                onChange={(e) => setTalonario({ ...talonario, range_from: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="Hasta" required>
            {(a) => (
              <Input
                id={a.id}
                inputMode="numeric"
                className="font-mono"
                value={talonario.range_to}
                onChange={(e) => setTalonario({ ...talonario, range_to: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="Imprenta" required>
            {(a) => (
              <Input
                id={a.id}
                value={talonario.printer_source}
                onChange={(e) => setTalonario({ ...talonario, printer_source: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="Motivo de la falla" required>
            {(a) => (
              <Input
                id={a.id}
                value={talonario.reason}
                onChange={(e) => setTalonario({ ...talonario, reason: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="Inicio de la falla" required>
            {(a) => (
              <Input
                id={a.id}
                type="datetime-local"
                value={talonario.failure_started_at}
                onChange={(e) => setTalonario({ ...talonario, failure_started_at: e.target.value })}
              />
            )}
          </FormField>
        </div>
        <Button
          className="mt-2"
          variant="secondary"
          disabled={
            ocupado ||
            talonario.series.trim() === "" ||
            talonario.range_to.trim() === "" ||
            talonario.printer_source.trim() === "" ||
            talonario.reason.trim() === "" ||
            talonario.failure_started_at === ""
          }
          onClick={() => void registrarTalonario()}
        >
          Registrar talonario
        </Button>
      </div>

      {abiertos.length > 0 && (
        <div>
          <p className="pb-2 text-sm font-medium">Registrar factura emitida en papel</p>
          <p className="pb-2 text-xs text-muted-foreground">
            En el ORDEN del talonario, una línea por registro (la pantalla simple registra un
            producto; lo compuesto va por la API). Los números son los IMPRESOS en el papel: si no
            cuadran con el siguiente del talonario, no se registra nada.
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <FormField label="Talonario" required>
              {(a) => (
                <SimpleSelect
                  id={a.id}
                  value={rangoElegido}
                  onValueChange={setRangoElegido}
                  options={abiertos.map((r) => ({
                    value: r.id,
                    label: `${r.series} (sigue el ${r.next_available})`,
                  }))}
                />
              )}
            </FormField>
            <FormField label="Cliente" required>
              {(a) => (
                <EntityPicker
                  id={a.id}
                  value={cliente}
                  onChange={setCliente}
                  buscar={async (q) => {
                    const r = await llamar<{ items: { id: string; legal_name: string }[] }>(
                      `/v1/customers?search=${encodeURIComponent(q)}&per_page=8`,
                    );
                    return r.items.map((c) => ({ id: c.id, label: c.legal_name }));
                  }}
                />
              )}
            </FormField>
            <FormField label="Producto" required>
              {(a) => (
                <EntityPicker
                  id={a.id}
                  value={producto}
                  onChange={setProducto}
                  buscar={async (q) => {
                    const r = await llamar<{ items: { id: string; name: string }[] }>(
                      `/v1/products?search=${encodeURIComponent(q)}&per_page=8&only_active=1`,
                    );
                    return r.items.map((p) => ({ id: p.id, label: p.name }));
                  }}
                />
              )}
            </FormField>
            <FormField label="Depósito" required hint="De dónde sale la mercancía de esa factura.">
              {(a) => (
                <SimpleSelect
                  id={a.id}
                  value={depositoElegido}
                  onValueChange={setDeposito}
                  disabled={depositos.isPending}
                  placeholder={
                    depositos.data?.length === 0 ? "La empresa no tiene depósito" : "Elige…"
                  }
                  options={(depositos.data ?? []).map((d) => ({
                    value: d.id,
                    label: `${d.code} · ${d.name}`,
                  }))}
                />
              )}
            </FormField>
            <FormField label="Cantidad" required>
              {(a) => (
                <Input
                  id={a.id}
                  inputMode="decimal"
                  className="font-mono"
                  value={factura.cantidad}
                  onChange={(e) => setFactura({ ...factura, cantidad: e.target.value })}
                />
              )}
            </FormField>
            <FormField label="Emitida el (papel)" required>
              {(a) => (
                <Input
                  id={a.id}
                  type="datetime-local"
                  value={factura.emitida}
                  onChange={(e) => setFactura({ ...factura, emitida: e.target.value })}
                />
              )}
            </FormField>
            <FormField label="N° factura del papel" required>
              {(a) => (
                <Input
                  id={a.id}
                  inputMode="numeric"
                  className="font-mono"
                  value={factura.papel_numero}
                  onChange={(e) => setFactura({ ...factura, papel_numero: e.target.value })}
                />
              )}
            </FormField>
            <FormField label="N° de control del papel" required>
              {(a) => (
                <Input
                  id={a.id}
                  inputMode="numeric"
                  className="font-mono"
                  value={factura.papel_control}
                  onChange={(e) => setFactura({ ...factura, papel_control: e.target.value })}
                />
              )}
            </FormField>
          </div>
          <Button
            className="mt-2"
            variant="primary"
            disabled={
              ocupado ||
              rangoElegido === null ||
              cliente === null ||
              producto === null ||
              depositoElegido === null ||
              factura.emitida === "" ||
              factura.papel_numero.trim() === "" ||
              factura.papel_control.trim() === ""
            }
            onClick={() => void registrarFactura()}
          >
            Registrar factura de papel
          </Button>
        </div>
      )}

      {error !== null && <MensajeError error={error} />}
    </div>
  );
}
