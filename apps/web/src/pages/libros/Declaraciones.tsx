import { useState } from "react";
import { formatearDocumento } from "@ladino/schemas";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FilePlus2, FileSpreadsheet, Printer } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { PageHeader } from "../../components/PageHeader.js";
import {
  DateRangePicker,
  EntityPicker,
  FormField,
  importeLimpio,
  importeValido,
  motivoDeImporte,
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
import { mostrarPorcentaje } from "../../porcentaje.js";
import { MensajeError } from "../ventas/comunes.js";
import {
  errorDePersona,
  type FiscalDeadline,
  type IvaPeriodProposal,
  type IvaPeriodResult,
  type TaxCalendar,
  type SupportedRetention,
} from "../../lib.js";
import { hoyLocal, fechaLocal } from "../../fechas.js";

/** Cuántas filas trae cada página de los listados de esta pantalla (el default del servidor). */
const POR_PAGINA = 50;

/**
 * Un fallo de carga NO es una lista vacía: «ningún comprobante» y «no se pudo
 * consultar» son dos frases distintas, y pintar la primera cuando pasó lo
 * segundo es mentir con cara de tranquilidad (auditoría 2026-09-11).
 */
function FalloDeCarga({
  error,
  reintentar,
}: {
  error: unknown;
  reintentar: () => void;
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-[0.88rem] text-destructive-soft-foreground"
    >
      <span>{errorDePersona(error)}</span>
      <Button variant="secondary" size="sm" onClick={reintentar}>
        Reintentar
      </Button>
    </div>
  );
}

/** «Mostrar más» / paginador mínimo para los listados con `total` del servidor. */
function Paginador({
  total,
  pagina,
  onPagina,
}: {
  total: number;
  pagina: number;
  onPagina: (p: number) => void;
}): React.JSX.Element | null {
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  if (paginas <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-between text-[0.82rem] text-muted-foreground">
      <span>
        {total} filas · página {pagina} de {paginas}
      </span>
      <span className="flex gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={pagina <= 1}
          onClick={() => onPagina(pagina - 1)}
        >
          Anterior
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={pagina >= paginas}
          onClick={() => onPagina(pagina + 1)}
        >
          Siguiente
        </Button>
      </span>
    </div>
  );
}

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
/** F-09: el mes calendario de una fecha `AAAA-MM-DD` (fecha civil, sin instante ni zona). */
function mesDe(fecha: string): { from: string; to: string } {
  const [a, m] = fecha.split("-").map(Number) as [number, number];
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return {
    from: `${fecha.slice(0, 7)}-01`,
    to: `${fecha.slice(0, 7)}-${String(ultimo).padStart(2, "0")}`,
  };
}

/** Cero escrito como texto («0», «0.00000000»): comparación de representación, sin aritmética. */
const esCeroTexto = (v: string | undefined): boolean =>
  v === undefined || /^-?0*(?:\.0*)?$/.test(v);

/**
 * L-04: lo que el servidor propone, dicho en una frase. La quincena NO se calcula aquí: viene en
 * la propuesta (platform.iva_period_proposal), igual que el vencimiento por terminal del RIF.
 */
function AvisoPeriodicidad({ p }: { p: IvaPeriodProposal }): React.JSX.Element {
  const quien =
    p.periodicity === "quincenal"
      ? "Eres contribuyente especial: declaras el IVA por quincena (del 1 al 15 y del 16 al último día), según la PA SNAT/2025/000091."
      : p.periodicity === "mensual"
        ? "Declaras el IVA por mes."
        : "Declara tu tipo de contribuyente en Configuración para saber si declaras por mes o por quincena.";
  const vence =
    p.due_date !== null
      ? ` Vence el ${fechaLocal(p.due_date)} según el terminal de tu RIF.`
      : p.due_date_status === "pending_review"
        ? " La fecha de vencimiento de este período está pendiente de cotejo con la Gaceta: no la mostramos hasta confirmarla."
        : "";
  return (
    <p className="text-[0.86rem] text-muted-foreground">
      {quien} Período propuesto: del {fechaLocal(p.period_from)} al {fechaLocal(p.period_to)}.
      {vence}
    </p>
  );
}

export function Declaraciones(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  // L-04: el período inicial lo propone el servidor según el tipo vigente; antes era el mes
  // anterior calculado aquí, también para el especial que declara por quincena.
  const propuesta = useQuery({
    queryKey: ["iva-propuesta", empresa.id],
    queryFn: () => llamar<IvaPeriodProposal>("/v1/fiscal-declarations/iva-periods/proposal"),
  });
  const [elegido, setRango] = useState<{ from: string; to: string } | null>(null);
  const rango =
    elegido ??
    (propuesta.data === undefined
      ? null
      : { from: propuesta.data.period_from, to: propuesta.data.period_to });

  if (rango === null) {
    return (
      <div>
        <PageHeader
          title="Declarar IVA"
          description="La planilla demostrativa del período: lo que Ladino calcula desde tus documentos. NO es la declaración oficial — se transcribe al portal del SENIAT."
        />
        {propuesta.isError ? (
          <FalloDeCarga error={propuesta.error} reintentar={() => void propuesta.refetch()} />
        ) : (
          <Skeleton className="h-64" />
        )}
      </div>
    );
  }

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
          {propuesta.data !== undefined && <AvisoPeriodicidad p={propuesta.data} />}
        </CardContent>
      </Card>

      <Tabs defaultValue="periodo">
        <TabsList className="mb-3">
          <TabsTab value="periodo">El período</TabsTab>
          {/* L-12 (ADR-0072 §9): el nombre dice de quién es la retención. */}
          <TabsTab value="retenciones">Retenciones que nos practicaron (clientes)</TabsTab>
          <TabsTab value="calendario">Vencimientos</TabsTab>
        </TabsList>
        <TabsPanel value="periodo">
          <Periodo desde={rango.from} hasta={rango.to} />
        </TabsPanel>
        <TabsPanel value="retenciones">
          {/* La clave reinicia la página al cambiar el período: la página 3 de
              un período no es la página 3 de otro. */}
          <Retenciones
            key={`${rango.from}_${rango.to}`}
            desde={rango.from}
            hasta={rango.to}
            // F-09: tras cargar, la lista salta al período del comprobante recién cargado.
            onCargado={(fecha) => setRango(mesDe(fecha))}
          />
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
/**
 * El importe del CSV con dos decimales y coma, SIN símbolo — y sin aritmética:
 * el mismo criterio que `money.ts`. Los importes de la planilla son dinero ya
 * redondeado por el servidor a dos decimales y viajan con los ocho ceros de
 * `numeric(24,8)`; aquí solo se quitan CEROS FINALES (representación, no
 * precisión) y se rellena hasta dos. Si un importe trajera de verdad más de
 * dos decimales significativos, se escribe EXACTO: recortarlo sería redondear
 * dinero en el cliente, y eso está prohibido.
 */
function aDosDecimalesTexto(importe: string): string {
  const neg = importe.startsWith("-");
  const cuerpo = neg ? importe.slice(1) : importe;
  const [entera = "0", decimal = ""] = cuerpo.split(".");
  const ent = entera.replace(/^0+(?=\d)/, "");
  const dec = decimal.replace(/0+$/, "");
  const dosDecimales = dec.length <= 2 ? `${dec}00`.slice(0, 2) : dec;
  return `${neg ? "-" : ""}${ent},${dosDecimales}`;
}

function descargarPlanilla(p: IvaPeriodResult, desde: string, hasta: string): void {
  const filas: string[][] = [
    ["PLANILLA DEMOSTRATIVA — NO OFICIAL (generada por Ladino)"],
    [`Período`, `${desde} a ${hasta}`],
    [`Moneda`, p.functional_currency],
    [`Generada`, p.created_at],
    [`Huella`, p.dataset_hash],
    [],
    ["Concepto", "Importe"],
    ["Débito fiscal del período", aDosDecimalesTexto(p.debitos)],
    ...p.detalle.map((d) => [
      `  alícuota ${mostrarPorcentaje(d.alicuota)} — base ${aDosDecimalesTexto(d.base)}`,
      aDosDecimalesTexto(d.impuesto),
    ]),
    ["Crédito fiscal del período", aDosDecimalesTexto(p.creditos)],
    ...(p.prorrata_pct === null
      ? []
      : [
          [
            `Crédito deducible tras la prorrata (${mostrarPorcentaje(p.prorrata_pct)})`,
            aDosDecimalesTexto(p.creditos_deducibles),
          ],
        ]),
    // R-2 ampliada: la casilla solo aparece cuando trae algo (texto, sin aritmética).
    ...(p.ajuste_creditos_anteriores === undefined ||
    /^-?0*(?:\.0*)?$/.test(p.ajuste_creditos_anteriores)
      ? []
      : [
          [
            "Ajustes a los créditos fiscales de períodos anteriores",
            aDosDecimalesTexto(p.ajuste_creditos_anteriores),
          ],
        ]),
    ["Excedente de crédito fiscal del período anterior", aDosDecimalesTexto(p.excedente_anterior)],
    ...(p.retenciones_acumuladas_anteriores === undefined
      ? []
      : [
          [
            "Retenciones acumuladas por descontar del período anterior",
            aDosDecimalesTexto(p.retenciones_acumuladas_anteriores),
          ],
        ]),
    ["Retenciones de IVA soportadas en el período", aDosDecimalesTexto(p.retenciones_soportadas)],
    ["Cuota a pagar", aDosDecimalesTexto(p.cuota_a_pagar)],
    // L-05: dos arrastres, nunca una sola cifra (Forma 00030).
    [
      "Excedente de crédito fiscal que pasa al período siguiente",
      aDosDecimalesTexto(p.excedente_siguiente),
    ],
    ...(p.retenciones_acumuladas_por_descontar === undefined
      ? []
      : [
          [
            "Retenciones acumuladas por descontar que pasan al período siguiente",
            aDosDecimalesTexto(p.retenciones_acumuladas_por_descontar),
          ],
        ]),
    [`Generador`, p.generator_version],
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

  if (generaciones.isPending) return <Skeleton className="h-64" />;
  if (generaciones.isError) {
    return (
      <FalloDeCarga error={generaciones.error} reintentar={() => void generaciones.refetch()} />
    );
  }
  const items = generaciones.data.items;
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
                      concepto={`— alícuota ${mostrarPorcentaje(d.alicuota)}`}
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
                      nota={`Prorrata ${mostrarPorcentaje(ultima.prorrata_pct)} — hubo ventas sin impuesto en el período`}
                      importe={ultima.creditos_deducibles}
                      moneda={moneda}
                    />
                  )}
                  {ultima.ajuste_creditos_anteriores !== undefined &&
                    !/^-?0*(?:\.0*)?$/.test(ultima.ajuste_creditos_anteriores) && (
                      <Renglon
                        concepto="Ajustes a los créditos fiscales de períodos anteriores"
                        nota="Facturas de proveedor anuladas después de cerrar y presentar su período: se revierte su crédito aquí"
                        importe={ultima.ajuste_creditos_anteriores}
                        moneda={moneda}
                      />
                    )}
                  <Renglon
                    concepto="Excedente de crédito fiscal del período anterior"
                    nota="Viene encadenado de la última generación del período contiguo"
                    importe={ultima.excedente_anterior}
                    moneda={moneda}
                  />
                  {ultima.retenciones_acumuladas_anteriores !== undefined && (
                    <Renglon
                      concepto="Retenciones acumuladas por descontar del período anterior"
                      nota="Las que la cuota del período anterior no absorbió: llegan aparte del crédito fiscal"
                      importe={ultima.retenciones_acumuladas_anteriores}
                      moneda={moneda}
                    />
                  )}
                  <Renglon
                    concepto="Retenciones de IVA que nos practicaron en el período"
                    nota="Comprobantes cargados con fecha dentro del período"
                    importe={ultima.retenciones_soportadas}
                    moneda={moneda}
                  />
                  <Renglon
                    concepto="Cuota a pagar"
                    importe={ultima.cuota_a_pagar}
                    moneda={moneda}
                    destacado
                  />
                  <Renglon
                    concepto="Excedente de crédito fiscal que pasa al período siguiente"
                    nota={
                      // H9: la MISMA condición con la que el dominio se niega a encadenar.
                      ultima.generator_version === "iva-declarations/1.0.0" &&
                      (!esCeroTexto(ultima.excedente_siguiente) ||
                        !esCeroTexto(ultima.retenciones_soportadas))
                        ? "Generada con la versión que mezclaba crédito fiscal y retenciones en una sola cifra: vuelve a generar el período para separarlas"
                        : "Solo crédito fiscal: las retenciones no descontadas van en su renglón"
                    }
                    importe={ultima.excedente_siguiente}
                    moneda={moneda}
                    destacado
                  />
                  {ultima.retenciones_acumuladas_por_descontar !== undefined && (
                    <Renglon
                      concepto="Retenciones acumuladas por descontar que pasan al período siguiente"
                      nota="Retenciones soportadas que la cuota no absorbió: pasan aparte, como en la Forma 00030"
                      importe={ultima.retenciones_acumuladas_por_descontar}
                      moneda={moneda}
                      destacado
                    />
                  )}
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
                    <TH className="text-right">Excedente de crédito fiscal</TH>
                    <TH className="text-right">Retenciones por descontar</TH>
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
                      <TDNum>
                        {g.retenciones_acumuladas_por_descontar === undefined
                          ? "—"
                          : mostrarImporte({
                              amount: g.retenciones_acumuladas_por_descontar,
                              currency: moneda,
                            })}
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

function Retenciones({
  desde,
  hasta,
  onCargado,
}: {
  desde: string;
  hasta: string;
  onCargado: (fecha: string) => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const [pagina, setPagina] = useState(1);
  // El servidor pagina (default 50) y manda `total`: sin paginador, la fila 51
  // desaparecía en silencio — lo mismo que este módulo condena en los libros.
  const retenciones = useQuery({
    queryKey: ["retenciones-soportadas", empresa.id, desde, hasta, pagina],
    queryFn: () =>
      llamar<{ items: SupportedRetention[]; total: number }>(
        `/v1/fiscal-declarations/supported-retentions?from=${desde}&to=${hasta}&per_page=${POR_PAGINA}&page=${pagina}`,
      ),
  });

  if (retenciones.isPending) return <Skeleton className="h-48" />;
  if (retenciones.isError) {
    return (
      <div className="space-y-4">
        <CargarRetencion onCargado={onCargado} />
        <FalloDeCarga error={retenciones.error} reintentar={() => void retenciones.refetch()} />
      </div>
    );
  }
  const items = retenciones.data.items;

  return (
    <div className="space-y-4">
      <CargarRetencion onCargado={onCargado} />
      <Card>
        <CardHeader>
          <CardTitle>Retenciones que nos practicaron (clientes)</CardTitle>
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
          <Paginador total={retenciones.data.total} pagina={pagina} onPagina={setPagina} />
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
 *
 * VALIDAR-SENIAT: las dos porciones del selector (75 % general, 100 % en los
 * supuestos que la providencia enumera) se ofrecen porque son las que traen
 * los comprobantes, no porque Ladino las afirme. La cita es la providencia
 * vigente de retenciones de IVA (PA SNAT/2025/000054); qué artículo fija cada
 * porcentaje lo confirma el asesor, y por eso el texto de ayuda no lo inventa.
 */
/**
 * Cargar el comprobante de retención que el cliente entrega al pagar (ADR-0072 §5, F-11). Vive
 * donde se COBRA (DetalleFactura, con la factura ya elegida) y aquí; lo carga quien tiene
 * `ar.retention.register` — el contador ya no ve el botón para recibir un 403.
 */
export function CargarRetencion({
  onCargado,
  inicial,
}: {
  onCargado: (fecha: string) => void;
  /** Desde la ficha de la factura: el cliente y la factura ya elegidos. */
  inicial?: { cliente: EntityOption; factura: EntityOption };
}): React.JSX.Element | null {
  const { empresa, llamar, puede } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  const [abierto, setAbierto] = useState(false);
  const [cliente, setCliente] = useState<EntityOption | null>(inicial?.cliente ?? null);
  const [factura, setFactura] = useState<EntityOption | null>(inicial?.factura ?? null);
  const [numero, setNumero] = useState("");
  const [fecha, setFecha] = useState(() => hoyLocal());
  // H4 (PA SNAT/2025/000054 art. 7): el día en que el agente ENTREGÓ el comprobante.
  // B-3: vacía por omisión — el servidor usa entonces la fecha de la retención.
  const [entrega, setEntrega] = useState("");
  const [base, setBase] = useState("");
  const [porcion, setPorcion] = useState("0.75");
  const [monto, setMonto] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [enviando, setEnviando] = useState(false);

  function limpiar(): void {
    setCliente(inicial?.cliente ?? null);
    setFactura(inicial?.factura ?? null);
    setNumero("");
    setBase("");
    setMonto("");
    setEntrega("");
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
          ...(entrega === "" ? {} : { received_on: entrega }),
          base: importeLimpio(base),
          rate: porcion,
          amount: importeLimpio(monto),
        }),
      });
      toast.success("Comprobante cargado", "La factura quedó abonada por el importe retenido.");
      await qc.invalidateQueries({ queryKey: ["retenciones-soportadas", empresa.id] });
      await qc.invalidateQueries({ queryKey: ["iva-periodos", empresa.id] });
      limpiar();
      setAbierto(false);
      onCargado(fecha);
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
    importeValido(base) &&
    importeValido(monto);

  if (!puede("ar.retention.register")) return null;
  if (!abierto) {
    return (
      <Button variant="secondary" onClick={() => setAbierto(true)}>
        <FilePlus2 className="mr-2 h-4 w-4" />
        Cargar un comprobante de retención
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
                  }>(`/v1/customers?search=${encodeURIComponent(q)}&per_page=10`);
                  return r.items.map((c) => ({
                    id: c.id,
                    label: c.legal_name,
                    ...(c.tax_id === null ? {} : { detalle: formatearDocumento(c.tax_id) }),
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
                buscar={async (q) => {
                  if (cliente === null) return [];
                  // `GET /v1/documents` acepta `search` (número o serie) desde la
                  // auditoría 2026-09-11: la búsqueda la hace el servidor, no
                  // esta pantalla sobre las últimas 50.
                  const aguja = q.trim();
                  const busqueda = aguja === "" ? "" : `&search=${encodeURIComponent(aguja)}`;
                  const r = await llamar<{
                    items: {
                      id: string;
                      series: string;
                      document_number: number | null;
                      total_amount: string;
                      functional_currency: string;
                      issued_at: string | null;
                    }[];
                  }>(
                    `/v1/documents?kind=invoice&status=issued&customer_id=${cliente.id}&per_page=20${busqueda}`,
                  );
                  return r.items.map((d) => ({
                    id: d.id,
                    label: `${d.series}-${d.document_number ?? "—"}`,
                    detalle: `${fechaLocal(d.issued_at)} · ${mostrarImporte({
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
          <FormField label="Fecha en que te entregaron el comprobante (opcional)">
            {(a) => (
              <Input
                id={a.id}
                type="date"
                value={entrega}
                onChange={(e) => setEntrega(e.target.value)}
              />
            )}
          </FormField>
          <p className="text-[0.8rem] text-faint-foreground sm:col-span-2">
            Déjala vacía si te lo entregaron a tiempo: se toma la fecha de la retención. Si te lo
            entregaron después de declarar la quincena de la retención, la retención se descuenta en
            el período de la entrega (PA SNAT/2025/000054 art. 7).
          </p>
          <FormField label="Base (el IVA de la factura)" error={motivoDeImporte(base) ?? undefined}>
            {(a) => (
              <Input
                id={a.id}
                inputMode="decimal"
                value={base}
                onChange={(e) => setBase(e.target.value)}
              />
            )}
          </FormField>
          <FormField
            label="Porción retenida"
            hint="La que dice el comprobante: 75 % en general, 100 % en los supuestos que fija la providencia vigente de retenciones de IVA (PA SNAT/2025/000054). Confírmalo con tu contador."
          >
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
          <FormField
            label="Monto retenido (el del comprobante)"
            error={motivoDeImporte(monto) ?? undefined}
          >
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

  if (vencimientos.isPending) return <Skeleton className="h-48" />;
  if (vencimientos.isError) {
    return (
      <div className="space-y-4">
        <CargarVencimiento />
        <FalloDeCarga error={vencimientos.error} reintentar={() => void vencimientos.refetch()} />
      </div>
    );
  }
  const items = vencimientos.data.items;
  const hoy = hoyLocal();

  return (
    <div className="space-y-4">
      <CalendarioProvidencia />
      <CargarVencimiento />
      <Card>
        <CardHeader>
          <CardTitle>Vencimientos que cargaste</CardTitle>
          <CardDescription>
            Fechas que cargaste tú, con su cita. Las de la providencia de especiales ya vienen
            arriba; aquí van las demás, o una corrección mientras se coteja una fecha.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground">
              No cargaste ningún vencimiento propio. Las fechas de la providencia de especiales, si
              te aplican, están arriba.
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

const OBLIGACIONES: Record<string, string> = {
  iva: "Declaración de IVA",
  ret_iva: "Retenciones de IVA que practicamos",
  igtf: "IGTF percibido",
  islr_anticipo: "Anticipo de ISLR",
  islr_definitiva: "Declaración definitiva de ISLR",
  islr_retenciones: "Retenciones de ISLR",
};

/**
 * L-09 (ADR-0072 §8): el calendario sembrado de la PA SNAT/2025/000091 para el terminal del RIF
 * de la empresa. El servidor filtra: solo llegan las fechas ofrecidas, y las pendientes de cotejo
 * con la Gaceta vienen contadas, no listadas.
 */
function CalendarioProvidencia(): React.JSX.Element | null {
  const { empresa, llamar } = useSesion();
  // El año del día de Caracas: solo el rango que se pide (formato, sin cálculo fiscal).
  const anio = hoyLocal().slice(0, 4);
  const calendario = useQuery({
    queryKey: ["calendario-providencia", empresa.id, anio],
    queryFn: () =>
      llamar<TaxCalendar>(`/v1/fiscal-declarations/calendar?from=${anio}-01-01&to=${anio}-12-31`),
  });
  if (calendario.isPending) return <Skeleton className="h-32" />;
  if (calendario.isError) {
    return <FalloDeCarga error={calendario.error} reintentar={() => void calendario.refetch()} />;
  }
  const c = calendario.data;
  const hoy = hoyLocal();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Calendario de contribuyentes especiales {anio}</CardTitle>
        <CardDescription>
          Las fechas de la providencia del año, transcritas de una fuente secundaria y pendientes de
          cotejo con la Gaceta.
          {c.items[0] !== undefined && ` Fuente: ${c.items[0].legal_source}`}
          {c.rif_terminal !== null && ` Terminal de tu RIF: ${c.rif_terminal}.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {c.items.length === 0 ? (
          <p className="py-4 text-center text-muted-foreground">
            {/* H6: «no aplica» y «no hay calendario» son dos frases distintas. */}
            {c.applies
              ? c.pending_review > 0
                ? `Ninguna fecha de ${anio} está confirmada todavía para tu terminal.`
                : `No hay calendario sembrado para ${anio}: pídele a tu contador la providencia del año y carga las fechas abajo, con su cita.`
              : c.rif_terminal === null
                ? "Tu RIF no termina en un dígito: no hay terminal con el que buscar tus fechas."
                : "Este calendario es de los contribuyentes especiales: no aplica a tu empresa."}
          </p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Obligación</TH>
                <TH>Período</TH>
                <TH>Vence</TH>
              </TR>
            </THead>
            <TBody>
              {c.items.map((d) => (
                <TR key={`${d.obligation}_${d.period_from}_${d.period_to}`}>
                  <TD>{OBLIGACIONES[d.obligation] ?? d.obligation}</TD>
                  <TD>
                    {fechaLocal(d.period_from)} → {fechaLocal(d.period_to)}
                  </TD>
                  <TD>
                    {fechaLocal(d.due_date)}
                    {d.due_date < hoy && (
                      <Badge tone="warning" className="ml-2">
                        pasó
                      </Badge>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {c.pending_review > 0 && (
          <p className="mt-3 text-[0.82rem] text-faint-foreground">
            {c.pending_review === 1
              ? "1 fecha está pendiente de cotejo con la Gaceta y no se muestra."
              : `${c.pending_review} fechas están pendientes de cotejo con la Gaceta y no se muestran.`}{" "}
            Si te toca una, confírmala con tu contador y cárgala abajo con su cita.
          </p>
        )}
      </CardContent>
    </Card>
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
                  { value: "ret_iva", label: "Retenciones que practicamos (a proveedores)" },
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
