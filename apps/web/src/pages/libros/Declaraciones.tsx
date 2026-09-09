import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FilePlus2, FileSpreadsheet, Printer } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { PageHeader } from "../../components/PageHeader.js";
import {
  DateRangePicker,
  EntityPicker,
  FormField,
  importeValido,
  type EntityOption,
} from "../../components/forms.js";
import { Button } from "../../ui/button.js";
import { Input } from "../../ui/input.js";
import { SimpleSelect } from "../../ui/select.js";
import { Badge } from "../../ui/badge.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card.js";
import { Skeleton } from "../../ui/card.js";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../../ui/tabs.js";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "../../ui/table.js";
import { useToast } from "../../ui/toast.js";
import { mostrarImporte } from "../../money.js";
import { MensajeError } from "../ventas/comunes.js";
import type { FiscalDeadline, IvaPeriodResult, SupportedRetention } from "../../lib.js";

/**
 * DECLARAR IVA — la planilla DEMOSTRATIVA (migración 46).
 *
 * Tres reglas visibles gobiernan esta pantalla:
 *   · **no aparece ningún número de casilla**. El mapeo con la Forma 30 no está
 *     confirmado (PENDIENTES_ASESOR P-1) y un rótulo con aspecto oficial haría
 *     pasar por declaración lo que es un cálculo de Ladino;
 *   · el período se GENERA y queda con su hash: la fila es insert-only, así que
 *     regenerar no edita — crea otra generación y la última manda;
 *   · el arrastre viene ENCADENADO. Si falta el eslabón anterior, el servidor
 *     lo dice y la pantalla lo repite: un cero puesto en silencio produciría
 *     una cuota falsa.
 */
function mesAnterior(): { from: string; to: string } {
  const hoy = new Date();
  const primeroDeEste = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 1));
  const ultimo = new Date(primeroDeEste.getTime() - 86_400_000);
  const primero = new Date(Date.UTC(ultimo.getUTCFullYear(), ultimo.getUTCMonth(), 1));
  return { from: primero.toISOString().slice(0, 10), to: ultimo.toISOString().slice(0, 10) };
}

export function Declaraciones(): React.JSX.Element {
  const [rango, setRango] = useState(mesAnterior());

  return (
    <div>
      <PageHeader
        title="Declarar IVA"
        description="La planilla demostrativa del período: lo que Ladino calcula desde tus documentos. NO es la declaración oficial — se transcribe al portal del SENIAT."
      />

      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">
          <FormField label="Período — explícito, siempre">
            {() => (
              <DateRangePicker from={rango.from} to={rango.to} onChange={(r) => setRango(r)} />
            )}
          </FormField>
        </CardContent>
      </Card>

      <Tabs defaultValue="periodo">
        <TabsList className="mb-3">
          <TabsTab value="periodo">El período</TabsTab>
          <TabsTab value="retenciones">Retenciones que nos hicieron</TabsTab>
          <TabsTab value="calendario">Vencimientos</TabsTab>
        </TabsList>
        <TabsPanel value="periodo">
          <Periodo desde={rango.from} hasta={rango.to} />
        </TabsPanel>
        <TabsPanel value="retenciones">
          <Retenciones desde={rango.from} hasta={rango.to} />
        </TabsPanel>
        <TabsPanel value="calendario">
          <Calendario />
        </TabsPanel>
      </Tabs>
    </div>
  );
}

/**
 * Descarga la planilla como CSV. Las cifras son EXACTAMENTE las que devolvió
 * el servidor —aquí no se calcula ni se redondea nada—, y el fichero lleva el
 * rótulo «NO OFICIAL» y la huella en su cabecera: quien lo abra dentro de seis
 * meses tiene que poder saber qué es y de qué generación salió.
 */
function descargarPlanilla(p: IvaPeriodResult, desde: string, hasta: string): void {
  const filas: string[][] = [
    ["PLANILLA DEMOSTRATIVA — NO OFICIAL (generada por Ladino)"],
    [`Período`, `${desde} a ${hasta}`],
    [`Moneda`, p.functional_currency],
    [`Generada`, p.created_at],
    [`Huella`, p.dataset_hash],
    [],
    ["Concepto", "Importe"],
    ["Débito fiscal del período", p.debitos],
    ...p.detalle.map((d) => [`  alícuota ${d.alicuota} — base ${d.base}`, d.impuesto]),
    ["Crédito fiscal del período", p.creditos],
    ...(p.prorrata_pct === null
      ? []
      : [[`Crédito deducible tras la prorrata (${p.prorrata_pct})`, p.creditos_deducibles]]),
    ["Retenciones de IVA soportadas", p.retenciones_soportadas],
    ["Excedente del período anterior", p.excedente_anterior],
    ["Cuota a pagar", p.cuota_a_pagar],
    ["Excedente que pasa al período siguiente", p.excedente_siguiente],
  ];
  // Separador «;» y BOM, como el resto de las descargas de Ladino: es lo que
  // abre bien un Excel en español sin pelearse con las comas decimales.
  const csv = filas
    .map((f) => f.map((c) => (/[";\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(";"))
    .join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `planilla-demostrativa-iva-${desde}_${hasta}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Una fila del cuerpo de la planilla. `destacado` marca el resultado. */
function Renglon({
  concepto,
  nota,
  importe,
  moneda,
  destacado = false,
}: {
  concepto: string;
  nota?: string;
  importe: string;
  moneda: string;
  destacado?: boolean;
}): React.JSX.Element {
  return (
    <TR className={destacado ? "bg-muted/40 font-medium" : undefined}>
      <TD>
        {concepto}
        {nota !== undefined && (
          <span className="block text-[0.8rem] text-faint-foreground">{nota}</span>
        )}
      </TD>
      <TDNum>{mostrarImporte({ amount: importe, currency: moneda })}</TDNum>
    </TR>
  );
}

function Periodo({ desde, hasta }: { desde: string; hasta: string }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [generando, setGenerando] = useState(false);

  const generaciones = useQuery({
    queryKey: ["iva-periodos", empresa.id, desde, hasta],
    queryFn: () =>
      llamar<{ items: IvaPeriodResult[] }>(
        `/v1/fiscal-declarations/iva-periods?from=${desde}&to=${hasta}`,
      ),
  });

  async function generar(): Promise<void> {
    setError(null);
    setGenerando(true);
    try {
      const r = await llamar<IvaPeriodResult>("/v1/fiscal-declarations/iva-periods", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          period_from: desde,
          period_to: hasta,
        }),
      });
      toast.success("Período generado", `Huella ${r.dataset_hash.slice(0, 16)}…`);
      await qc.invalidateQueries({ queryKey: ["iva-periodos", empresa.id] });
    } catch (e) {
      setError(e);
    } finally {
      setGenerando(false);
    }
  }

  if (generaciones.isLoading) return <Skeleton className="h-64" />;
  const items = generaciones.data?.items ?? [];
  // La ÚLTIMA generación manda: la fila es insert-only y regenerar crea otra.
  const ultima = items[0];
  const moneda = ultima?.functional_currency ?? "";

  return (
    <div className="space-y-4">
      <MensajeError error={error} />

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void generar()} disabled={generando}>
          <FileSpreadsheet className="mr-2 h-4 w-4" />
          {ultima === undefined ? "Generar el período" : "Volver a generar"}
        </Button>
        {ultima !== undefined && (
          <>
            <Button variant="secondary" onClick={() => descargarPlanilla(ultima, desde, hasta)}>
              <FileSpreadsheet className="mr-2 h-4 w-4" />
              Descargar (.csv)
            </Button>
            <Button variant="secondary" onClick={() => window.print()}>
              <Printer className="mr-2 h-4 w-4" />
              Imprimir o guardar en PDF
            </Button>
          </>
        )}
        {items.length > 0 && (
          <span className="text-[0.86rem] text-faint-foreground">
            {items.length === 1
              ? "1 generación de este período"
              : `${items.length} generaciones de este período — manda la última`}
          </span>
        )}
      </div>

      {ultima === undefined ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            Este período no se ha generado todavía. El resultado se calcula desde tus documentos
            emitidos y tus facturas de compra, y queda guardado con su huella para poder
            reproducirlo.
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Planilla demostrativa — NO OFICIAL</CardTitle>
              <CardDescription>
                Las cifras que Ladino calcula para el período, en el orden de la declaración. No
                llevan número de casilla a propósito: el mapeo con la Forma 30 lo confirma el asesor
                antes de que esto pueda llamarse otra cosa.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <THead>
                  <TR>
                    <TH>Concepto</TH>
                    <TH className="text-right">Importe</TH>
                  </TR>
                </THead>
                <TBody>
                  <Renglon
                    concepto="Débito fiscal del período"
                    nota="Ventas emitidas, menos notas de crédito, más notas de débito"
                    importe={ultima.debitos}
                    moneda={moneda}
                  />
                  {ultima.detalle.map((d) => (
                    <Renglon
                      key={d.alicuota}
                      concepto={`— alícuota ${(Number(d.alicuota) * 100).toFixed(2)} %`}
                      nota={`Base ${mostrarImporte({ amount: d.base, currency: moneda })}`}
                      importe={d.impuesto}
                      moneda={moneda}
                    />
                  ))}
                  <Renglon
                    concepto="Crédito fiscal del período"
                    nota="Facturas de proveedor con IVA recuperable"
                    importe={ultima.creditos}
                    moneda={moneda}
                  />
                  {ultima.prorrata_pct !== null && (
                    <Renglon
                      concepto="Crédito deducible tras la prorrata"
                      nota={`Prorrata ${(Number(ultima.prorrata_pct) * 100).toFixed(2)} % — hubo ventas sin impuesto en el período`}
                      importe={ultima.creditos_deducibles}
                      moneda={moneda}
                    />
                  )}
                  <Renglon
                    concepto="Retenciones de IVA que nos practicaron"
                    nota="Comprobantes cargados con fecha dentro del período"
                    importe={ultima.retenciones_soportadas}
                    moneda={moneda}
                  />
                  <Renglon
                    concepto="Excedente del período anterior"
                    nota="Viene encadenado de la última generación del período contiguo"
                    importe={ultima.excedente_anterior}
                    moneda={moneda}
                  />
                  <Renglon
                    concepto="Cuota a pagar"
                    importe={ultima.cuota_a_pagar}
                    moneda={moneda}
                    destacado
                  />
                  <Renglon
                    concepto="Excedente que pasa al período siguiente"
                    nota="Traslado del excedente de crédito fiscal al período siguiente"
                    importe={ultima.excedente_siguiente}
                    moneda={moneda}
                    destacado
                  />
                </TBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Generaciones de este período</CardTitle>
              <CardDescription>
                Una generación no se edita: si algo cambió, se genera otra y manda la última. La
                huella permite comprobar que dos generaciones vieron lo mismo.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <THead>
                  <TR>
                    <TH>Generada</TH>
                    <TH className="text-right">Cuota</TH>
                    <TH className="text-right">Excedente siguiente</TH>
                    <TH>Huella</TH>
                  </TR>
                </THead>
                <TBody>
                  {items.map((g, i) => (
                    <TR key={g.id}>
                      <TD>
                        {new Date(g.created_at).toLocaleString()}
                        {i === 0 && (
                          <Badge tone="accent" className="ml-2">
                            vigente
                          </Badge>
                        )}
                      </TD>
                      <TDNum>{mostrarImporte({ amount: g.cuota_a_pagar, currency: moneda })}</TDNum>
                      <TDNum>
                        {mostrarImporte({ amount: g.excedente_siguiente, currency: moneda })}
                      </TDNum>
                      <TD>
                        <span className="font-mono text-[0.78rem]">
                          {g.dataset_hash.slice(0, 16)}…
                        </span>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Retenciones({ desde, hasta }: { desde: string; hasta: string }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const retenciones = useQuery({
    queryKey: ["retenciones-soportadas", empresa.id, desde, hasta],
    queryFn: () =>
      llamar<{ items: SupportedRetention[] }>(
        `/v1/fiscal-declarations/supported-retentions?from=${desde}&to=${hasta}`,
      ),
  });

  if (retenciones.isLoading) return <Skeleton className="h-48" />;
  const items = retenciones.data?.items ?? [];

  return (
    <div className="space-y-4">
      <CargarRetencion />
      <Card>
        <CardHeader>
          <CardTitle>Retenciones de IVA que nos practicaron</CardTitle>
          <CardDescription>
            Los comprobantes que entregan los clientes que son agentes de retención. Cargar uno
            abona la factura afectada por su importe exacto: no entra dinero en caja, pero el
            cliente deja de deber esa parte.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground">
              Ningún comprobante en este período.
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Comprobante</TH>
                  <TH>Fecha</TH>
                  <TH className="text-right">Base</TH>
                  <TH className="text-right">Retenido</TH>
                  <TH>Estado</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((r) => (
                  <TR key={r.id}>
                    <TD className="font-mono text-[0.84rem]">{r.receipt_number}</TD>
                    <TD>{r.retained_on}</TD>
                    <TDNum>
                      {mostrarImporte({ amount: r.base, currency: r.functional_currency })}
                    </TDNum>
                    <TDNum>
                      {mostrarImporte({ amount: r.amount, currency: r.functional_currency })}
                    </TDNum>
                    <TD>
                      <Badge tone={r.status === "registered" ? "accent" : "outline"}>
                        {r.status === "registered" ? "vigente" : "anulado"}
                      </Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Cargar el comprobante que nos entregó el agente. Todo se TRANSCRIBE del
 * papel: la porción retenida (75 % o 100 %) es dato del comprobante, no una
 * regla que Ladino resuelva. Al guardar, el servidor abona la factura por el
 * importe exacto — por eso el formulario pide la factura y no un importe
 * suelto.
 */
function CargarRetencion(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  const [abierto, setAbierto] = useState(false);
  const [cliente, setCliente] = useState<EntityOption | null>(null);
  const [factura, setFactura] = useState<EntityOption | null>(null);
  const [numero, setNumero] = useState("");
  const [fecha, setFecha] = useState(() => new Date().toISOString().slice(0, 10));
  const [base, setBase] = useState("");
  const [porcion, setPorcion] = useState("0.75");
  const [monto, setMonto] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [enviando, setEnviando] = useState(false);

  function limpiar(): void {
    setCliente(null);
    setFactura(null);
    setNumero("");
    setBase("");
    setMonto("");
    setError(null);
  }

  async function guardar(): Promise<void> {
    if (cliente === null || factura === null) return;
    setError(null);
    setEnviando(true);
    try {
      await llamar("/v1/fiscal-declarations/supported-retentions", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          customer_id: cliente.id,
          document_id: factura.id,
          receipt_number: numero.trim(),
          retained_on: fecha,
          base: base.trim().replace(",", "."),
          rate: porcion,
          amount: monto.trim().replace(",", "."),
        }),
      });
      toast.success("Comprobante cargado", "La factura quedó abonada por el importe retenido.");
      await qc.invalidateQueries({ queryKey: ["retenciones-soportadas", empresa.id] });
      await qc.invalidateQueries({ queryKey: ["iva-periodos", empresa.id] });
      limpiar();
      setAbierto(false);
    } catch (e) {
      setError(e);
    } finally {
      setEnviando(false);
    }
  }

  const completo =
    cliente !== null &&
    factura !== null &&
    numero.trim() !== "" &&
    importeValido(base.trim().replace(",", ".")) &&
    importeValido(monto.trim().replace(",", "."));

  if (!abierto) {
    return (
      <Button variant="secondary" onClick={() => setAbierto(true)}>
        <FilePlus2 className="mr-2 h-4 w-4" />
        Cargar un comprobante
      </Button>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cargar un comprobante de retención</CardTitle>
        <CardDescription>
          Copia los datos del papel que te entregó el cliente. Al guardarlo, su factura queda
          abonada por el importe retenido.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <MensajeError error={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="El cliente que retuvo">
            {(a) => (
              <EntityPicker
                id={a.id}
                value={cliente}
                onChange={(v) => {
                  setCliente(v);
                  setFactura(null);
                }}
                placeholder="Buscar cliente…"
                buscar={async (q) => {
                  const r = await llamar<{
                    items: { id: string; legal_name: string; tax_id: string | null }[];
                  }>(`/v1/customers?q=${encodeURIComponent(q)}&per_page=10`);
                  return r.items.map((c) => ({
                    id: c.id,
                    label: c.legal_name,
                    ...(c.tax_id === null ? {} : { detalle: c.tax_id }),
                  }));
                }}
              />
            )}
          </FormField>
          <FormField label="La factura afectada">
            {(a) => (
              <EntityPicker
                id={a.id}
                value={factura}
                onChange={setFactura}
                disabled={cliente === null}
                placeholder={cliente === null ? "Elige el cliente primero" : "Buscar factura…"}
                buscar={async () => {
                  if (cliente === null) return [];
                  const r = await llamar<{
                    items: {
                      id: string;
                      series: string;
                      document_number: number | null;
                      total_amount: string;
                      functional_currency: string;
                      issued_at: string | null;
                    }[];
                  }>(`/v1/documents?kind=invoice&customer_id=${cliente.id}&per_page=25`);
                  return r.items.map((d) => ({
                    id: d.id,
                    label: `${d.series}-${d.document_number ?? "—"}`,
                    detalle: `${(d.issued_at ?? "").slice(0, 10)} · ${mostrarImporte({
                      amount: d.total_amount,
                      currency: d.functional_currency,
                    })}`,
                  }));
                }}
              />
            )}
          </FormField>
          <FormField label="Nº del comprobante (como viene en el papel)">
            {(a) => (
              <Input
                id={a.id}
                className="font-mono"
                value={numero}
                onChange={(e) => setNumero(e.target.value)}
              />
            )}
          </FormField>
          <FormField label="Fecha en que retuvieron">
            {(a) => (
              <Input
                id={a.id}
                type="date"
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
              />
            )}
          </FormField>
          <FormField label="Base (el IVA de la factura)">
            {(a) => (
              <Input
                id={a.id}
                inputMode="decimal"
                value={base}
                onChange={(e) => setBase(e.target.value)}
              />
            )}
          </FormField>
          <FormField label="Porción retenida">
            {(a) => (
              <SimpleSelect
                id={a.id}
                value={porcion}
                onValueChange={setPorcion}
                options={[
                  { value: "0.75", label: "75 %" },
                  { value: "1", label: "100 %" },
                ]}
              />
            )}
          </FormField>
          <FormField label="Monto retenido (el del comprobante)">
            {(a) => (
              <Input
                id={a.id}
                inputMode="decimal"
                value={monto}
                onChange={(e) => setMonto(e.target.value)}
              />
            )}
          </FormField>
        </div>
        <p className="text-[0.82rem] text-faint-foreground">
          El monto se copia del comprobante, no se calcula: si no coincide con lo que el sistema
          espera abonar, es mejor que falle aquí y lo revises con el cliente.
        </p>
        <div className="flex gap-2">
          <Button onClick={() => void guardar()} disabled={!completo || enviando}>
            Guardar y abonar la factura
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              limpiar();
              setAbierto(false);
            }}
          >
            Cancelar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Calendario(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const vencimientos = useQuery({
    queryKey: ["vencimientos", empresa.id],
    queryFn: () => llamar<{ items: FiscalDeadline[] }>("/v1/fiscal-declarations/deadlines"),
  });

  if (vencimientos.isLoading) return <Skeleton className="h-48" />;
  const items = vencimientos.data?.items ?? [];
  const hoy = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      <CargarVencimiento />
      <Card>
        <CardHeader>
          <CardTitle>Vencimientos cargados</CardTitle>
          <CardDescription>
            Ladino no trae ninguna fecha de fábrica. El calendario por dígito de RIF sale de la
            providencia vigente y se carga con su cita: una fecha inventada aquí sería una multa
            allá.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground">
              No hay vencimientos cargados. Pídele a tu contador la providencia del año y cárgalos
              con la fuente.
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Obligación</TH>
                  <TH>Período</TH>
                  <TH>Vence</TH>
                  <TH>Fuente</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((d) => (
                  <TR key={d.id}>
                    <TD className="uppercase">{d.obligation.replace("_", " ")}</TD>
                    <TD>
                      {d.period_from} → {d.period_to}
                    </TD>
                    <TD>
                      {d.due_date}
                      {d.due_date < hoy && (
                        <Badge tone="warning" className="ml-2">
                          vencido
                        </Badge>
                      )}
                    </TD>
                    <TD className="text-[0.8rem] text-faint-foreground">{d.legal_source}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Cargar un vencimiento. Exige la CITA de dónde sale la fecha, y no es
 * burocracia: las fechas por dígito de RIF cambian cada año por providencia,
 * y una fecha sin fuente es indistinguible de una inventada. Cargar dos veces
 * el mismo período CORRIGE — no duplica.
 */
function CargarVencimiento(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  const [abierto, setAbierto] = useState(false);
  const [obligacion, setObligacion] = useState("iva");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [vence, setVence] = useState("");
  const [fuente, setFuente] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [enviando, setEnviando] = useState(false);

  async function guardar(): Promise<void> {
    setError(null);
    setEnviando(true);
    try {
      await llamar("/v1/fiscal-declarations/deadlines", {
        method: "PUT",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          deadlines: [
            {
              obligation: obligacion,
              period_from: desde,
              period_to: hasta,
              due_date: vence,
              legal_source: fuente.trim(),
            },
          ],
        }),
      });
      toast.success("Vencimiento cargado", "Te avisaremos 5 días antes desde Inicio.");
      await qc.invalidateQueries({ queryKey: ["vencimientos", empresa.id] });
      await qc.invalidateQueries({ queryKey: ["vencimientos-inicio", empresa.id] });
      setDesde("");
      setHasta("");
      setVence("");
      setFuente("");
      setAbierto(false);
    } catch (e) {
      setError(e);
    } finally {
      setEnviando(false);
    }
  }

  const completo =
    desde !== "" && hasta !== "" && vence !== "" && fuente.trim().length >= 10 && desde <= hasta;

  if (!abierto) {
    return (
      <Button variant="secondary" onClick={() => setAbierto(true)}>
        <FilePlus2 className="mr-2 h-4 w-4" />
        Cargar un vencimiento
      </Button>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cargar un vencimiento</CardTitle>
        <CardDescription>
          Copia la fecha de la providencia que corresponde al último dígito de tu RIF, y anota de
          dónde sale. Si vuelves a cargar el mismo período, la fecha se corrige.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <MensajeError error={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Obligación">
            {(a) => (
              <SimpleSelect
                id={a.id}
                value={obligacion}
                onValueChange={setObligacion}
                options={[
                  { value: "iva", label: "Declaración de IVA" },
                  { value: "ret_iva", label: "Retenciones de IVA" },
                  { value: "igtf", label: "IGTF percibido" },
                  { value: "islr", label: "ISLR" },
                ]}
              />
            )}
          </FormField>
          <FormField label="Vence el">
            {(a) => (
              <Input
                id={a.id}
                type="date"
                value={vence}
                onChange={(e) => setVence(e.target.value)}
              />
            )}
          </FormField>
          <FormField label="Período: desde">
            {(a) => (
              <Input
                id={a.id}
                type="date"
                value={desde}
                onChange={(e) => setDesde(e.target.value)}
              />
            )}
          </FormField>
          <FormField label="Período: hasta">
            {(a) => (
              <Input
                id={a.id}
                type="date"
                value={hasta}
                onChange={(e) => setHasta(e.target.value)}
              />
            )}
          </FormField>
        </div>
        <FormField label="De dónde sale esta fecha (providencia, gaceta…)">
          {(a) => (
            <Input
              id={a.id}
              value={fuente}
              placeholder="Ej.: Providencia SNAT/… publicada en Gaceta Oficial N.º …"
              onChange={(e) => setFuente(e.target.value)}
            />
          )}
        </FormField>
        <div className="flex gap-2">
          <Button onClick={() => void guardar()} disabled={!completo || enviando}>
            Guardar el vencimiento
          </Button>
          <Button variant="ghost" onClick={() => setAbierto(false)}>
            Cancelar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
