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

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Puesta a punto fiscal"
        description={`Lo que ${empresa.legal_name} necesita antes de su primera factura. Cada paso pendiente responde un 409 al emitir — no es una avería, es esta lista.`}
      />

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
