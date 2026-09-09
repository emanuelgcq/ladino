import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, FileSpreadsheet } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DateRangePicker, FormField } from "../../components/forms.js";
import { Button } from "../../ui/button.js";
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
    <Card>
      <CardHeader>
        <CardTitle>Retenciones de IVA que nos practicaron</CardTitle>
        <CardDescription>
          Los comprobantes que entregan los clientes que son agentes de retención. Cargar uno abona
          la factura afectada por su importe exacto: no entra dinero en caja, pero el cliente deja
          de deber esa parte.
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
    <Card>
      <CardHeader>
        <CardTitle>Vencimientos cargados</CardTitle>
        <CardDescription>
          Ladino no trae ninguna fecha de fábrica. El calendario por dígito de RIF sale de la
          providencia vigente y se carga con su cita: una fecha inventada aquí sería una multa allá.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground">
            No hay vencimientos cargados. Pídele a tu contador la providencia del año y cárgalos con
            la fuente.
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
  );
}

export { CalendarClock };
