import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  { value: "retenciones_iva", label: "Retenciones de IVA" },
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
        description="Obligación de PA 071 y PA 102. El libro se calcula desde los documentos cada vez: por eso cuadra con ellos."
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

  async function exportar(): Promise<void> {
    if (formato === null) return;
    setError(null);
    try {
      const r = await llamar<{ content: string; filename: string; run: FiscalBookRun }>(
        "/v1/fiscal-books/export",
        {
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
        },
      );
      const blob = new Blob([r.content], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      a.click();
      URL.revokeObjectURL(url);
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
    return Object.keys(primera).map((clave) => ({
      id: clave,
      header: COLUMNAS_DINERO.has(clave)
        ? () => <span className="block text-right">{ROTULO[clave] ?? humanizar(clave)}</span>
        : (ROTULO[clave] ?? humanizar(clave)),
      enableSorting: false,
      accessorFn: (fila: Record<string, unknown>) => fila[clave],
      cell: (c) => {
        const v = c.row.original[clave];
        if (v === null || v === undefined) return <span className="text-faint-foreground">—</span>;
        if (typeof v === "boolean") return v ? "sí" : "no";
        if (typeof v === "string" && COLUMNAS_DINERO.has(clave)) {
          return (
            <span className="block text-right font-mono text-[0.82rem]">
              {mostrarImporte({ amount: v, currency: b.currency })}
            </span>
          );
        }
        // La porción retenida viaja como fracción («0.75000000»): se enseña
        // como «75 %», moviendo la coma sobre el string.
        if (typeof v === "string" && clave === "rate") {
          return (
            <span className="block text-right font-mono text-[0.82rem]">
              {mostrarPorcentaje(v)}
            </span>
          );
        }
        if (typeof v === "string" && clave === "fx_rate") {
          return (
            <span className="block text-right font-mono text-[0.82rem]">{mostrarCantidad(v)}</span>
          );
        }
        if (typeof v === "string" && COLUMNAS_FECHA.has(clave)) {
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
            <div className="w-72">
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
        {!r.balanced && (
          <p role="alert" className="text-[0.9rem] text-destructive-soft-foreground">
            Hay un asiento que ningún documento respalda (o al revés). La diferencia de abajo dice
            cuánto y en qué concepto.
          </p>
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
                <TD>{f.concepto}</TD>
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
