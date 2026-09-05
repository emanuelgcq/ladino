import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed, FlaskConical, ShieldAlert } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { PageHeader } from "../../components/PageHeader.js";
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
import { mostrarImporte } from "../../money.js";
import { MensajeError } from "../ventas/comunes.js";

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
 * Honestidad sobre el estado: dos pasos se COMPRUEBAN contra la API (tasa,
 * rango), y dos no tienen endpoint de lectura hoy (alícuota, régimen) — para
 * esos, la pantalla lo dice y ofrece una VERIFICACIÓN REAL: guardar una
 * cotización de prueba y leer la respuesta del motor. Los 409 dejan de parecer
 * avería y se vuelven onboarding.
 */
function AlertaRangos(): React.JSX.Element | null {
  const { empresa, llamar } = useSesion();
  const q = useQuery({
    queryKey: ["rangos-agotandose", empresa.id],
    queryFn: () =>
      llamar<{
        items: {
          range_id: string;
          kind: string;
          series: string;
          remaining: number;
          total: number;
          pct_remaining: string;
        }[];
      }>("/v1/fiscal-number-ranges/exhaustion"),
  });
  const items = q.data?.items ?? [];
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
  const { empresa, llamar } = useSesion();

  const tasas = useQuery({
    queryKey: ["tasas", "USD-VES"],
    queryFn: () =>
      llamar<{ rate: string; source: string; rate_date: string }[]>("/v1/exchange-rates"),
  });
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

      <div className="space-y-4">
        <Paso
          numero={2}
          titulo="Tasa de cambio BCV"
          estado={tasas.isPending ? "cargando" : tasaOk ? "completo" : "pendiente"}
          codigo409="EXCHANGE_RATE_MISSING"
          resumen={
            tasaOk && tasas.data !== undefined && tasas.data[0] !== undefined
              ? `Última: ${tasas.data[0].rate} (${tasas.data[0].source}, ${tasas.data[0].rate_date})`
              : "Sin tasa cargada: cualquier operación en divisa fallará."
          }
        >
          <CargarTasa />
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

        <Paso
          numero={1}
          titulo="Alícuota de IVA con fuente legal"
          estado="manual"
          codigo409="TAX_RULE_MISSING"
          resumen="La API aún no expone la lectura de tax_rules: el estado no puede comprobarse aquí. La regla se carga hoy por operación, con su fuente citada (ADR-0038: sin regla no se emite — el sistema no adivina alícuotas)."
          sello="VALIDAR-SENIAT: la alícuota y su vigencia deben venir de la norma, citada en legal_source."
        />

        <Paso
          numero={3}
          titulo="Régimen fiscal de la empresa"
          estado="manual"
          codigo409="FISCAL_NUMBERING_INVALID"
          resumen="El régimen (formatos libres, máquina fiscal…) decide cómo se numera. Hoy se asigna por operación (company_fiscal_regimes, ADR-0029); no hay endpoint para leerlo ni asignarlo desde aquí."
          sello="VALIDAR-SENIAT: qué régimen corresponde a la empresa lo confirma su contador."
        />

        <VerificacionReal />
      </div>
    </div>
  );
}

function Paso({
  numero,
  titulo,
  estado,
  resumen,
  codigo409,
  sello,
  children,
}: {
  numero: number;
  titulo: string;
  estado: "completo" | "pendiente" | "cargando" | "manual";
  resumen: string;
  codigo409: string;
  sello?: string;
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
          {estado === "manual" && <Badge tone="info">Por operación</Badge>}
        </div>
      </CardHeader>
      <CardContent>
        <CardDescription>{resumen}</CardDescription>
        {sello !== undefined && (
          <p className="mt-2 flex items-start gap-1.5 rounded-sm bg-warning-soft px-2.5 py-1.5 text-[0.82rem] text-warning-soft-foreground">
            <ShieldAlert className="mt-px size-3.5 shrink-0" /> {sello}
          </p>
        )}
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

function CargarTasa(): React.JSX.Element {
  const { llamar } = useSesion();
  const qc = useQueryClient();
  const toast = useToast();
  const hoy = new Date().toISOString().slice(0, 10);
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
      await qc.invalidateQueries({ queryKey: ["tasas", "USD-VES"] });
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
  const [factura, setFactura] = useState({
    cantidad: "1",
    emitida: "",
    papel_numero: "",
    papel_control: "",
  });

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
    setError(null);
    setOcupado(true);
    try {
      const almacenes = await llamar<{ id: string }[]>("/v1/warehouses");
      const deposito = almacenes[0]?.id;
      if (deposito === undefined) throw new Error("La empresa no tiene almacén configurado.");
      await llamar("/v1/fiscal/contingency-invoices", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          contingency_range_id: rangoElegido,
          customer_id: cliente?.id,
          warehouse_id: deposito,
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
    }
  }

  return (
    <div className="space-y-4 rounded-md border border-border bg-surface-muted/40 p-3">
      {rangos.length > 0 && (
        <ul className="space-y-1 text-sm">
          {rangos.map((r) => (
            <li key={r.id} className="flex items-center gap-2">
              <span className="font-mono">{r.series}</span>
              <span className="text-muted-foreground">
                {r.range_from}–{r.range_to} · quedan {r.remaining} · {r.reason}
              </span>
              {r.failure_ended_at === null ? (
                <Button variant="ghost" size="sm" onClick={() => void cerrar(r.id)}>
                  Cerrar la falla
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
