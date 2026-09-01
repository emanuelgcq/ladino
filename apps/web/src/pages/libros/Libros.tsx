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
import { mostrarImporte } from "../../money.js";
import { esCero } from "../../components/decimal-compare.js";
import { MensajeError } from "../ventas/comunes.js";
import type {
  BookFormatAdapter,
  BookKind,
  BookReconciliation,
  FiscalBook,
  FiscalBookRun,
} from "../../lib.js";

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
  const hoy = new Date();
  const primeroDeEste = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 1));
  const ultimo = new Date(primeroDeEste.getTime() - 86_400_000);
  const primero = new Date(Date.UTC(ultimo.getUTCFullYear(), ultimo.getUTCMonth(), 1));
  return { from: primero.toISOString().slice(0, 10), to: ultimo.toISOString().slice(0, 10) };
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
  const [formato, setFormato] = useState("csv_columnas_legales");
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

  async function exportar(): Promise<void> {
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
      header: clave,
      enableSorting: false,
      accessorFn: (fila: Record<string, unknown>) => fila[clave],
      cell: (c) => {
        const v = c.row.original[clave];
        if (v === null || v === undefined) return <span className="text-faint-foreground">—</span>;
        if (typeof v === "boolean") return v ? "sí" : "no";
        if (typeof v === "string" && /^(base_|iva_|retenido_|total_|retained_)/.test(clave)) {
          return (
            <span className="block text-right font-mono text-[0.82rem]">
              {mostrarImporte({ amount: v, currency: b.currency })}
            </span>
          );
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
                onValueChange={setFormato}
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
        Libro de {kind} de {desde} a {hasta}. Queda registrada la generación con su{" "}
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

  const r = rec.data;
  if (r === undefined) return <Skeleton className="h-40 w-full" />;

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
        accessorFn: (r) => r.created_at.slice(0, 16).replace("T", " "),
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
