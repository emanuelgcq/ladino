import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { BookOpenCheck, Download } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DataTable } from "../../components/DataTable.js";
import { DateRangePicker, FormField } from "../../components/forms.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { Button } from "../../ui/button.js";
import { SimpleSelect } from "../../ui/select.js";
import { Badge } from "../../ui/badge.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card.js";
import { Skeleton } from "../../ui/card.js";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../../ui/tabs.js";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "../../ui/table.js";
import { useToast } from "../../ui/toast.js";
import { mostrarCantidad, mostrarImporte } from "../../money.js";
import { mostrarPorcentaje } from "../../porcentaje.js";
import { formatearDocumento } from "@ladino/schemas";
import { esCero } from "../../components/decimal-compare.js";
import { MensajeError } from "../ventas/comunes.js";
import {
  errorDePersona,
  type BookFormatAdapter,
  type BookKind,
  type BookReconciliation,
  type FiscalBook,
  type FiscalBookRun,
} from "../../lib.js";
import { fechaHoraLocal, fechaLocal, mesLocalAnterior } from "../../fechas.js";

/**
 * Rótulos de las columnas de los cuatro libros (las fija la migración 27 y
 * las proyecta packages/domain/src/fiscal-books.ts). Lo que no esté aquí se
 * enseña con la clave humanizada — nunca crudo con guiones bajos.
 */
const ROTULO: Record<string, string> = {
  // ventas
  document_id: "Id",
  issued_on: "Fecha",
  kind: "Tipo",
  series: "Serie",
  document_number: "Número",
  control_identifier: "Identificador del control",
  control_number: "N.º de control",
  status: "Estado",
  customer_tax_id: "RIF del cliente",
  customer_name: "Cliente",
  customer_taxpayer_type: "Tipo de contribuyente",
  transaction_currency: "Moneda",
  fx_rate: "Tasa",
  base_gravada: "Base gravada",
  iva_debito: "IVA débito",
  base_exenta: "Base exenta",
  base_exonerada: "Base exonerada",
  base_no_sujeta: "No sujeta",
  base_sin_clasificar: "Sin clasificar",
  total_amount: "Total",
  journal_entry_id: "Asiento",
  // L-08 (RLIVA arts. 72 y 76): base e IVA por alícuota.
  base_alicuota_general: "Base alícuota general",
  iva_alicuota_general: "IVA alícuota general",
  alicuota_general: "Alícuota general",
  base_alicuota_adicional: "Base general + adicional",
  iva_alicuota_adicional: "IVA general + adicional",
  alicuota_adicional: "Alícuota general + adicional",
  base_alicuota_reducida: "Base alícuota reducida",
  iva_alicuota_reducida: "IVA alícuota reducida",
  alicuota_reducida: "Alícuota reducida",
  base_gravada_sin_alicuota: "Base gravada sin alícuota",
  iva_sin_clasificar: "IVA sin clasificar",
  // compras
  invoice_id: "Id",
  invoice_date: "Fecha de factura",
  supplier_tax_id: "RIF del proveedor",
  supplier_name: "Proveedor",
  supplier_kind: "Tipo de proveedor",
  supplier_document_number: "N.º de factura",
  supplier_control_number: "N.º de control",
  supplier_document_ref: "Referencia",
  iva_credito: "IVA crédito",
  iva_al_costo: "IVA al costo",
  tax_is_recoverable: "IVA recuperable",
  retenido_iva: "IVA retenido",
  retenido_islr: "ISLR retenido",
  // retenciones (IVA e ISLR)
  retention_id: "Id",
  receipt_number: "N.º de comprobante",
  receipt_series: "Serie del comprobante",
  fiscal_period: "Período fiscal",
  base_amount: "Base",
  rate: "Porcentaje",
  subtrahend: "Sustraendo",
  retained_amount: "Retenido",
  legal_source: "Fuente legal",
  receipt_status: "Estado del comprobante",
  concept_code: "Código de concepto",
  concept_name: "Concepto",
  formula_kind: "Fórmula",
};

/**
 * Identificadores internos: viajan en el CSV (trazabilidad) pero en pantalla eran UUID enteros
 * que nadie puede leer (QA de pantalla 2026-09-15, h. 65).
 */
const COLUMNAS_OCULTAS: ReadonlySet<string> = new Set([
  "document_id",
  "invoice_id",
  "retention_id",
  "journal_entry_id",
  // K-04: se enseñan DENTRO de la fecha de factura, como marca, no como columnas sueltas.
  "booked_on",
  "received_late",
]);

/** Los códigos que el libro trae crudos, dichos en llano. */
const VALOR_LEGIBLE: Record<string, Record<string, string>> = {
  kind: {
    invoice: "Factura",
    credit_note: "Nota de crédito",
    debit_note: "Nota de débito",
    receipt: "Recibo",
  },
  status: {
    issued: "Emitida",
    paid: "Pagada",
    annulled: "Anulada",
    posted: "Registrada",
    ajuste_periodo_anterior: "Ajuste de período anterior",
  },
  receipt_status: { issued: "Emitido", annulled: "Anulado", draft: "Borrador" },
  customer_taxpayer_type: {
    ordinario: "Ordinario",
    especial: "Especial",
    formal: "Formal",
    consumidor_final: "Consumidor final",
    no_sujeto: "No sujeto",
    no_domiciliado: "No domiciliado",
  },
  supplier_kind: { nacional: "Nacional", extranjero: "Extranjero" },
};

/**
 * Las columnas de DINERO, por lista explícita: antes se decidía por prefijo
 * (`base_`, `iva_`, `total_`…) y un prefijo decide también sobre lo que no
 * conoce. `rate` es una fracción y `fx_rate` una tasa: ni una ni otra es un
 * importe.
 */
const COLUMNAS_DINERO: ReadonlySet<string> = new Set([
  "base_gravada",
  "iva_debito",
  "iva_credito",
  "iva_al_costo",
  "base_exenta",
  "base_exonerada",
  "base_no_sujeta",
  "base_sin_clasificar",
  "base_alicuota_general",
  "iva_alicuota_general",
  "base_alicuota_adicional",
  "iva_alicuota_adicional",
  "base_alicuota_reducida",
  "iva_alicuota_reducida",
  "base_gravada_sin_alicuota",
  "iva_sin_clasificar",
  "retenido_iva",
  "retenido_islr",
  "total_amount",
  "base_amount",
  "subtrahend",
  "retained_amount",
]);

/** Columnas con fecha calendario («YYYY-MM-DD»): se enseñan como dd/mm/aaaa. */
const COLUMNAS_FECHA: ReadonlySet<string> = new Set(["issued_on", "invoice_date"]);

/** «supplier_document_ref» → «Supplier document ref», si la clave no tiene rótulo. */
function humanizar(clave: string): string {
  const texto = clave.replace(/_/g, " ");
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/**
 * Libros fiscales — Fase B sobre la pantalla de ayer. Las reglas visibles no
 * cambian (ADR-0044): el período es SIEMPRE explícito; «sin clasificar» se
 * enseña en ámbar y no se reparte; consultar no deja rastro y EXPORTAR sí —
 * con hash reproducible; ningún formato es oficial todavía y la pantalla no
 * ofrece el botón que fallaría.
 */
const LIBROS: readonly { value: BookKind; label: string }[] = [
  { value: "ventas", label: "Libro de ventas" },
  { value: "compras", label: "Libro de compras" },
  // L-12 (ADR-0072 §9): las que NOSOTROS practicamos, distintas de las que nos practicaron.
  { value: "retenciones_iva", label: "Retenciones que practicamos (a proveedores)" },
  { value: "retenciones_islr", label: "Retenciones de ISLR" },
];

function mesAnterior(): { from: string; to: string } {
  // El mes anterior del día de CARACAS, no del día UTC (CLAUDE.md §3).
  const m = mesLocalAnterior();
  return { from: m.desde, to: m.hasta };
}

export function Libros(): React.JSX.Element {
  const [kind, setKind] = useState<BookKind>("ventas");
  const [rango, setRango] = useState(mesAnterior());

  return (
    <div>
      <PageHeader
        title="Libros fiscales"
        description="Obligación del Reglamento de la LIVA (arts. 70 a 78). El libro se calcula desde los documentos cada vez: por eso cuadra con ellos."
      />

      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">
          <FormField label="Libro">
            {(a) => (
              <div className="w-52">
                <SimpleSelect
                  id={a.id}
                  value={kind}
                  onValueChange={(v) => setKind(v as BookKind)}
                  options={LIBROS.map((l) => ({ value: l.value, label: l.label }))}
                />
              </div>
            )}
          </FormField>
          <FormField label="Período — explícito, siempre">
            {() => (
              <DateRangePicker from={rango.from} to={rango.to} onChange={(r) => setRango(r)} />
            )}
          </FormField>
        </CardContent>
      </Card>

      <Tabs defaultValue="libro">
        <TabsList className="mb-3">
          <TabsTab value="libro">El libro</TabsTab>
          <TabsTab value="conciliacion">Conciliación con el mayor</TabsTab>
          <TabsTab value="generaciones">Generaciones</TabsTab>
        </TabsList>
        <TabsPanel value="libro">
          <Libro kind={kind} desde={rango.from} hasta={rango.to} />
        </TabsPanel>
        <TabsPanel value="conciliacion">
          <Conciliacion desde={rango.from} hasta={rango.to} />
        </TabsPanel>
        <TabsPanel value="generaciones">
          <Generaciones />
        </TabsPanel>
      </Tabs>
    </div>
  );
}

function Libro({
  kind,
  desde,
  hasta,
}: {
  kind: BookKind;
  desde: string;
  hasta: string;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  // El formato elegido a mano; mientras no haya elección, manda el PRIMER
  // formato con implementación del catálogo (antes iba fijo a un código que
  // el servidor podía no tener implementado para este libro).
  const [formatoElegido, setFormatoElegido] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  // H6: la última generación exportada en esta pantalla; su resumen del art. 72 se descarga aparte.
  const [ultimaGeneracion, setUltimaGeneracion] = useState<FiscalBookRun | null>(null);
  const [error, setError] = useState<unknown>(null);

  const libro = useQuery({
    queryKey: ["libro", empresa.id, kind, desde, hasta],
    queryFn: () => llamar<FiscalBook>(`/v1/fiscal-books/${kind}?from=${desde}&to=${hasta}`),
  });
  const formatos = useQuery({
    queryKey: ["formatos-libro", empresa.id],
    staleTime: 300_000,
    queryFn: () => llamar<BookFormatAdapter[]>("/v1/fiscal-books/formats"),
  });
  const formato = formatoElegido ?? (formatos.data ?? []).find((f) => f.implemented)?.code ?? null;

  /** H6: el resumen del art. 72 de la generación recién exportada, como `resumen-art72.csv`. */
  async function descargarResumen(): Promise<void> {
    if (ultimaGeneracion === null) return;
    setError(null);
    try {
      const r = await llamar<{ content: string; filename: string }>(
        `/v1/fiscal-books/runs/${ultimaGeneracion.id}/summary-art72`,
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ company_id: empresa.id }),
        },
      );
      descargarCsv(r.content, r.filename);
    } catch (e) {
      setError(e);
    }
  }

  async function exportar(): Promise<void> {
    if (formato === null) return;
    setError(null);
    try {
      const r = await llamar<{
        content: string;
        filename: string;
        run: FiscalBookRun;
        summary_content?: string;
        summary_filename?: string;
      }>("/v1/fiscal-books/export", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          book_kind: kind,
          period_from: desde,
          period_to: hasta,
          format_code: formato,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      descargarCsv(r.content, r.filename);
      // B1: en ventas, el resumen del art. 72 de esta misma generación viene en la respuesta.
      if (r.summary_content !== undefined && r.summary_filename !== undefined) {
        descargarCsv(r.summary_content, r.summary_filename);
      }
      setUltimaGeneracion(r.run);
      toast.success("Generación registrada", `Hash ${r.run.dataset_hash.slice(0, 16)}…`);
      await qc.invalidateQueries({ queryKey: ["generaciones", empresa.id] });
    } catch (e) {
      setError(e);
      throw e;
    }
  }

  const b = libro.data;
  const elegido = (formatos.data ?? []).find((f) => f.code === formato);

  const columnas = useMemo<ColumnDef<Record<string, unknown>, unknown>[]>(() => {
    if (b === undefined || b.rows.length === 0) return [];
    const primera = b.rows[0] ?? {};
    return Object.keys(primera)
      .filter((clave) => !COLUMNAS_OCULTAS.has(clave))
      .map((clave) => ({
        id: clave,
        header: COLUMNAS_DINERO.has(clave)
          ? () => <span className="block text-right">{ROTULO[clave] ?? humanizar(clave)}</span>
          : (ROTULO[clave] ?? humanizar(clave)),
        enableSorting: false,
        accessorFn: (fila: Record<string, unknown>) => fila[clave],
        cell: (c) => {
          const v = c.row.original[clave];
          if (v === null || v === undefined)
            return <span className="text-faint-foreground">—</span>;
          if (typeof v === "boolean") return v ? "sí" : "no";
          // El RIF llega normalizado del libro (hallazgo 1 de la revisión, 2026-09-28): se
          // enseña como en el CSV y en el resto de Ladino, con la función compartida.
          if (typeof v === "string" && clave.endsWith("_tax_id")) {
            return <span className="font-mono">{formatearDocumento(v)}</span>;
          }
          if (typeof v === "string" && VALOR_LEGIBLE[clave]?.[v] !== undefined) {
            return VALOR_LEGIBLE[clave][v];
          }
          if (typeof v === "string" && COLUMNAS_DINERO.has(clave)) {
            return (
              <span className="block text-right font-mono text-[0.82rem]">
                {mostrarImporte({ amount: v, currency: b.currency })}
              </span>
            );
          }
          // La porción retenida viaja como fracción («0.75000000»): se enseña
          // como «75 %», moviendo la coma sobre el string.
          if (typeof v === "string" && (clave === "rate" || clave.startsWith("alicuota_"))) {
            return (
              <span className="block text-right font-mono text-[0.82rem]">
                {mostrarPorcentaje(v)}
              </span>
            );
          }
          if (typeof v === "string" && clave === "fx_rate") {
            return (
              <span className="block text-right font-mono text-[0.82rem]">
                {mostrarCantidad(v)}
              </span>
            );
          }
          if (typeof v === "string" && COLUMNAS_FECHA.has(clave)) {
            // ADR-0069 §4: la factura de un mes cerrado entra en el período en que se registró,
            // con su fecha original. El libro lo dice en la fila.
            if (clave === "invoice_date" && c.row.original["received_late"] === true) {
              return (
                <span className="text-[0.84rem]">
                  {fechaLocal(v)}
                  <span className="block text-[0.76rem] text-warning">
                    Recibida con retraso · fecha original {fechaLocal(v)}
                  </span>
                </span>
              );
            }
            return <span className="text-[0.84rem]">{fechaLocal(v)}</span>;
          }
          // Solo primitivos: las filas del libro traen strings y números, y un
          // objeto inesperado se enseña como «?» antes que como [object Object].
          const texto = typeof v === "string" || typeof v === "number" ? String(v) : "?";
          return <span className="text-[0.84rem]">{texto}</span>;
        },
      }));
  }, [b]);

  return (
    <div className="space-y-3">
      {b !== undefined && b.unclassified_rows > 0 && (
        <p
          role="alert"
          className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-[0.9rem] text-warning-soft-foreground"
        >
          <strong>{b.unclassified_rows}</strong> renglones traen base SIN CLASIFICAR: documentos
          emitidos antes de que el tratamiento se congelara en la línea. Van en su propia columna y
          NO se reparten — adivinarlos sería declarar algo que nadie registró.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Exportar — deja rastro con hash</CardTitle>
          <span className="text-[0.82rem] text-muted-foreground">
            {b?.row_count ?? "…"} renglones · {b?.currency ?? ""}
          </span>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full sm:w-72">
              <SimpleSelect
                ariaLabel="Formato de exportación"
                value={formato}
                onValueChange={setFormatoElegido}
                options={(formatos.data ?? []).map((f) => ({
                  value: f.code,
                  label: `${f.name}${f.is_official ? " (oficial)" : ""}${f.implemented ? "" : " — sin implementación"}`,
                  disabled: !f.implemented,
                }))}
              />
            </div>
            <Button
              variant="primary"
              disabled={elegido === undefined || !elegido.implemented}
              onClick={() => setConfirmando(true)}
            >
              <Download /> Exportar y registrar…
            </Button>
            {(kind === "ventas" || kind === "compras") && (
              <Button
                variant="secondary"
                disabled={ultimaGeneracion === null || ultimaGeneracion.book_kind !== kind}
                title={
                  ultimaGeneracion === null
                    ? "Exporta primero el libro: el resumen es de esa generación."
                    : undefined
                }
                onClick={() => void descargarResumen()}
              >
                <Download /> Descargar el resumen (art. 72)
              </Button>
            )}
          </div>
          {elegido !== undefined && !elegido.is_official && (
            <CardDescription>
              <strong>No es el formato oficial de presentación.</strong> {elegido.description}
            </CardDescription>
          )}
          {error !== null && <MensajeError error={error} />}
        </CardContent>
      </Card>

      {/* El rótulo va también SOBRE la tabla: quien mire el libro en pantalla
          (o lo imprima) tiene que ver que no es el formato de presentación. */}
      <p
        role="note"
        className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-[0.86rem] text-warning-soft-foreground"
      >
        <strong>NO OFICIAL.</strong> Este libro se calcula desde los documentos para consultarlo;
        ningún formato del catálogo es todavía el oficial de presentación al SENIAT.
      </p>

      <DataTable
        columns={columnas}
        data={b?.rows}
        error={libro.error instanceof Error ? libro.error.message : null}
        onRetry={() => void libro.refetch()}
        density="compact"
        virtualized={(b?.rows.length ?? 0) > 60}
        empty={{
          icon: BookOpenCheck,
          title: "Sin movimientos en el período",
          description: "El libro se calcula desde los documentos: sin documentos, libro vacío.",
        }}
      />

      {b?.summary !== undefined && b.summary.length > 0 && (
        <ResumenArt72 resumen={b.summary} moneda={b.currency} />
      )}

      <ConfirmDialog
        open={confirmando}
        onOpenChange={setConfirmando}
        title="Exportar el libro"
        confirmLabel="Exportar y registrar"
        onConfirm={exportar}
      >
        {LIBROS.find((l) => l.value === kind)?.label ?? kind} de {desde} a {hasta}, en formato{" "}
        <strong>{elegido?.name ?? formato}</strong>. Queda registrada la generación con su{" "}
        <strong>hash del dataset</strong>: dos exportaciones iguales dan el mismo hash, y una
        distinta demuestra que algo cambió entre medias — que es exactamente lo que hay que poder
        probar en una fiscalización. Consultar en pantalla, en cambio, no deja rastro.
      </ConfirmDialog>
    </div>
  );
}

/** El concepto de la conciliación, en palabras de persona (L-06). */
const CONCEPTO_LEGIBLE: Record<string, string> = {
  iva_debito_fiscal: "IVA débito fiscal (ventas)",
  iva_credito_fiscal: "IVA crédito fiscal (compras)",
};

/**
 * A dónde lleva un documento de la conciliación. Las ventas tienen detalle propio; las compras,
 * por ahora, solo su lista. Un tipo que no se reconoce no lleva a ninguna parte: mejor sin enlace
 * que con uno que abre otra cosa.
 */
const ABRE_EL_DETALLE_DE_VENTAS = new Set([
  // Las clases de `documents` que DetalleFactura (/admin/ventas/:id) abre: la lista de ventas
  // enruta a esa pantalla toda fila de documents (Ventas.tsx, onRowClick), recibos y
  // devoluciones incluidos. Lo que no es un documento de venta (`sales_cost`, cobros, gastos,
  // cierres de caja…) no está aquí y va sin enlace.
  "invoice",
  "credit_note",
  "debit_note",
  "sales_invoice",
  "sales_credit_note",
  "sales_debit_note",
  "sales_receipt",
  "sales_receipt_return",
]);

function rutaDeDocumento(clase: string | null, id: string | null): string | null {
  if (id === null || clase === null) return null;
  if (ABRE_EL_DETALLE_DE_VENTAS.has(clase)) return `/admin/ventas/${id}`;
  if (
    ["purchase", "purchase_invoice", "purchase_credit_note", "ajuste_periodo_anterior"].includes(
      clase,
    )
  ) {
    return "/admin/compras";
  }
  return null;
}

const CLASE_LEGIBLE: Record<string, string> = {
  invoice: "Factura",
  credit_note: "Nota de crédito",
  debit_note: "Nota de débito",
  purchase: "Compra",
  ajuste_periodo_anterior: "Ajuste de período anterior",
  sales_invoice: "Factura",
  sales_credit_note: "Nota de crédito",
  sales_debit_note: "Nota de débito",
  sales_receipt: "Recibo",
  sales_receipt_return: "Recibo de devolución",
  purchase_invoice: "Factura de proveedor",
  purchase_credit_note: "Nota de crédito de proveedor",
};

function Conciliacion({ desde, hasta }: { desde: string; hasta: string }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const rec = useQuery({
    queryKey: ["conciliacion", empresa.id, desde, hasta],
    queryFn: () =>
      llamar<BookReconciliation>(
        `/v1/fiscal-books/reports/reconciliation?from=${desde}&to=${hasta}`,
      ),
  });

  // Un fallo no es «cargando para siempre»: antes, cualquier error dejaba el
  // esqueleto eterno y nadie sabía si la conciliación existía.
  if (rec.isPending) return <Skeleton className="h-40 w-full" />;
  if (rec.isError) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-[0.88rem] text-destructive-soft-foreground"
      >
        <span>{errorDePersona(rec.error)}</span>
        <Button variant="secondary" size="sm" onClick={() => void rec.refetch()}>
          Reintentar
        </Button>
      </div>
    );
  }
  const r = rec.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <code className="text-[0.9rem]">libro = mayor + pendientes en cola</code>
        </CardTitle>
        <Badge tone={r.balanced ? "accent" : "destructive"}>
          {r.balanced ? "Cuadra" : "NO cuadra"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <CardDescription>
          Las tres cifras a la vista: mientras un documento correcto pueda estar sin contabilizar,
          una diferencia no es un error — es la cola. Lo que sí es un error es que no cuadre{" "}
          <em>ni contando la cola</em>.
        </CardDescription>
        {/* L-06: «falta un asiento» solo se dice cuando la cobertura contable lo CONFIRMA, y
            con el documento a la vista. Antes se decía ante cualquier diferencia, y era falso. */}
        {!r.balanced && (r.coverage_gaps ?? []).length > 0 && (
          <div role="alert" className="space-y-1 text-[0.9rem] text-destructive-soft-foreground">
            <p>
              En toda la empresa —no solo en este período— hay documentos registrados sin asiento
              contable ni pendiente en cola:
            </p>
            <ul className="list-disc pl-5">
              {(r.coverage_gaps ?? []).map((g) => {
                const ruta = rutaDeDocumento(g.source_kind, g.source_id);
                const nombre = CLASE_LEGIBLE[g.source_kind] ?? "Documento";
                return (
                  <li key={`${g.source_kind}-${g.source_id}`}>
                    {ruta === null ? (
                      nombre
                    ) : (
                      <Link to={ruta} className="underline">
                        {nombre}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {!r.balanced && (r.discrepancies ?? []).length > 0 && (
          <div role="alert" className="space-y-1 text-[0.9rem] text-destructive-soft-foreground">
            <p>El libro y el mayor no dicen lo mismo en estos documentos y asientos:</p>
            <ul className="list-disc pl-5">
              {(r.discrepancies ?? []).map((d) => {
                const ruta = rutaDeDocumento(d.document_kind, d.document_id);
                const doc =
                  d.document_id === null
                    ? "Asiento que ningún documento del libro respalda"
                    : (CLASE_LEGIBLE[d.document_kind ?? ""] ?? "Documento");
                return (
                  <li key={`${d.concepto}-${d.document_id ?? ""}-${d.journal_entry_id ?? ""}`}>
                    {ruta === null ? (
                      doc
                    ) : (
                      <Link to={ruta} className="underline">
                        {doc}
                      </Link>
                    )}
                    {d.entry_number !== null && (
                      <>
                        {" · "}
                        <Link to="/admin/contabilidad" className="underline">
                          asiento N.º {d.entry_number}
                        </Link>
                      </>
                    )}
                    {" — "}
                    {CONCEPTO_LEGIBLE[d.concepto] ?? d.concepto}: libro{" "}
                    {mostrarImporte({ amount: d.libro, currency: r.currency })}, mayor{" "}
                    {mostrarImporte({ amount: d.mayor, currency: r.currency })}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <Table>
          <THead>
            <TR>
              <TH>Concepto</TH>
              <TH className="text-right">Libro</TH>
              <TH className="text-right">Mayor</TH>
              <TH className="text-right">En cola</TH>
              <TH className="text-right">Diferencia</TH>
            </TR>
          </THead>
          <TBody>
            {r.rows.map((f) => (
              <TR key={f.concepto}>
                <TD>{CONCEPTO_LEGIBLE[f.concepto] ?? f.concepto}</TD>
                <TDNum>{mostrarImporte({ amount: f.libro, currency: r.currency })}</TDNum>
                <TDNum>{mostrarImporte({ amount: f.mayor, currency: r.currency })}</TDNum>
                <TDNum>{mostrarImporte({ amount: f.en_cola, currency: r.currency })}</TDNum>
                <TDNum
                  className={
                    f.cuadra ? "text-accent-soft-foreground" : "text-destructive-soft-foreground"
                  }
                >
                  {esCero(f.diferencia)
                    ? "0"
                    : mostrarImporte({ amount: f.diferencia, currency: r.currency })}
                </TDNum>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Generaciones(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const runs = useQuery({
    queryKey: ["generaciones", empresa.id],
    queryFn: () => llamar<{ runs: FiscalBookRun[] }>("/v1/fiscal-books/runs"),
  });

  const columnas = useMemo<ColumnDef<FiscalBookRun, unknown>[]>(
    () => [
      { id: "libro", header: "Libro", accessorKey: "book_kind", enableSorting: false },
      {
        id: "periodo",
        header: "Período",
        enableSorting: false,
        accessorFn: (r) => `${r.period_from} → ${r.period_to}`,
        cell: (c) => <span className="font-mono text-[0.82rem]">{c.getValue<string>()}</span>,
      },
      {
        id: "renglones",
        header: () => <span className="block text-right">Renglones</span>,
        accessorKey: "row_count",
        enableSorting: false,
        cell: (c) => <span className="block text-right font-mono">{c.getValue<number>()}</span>,
      },
      { id: "formato", header: "Formato", accessorKey: "format_code", enableSorting: false },
      {
        id: "hash",
        header: "Hash del dataset",
        accessorKey: "dataset_hash",
        enableSorting: false,
        cell: (c) => (
          <code className="text-[0.78rem]" title={c.getValue<string>()}>
            {c.getValue<string>().slice(0, 16)}…
          </code>
        ),
      },
      {
        id: "cuando",
        header: "Cuándo",
        accessorFn: (r) => fechaHoraLocal(r.created_at),
      },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      <p className="text-[0.88rem] text-muted-foreground">
        Una fila por EXPORTACIÓN. Dos generaciones del mismo período con el mismo hash dijeron lo
        mismo; con hash distinto, algo cambió entre medias — y eso es lo que este registro permite
        demostrar.
      </p>
      <DataTable
        columns={columnas}
        data={runs.data?.runs}
        error={runs.error instanceof Error ? runs.error.message : null}
        onRetry={() => void runs.refetch()}
        density="compact"
        empty={{
          title: "Todavía no se ha exportado ningún libro",
          description: "Consultar en pantalla no deja rastro; exportar para presentar, sí.",
        }}
      />
    </div>
  );
}

const CONCEPTO_DEL_RESUMEN: Record<string, string> = {
  gravado_general: "Alícuota general",
  gravado_adicional: "Alícuota general + adicional",
  gravado_reducida: "Alícuota reducida",
  exento: "Exentas",
  exonerado: "Exoneradas",
  no_sujeto: "No sujetas",
  sin_clasificar: "Sin clasificar",
};

/**
 * El resumen de los libros de ventas y de compras (RLIVA art. 72, L-08, hallazgo 6): base e IVA
 * por alícuota, exentas,
 * exoneradas, no sujetas y lo que viene de notas. Todas las cifras las calcula el servidor.
 */
function ResumenArt72({
  resumen,
  moneda,
}: {
  resumen: NonNullable<FiscalBook["summary"]>;
  moneda: string;
}): React.JSX.Element {
  return (
    <section
      aria-label="Resumen del período"
      className="space-y-2 rounded-md border border-border p-3"
    >
      <h3 className="font-medium">Resumen del período (Reglamento de la Ley de IVA, art. 72)</h3>
      <table className="w-full text-[0.85rem]">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="font-normal">Concepto</th>
            <th className="text-right font-normal">Alícuota</th>
            <th className="text-right font-normal">Base</th>
            <th className="text-right font-normal">IVA</th>
            <th className="text-right font-normal">De ellas, por notas</th>
          </tr>
        </thead>
        <tbody>
          {resumen.map((r) => (
            <tr key={`${r.concept}-${r.rate ?? ""}`}>
              <td>{CONCEPTO_DEL_RESUMEN[r.concept] ?? r.concept}</td>
              <td className="text-right font-mono">
                {r.rate === null ? "—" : mostrarPorcentaje(r.rate)}
              </td>
              <td className="text-right font-mono">
                {mostrarImporte({ amount: r.base, currency: moneda })}
              </td>
              <td className="text-right font-mono">
                {mostrarImporte({ amount: r.tax, currency: moneda })}
              </td>
              <td className="text-right font-mono">
                {mostrarImporte({ amount: r.adjustments_base, currency: moneda })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Descarga un CSV que ya viene serializado del servidor. */
function descargarCsv(contenido: string, nombre: string): void {
  const blob = new Blob([contenido], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  a.click();
  URL.revokeObjectURL(url);
}
