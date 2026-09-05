import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenCheck, CalendarX2, Import, Plus, Trash2 } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DataTable } from "../../components/DataTable.js";
import { DatePicker, FormField } from "../../components/forms.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { Button } from "../../ui/button.js";
import { Input, Textarea } from "../../ui/input.js";
import { SimpleSelect } from "../../ui/select.js";
import { Badge, type BadgeTone } from "../../ui/badge.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card.js";
import { Skeleton } from "../../ui/card.js";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../../ui/tabs.js";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "../../ui/table.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../ui/dialog.js";
import { useToast } from "../../ui/toast.js";
import { mostrarImporte } from "../../money.js";
import { MensajeError } from "../ventas/comunes.js";
import type { ColumnDef } from "@tanstack/react-table";
import type {
  Account,
  AccountPurposeRow,
  BalanceSheet,
  ChartTemplate,
  FiscalPeriod,
  IncomeStatement,
  JournalEntry,
  JournalEntryDetail,
  LedgerView,
  PendingJournal,
  TrialBalance,
} from "../../lib.js";

/**
 * Contabilidad — Fase B. Siete superficies en pestañas; la pantalla NO calcula
 * NADA: saldos, totales y el «cuadra» los trae el servidor.
 *
 * La ÚNICA excepción sigue siendo la del asiento manual, y sigue cumpliendo
 * sus tres condiciones (apps/web/CLAUDE.md): no persiste nada, no decide nada
 * —el trigger del servidor rechaza igual— y compara ENTEROS de céntimos.
 */
const HOY = (): string => new Date().toISOString().slice(0, 10);

const ESTADO_ASIENTO: Record<string, { etiqueta: string; tone: BadgeTone }> = {
  draft: { etiqueta: "Borrador", tone: "neutral" },
  posted: { etiqueta: "Posteado", tone: "accent" },
  reversed: { etiqueta: "Reversado", tone: "warning" },
};

export function Contabilidad(): React.JSX.Element {
  return (
    <div>
      <PageHeader
        title="Contabilidad"
        description="Partida doble en moneda funcional. Un asiento posteado no se edita: se reversa, y los dos quedan visibles."
      />
      <Tabs defaultValue="plan">
        <TabsList className="mb-3">
          <TabsTab value="plan">Plan de cuentas</TabsTab>
          <TabsTab value="diario">Diario</TabsTab>
          <TabsTab value="nuevo">Asiento manual</TabsTab>
          <TabsTab value="mayor">Mayor</TabsTab>
          <TabsTab value="balance">Comprobación</TabsTab>
          <TabsTab value="cierre">Cierre</TabsTab>
          <TabsTab value="estados">Estados</TabsTab>
        </TabsList>
        <TabsPanel value="plan">
          <PlanDeCuentas />
        </TabsPanel>
        <TabsPanel value="diario">
          <Diario />
        </TabsPanel>
        <TabsPanel value="nuevo">
          <AsientoManual />
        </TabsPanel>
        <TabsPanel value="mayor">
          <Mayor />
        </TabsPanel>
        <TabsPanel value="balance">
          <div className="space-y-4">
            <Comprobacion />
            <CoberturaContable />
          </div>
        </TabsPanel>
        <TabsPanel value="cierre">
          <Cierre />
        </TabsPanel>
        <TabsPanel value="estados">
          <Estados />
        </TabsPanel>
      </Tabs>
    </div>
  );
}

// ── Plan de cuentas ─────────────────────────────────────────────────────────

function PlanDeCuentas(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  const [alta, setAlta] = useState({ code: "", name: "", kind: "activo", parent_id: "" });
  const [importando, setImportando] = useState<ChartTemplate | null>(null);
  const [desactivando, setDesactivando] = useState<Account | null>(null);
  const [error, setError] = useState<unknown>(null);

  const datos = useQuery({
    queryKey: ["plan", empresa.id],
    queryFn: async () => {
      const [cuentas, plantillas, papeles] = await Promise.all([
        llamar<Account[]>("/v1/accounts"),
        llamar<ChartTemplate[]>("/v1/chart-templates"),
        llamar<AccountPurposeRow[]>("/v1/company-account-settings"),
      ]);
      return { cuentas, plantillas, papeles };
    },
  });
  const recargar = () => void qc.invalidateQueries({ queryKey: ["plan", empresa.id] });

  async function importar(code: string): Promise<void> {
    setError(null);
    try {
      const r = await llamar<{ imported: number; purposes: number }>(
        "/v1/accounts/import-template",
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ company_id: empresa.id, template_code: code }),
        },
      );
      toast.success("Plantilla importada", `${r.imported} cuentas y ${r.purposes} papeles.`);
      // ADR-0049: el plan SIN las plantillas de asiento deja toda venta en la
      // cola para siempre — la auditoría de superficie encontró este hueco.
      // Se importan juntas; si el preset ya estaba, el servidor lo dice y no
      // es un error que detenga nada.
      try {
        const t = await llamar<{ imported: number; lines: number }>(
          "/v1/journal-templates/import-preset",
          {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({ company_id: empresa.id, preset_code: code }),
          },
        );
        toast.success("Plantillas de asiento importadas", `${t.imported} plantillas.`);
      } catch {
        /* preset ya importado o plantilla sin preset: el plan quedó igual */
      }
      recargar();
    } catch (e) {
      setError(e);
      throw e;
    }
  }

  async function crear(): Promise<void> {
    setError(null);
    try {
      await llamar("/v1/accounts", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          code: alta.code,
          name: alta.name,
          kind: alta.kind,
          ...(alta.parent_id === "" ? {} : { parent_id: alta.parent_id }),
        }),
      });
      toast.success("Cuenta creada", `${alta.code} — ${alta.name}`);
      setAlta({ code: "", name: "", kind: "activo", parent_id: "" });
      recargar();
    } catch (e) {
      setError(e);
    }
  }

  async function desactivar(id: string): Promise<void> {
    setError(null);
    try {
      await llamar(`/v1/accounts/${id}/deactivate`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      toast.success("Cuenta desactivada", "El histórico queda intacto.");
      recargar();
    } catch (e) {
      setError(e);
      throw e;
    }
  }

  const d = datos.data;
  const sinAsignar = (d?.papeles ?? []).filter((p) => p.account_id === null);

  if (d === undefined) return <Skeleton className="h-48 w-full" />;

  return (
    <div className="space-y-4">
      {error !== null && <MensajeError error={error} />}

      {d.cuentas.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>El plan nace vacío</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <CardDescription>
              El plan de cuentas no se da por supuesto: lo decide tu contador (ADR-0043). Crea las
              cuentas a mano o importa una plantilla como punto de partida.
            </CardDescription>
            {d.plantillas.map((t) => (
              <div key={t.code} className="rounded-md border border-border p-3">
                <p className="font-medium">
                  {t.name}{" "}
                  <span className="text-[0.82rem] text-muted-foreground">
                    ({t.account_count} cuentas · {t.framework})
                  </span>
                </p>
                {/* El VALIDAR-CONTABLE se enseña ENTERO: es la advertencia que
                    evita adoptar la plantilla sin revisarla. */}
                <p className="mt-1 text-[0.85rem] text-warning-soft-foreground">{t.description}</p>
                <p className="mt-1 text-[0.78rem] text-faint-foreground">
                  Fuente: {t.legal_source}
                </p>
                <Button
                  variant="primary"
                  size="sm"
                  className="mt-2"
                  onClick={() => setImportando(t)}
                >
                  <Import /> Importar esta plantilla…
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Cuentas ({d.cuentas.length})</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-1">
            <Table>
              <THead>
                <TR>
                  <TH>Código</TH>
                  <TH>Nombre</TH>
                  <TH>Tipo</TH>
                  <TH>Naturaleza</TH>
                  <TH>Recibe asientos</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {d.cuentas.map((a) => (
                  <TR key={a.id} className={a.is_active ? "" : "opacity-50"}>
                    <TD>
                      <span
                        className="font-mono text-[0.84rem]"
                        style={{ paddingLeft: `${(a.level - 1) * 14}px` }}
                      >
                        {a.code}
                      </span>
                    </TD>
                    <TD className={a.is_leaf ? "" : "font-medium"}>{a.name}</TD>
                    <TD className="text-muted-foreground">{a.kind}</TD>
                    <TD className="text-muted-foreground">{a.nature}</TD>
                    <TD>
                      {/* Una cuenta que agrupa NO postea: decirlo aquí evita el 409. */}
                      {a.is_leaf ? (
                        a.is_active ? (
                          <Badge tone="accent">sí</Badge>
                        ) : (
                          <Badge tone="neutral">desactivada</Badge>
                        )
                      ) : (
                        <Badge tone="outline">agrupa</Badge>
                      )}
                    </TD>
                    <TD>
                      {a.is_active && (
                        <Button variant="ghost" size="sm" onClick={() => setDesactivando(a)}>
                          Desactivar
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Crear cuenta</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <FormField label="Código" required>
              {(a) => (
                <Input
                  id={a.id}
                  className="font-mono"
                  value={alta.code}
                  onChange={(e) => setAlta({ ...alta, code: e.target.value })}
                />
              )}
            </FormField>
            <FormField label="Nombre" required>
              {(a) => (
                <Input
                  id={a.id}
                  value={alta.name}
                  onChange={(e) => setAlta({ ...alta, name: e.target.value })}
                />
              )}
            </FormField>
            <FormField
              label="Tipo"
              required
              hint="La naturaleza la impone el tipo: activo y gasto, deudoras."
            >
              {(a) => (
                <SimpleSelect
                  id={a.id}
                  value={alta.kind}
                  onValueChange={(v) => setAlta({ ...alta, kind: v })}
                  options={["activo", "pasivo", "patrimonio", "ingreso", "gasto", "orden"].map(
                    (k) => ({ value: k, label: k }),
                  )}
                />
              )}
            </FormField>
            <FormField label="Cuenta padre">
              {(a) => (
                <SimpleSelect
                  id={a.id}
                  value={alta.parent_id === "" ? null : alta.parent_id}
                  onValueChange={(v) => setAlta({ ...alta, parent_id: v })}
                  placeholder="Sin padre (raíz)"
                  options={d.cuentas.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }))}
                />
              )}
            </FormField>
          </div>
          <Button
            variant="secondary"
            className="mt-3"
            disabled={alta.code.trim() === "" || alta.name.trim() === ""}
            onClick={() => void crear()}
          >
            <Plus /> Crear cuenta
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Papeles contables</CardTitle>
          {sinAsignar.length > 0 && <Badge tone="warning">{sinAsignar.length} sin cuenta</Badge>}
        </CardHeader>
        <CardContent className="px-0 pb-1">
          {sinAsignar.length > 0 && (
            <p role="alert" className="px-4 pb-2 text-[0.85rem] text-warning-soft-foreground">
              Cada papel sin cuenta impide generar el asiento automático que lo usa: el documento
              cae a la cola de pendientes.
            </p>
          )}
          <Table>
            <THead>
              <TR>
                <TH>Papel</TH>
                <TH>Cuenta asignada</TH>
              </TR>
            </THead>
            <TBody>
              {d.papeles.map((p) => (
                <TR key={p.purpose}>
                  <TD title={p.description}>{p.name}</TD>
                  <TD>
                    {p.account_code === null ? (
                      <Badge tone="warning">sin asignar</Badge>
                    ) : (
                      <span className="font-mono text-[0.84rem]">
                        {p.account_code} — {p.account_name ?? ""}
                      </span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={importando !== null}
        onOpenChange={(v) => !v && setImportando(null)}
        title={`Importar «${importando?.name ?? ""}»`}
        confirmLabel="Importar la plantilla"
        onConfirm={() => importar(importando?.code ?? "")}
      >
        Importar COPIA las cuentas a tu plan y las desliga: a partir de ahí son tuyas. La plantilla
        está marcada <strong>VALIDAR-CONTABLE</strong> — no es un plan correcto para ninguna empresa
        concreta hasta que tu contador lo revise.
      </ConfirmDialog>

      <ConfirmDialog
        open={desactivando !== null}
        onOpenChange={(v) => !v && setDesactivando(null)}
        title={`Desactivar ${desactivando?.code ?? ""}`}
        confirmLabel="Desactivar la cuenta"
        onConfirm={() => desactivar(desactivando?.id ?? "")}
      >
        Desactivar no borra el histórico: los asientos anteriores siguen ahí. La cuenta deja de
        aceptar asientos nuevos.
      </ConfirmDialog>
    </div>
  );
}

// ── Diario ──────────────────────────────────────────────────────────────────

function Diario(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [abierto, setAbierto] = useState<string | null>(null);
  const [posteando, setPosteando] = useState<string | null>(null);
  const [reversando, setReversando] = useState<string | null>(null);
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<unknown>(null);

  const asientos = useQuery({
    queryKey: ["diario", empresa.id, status, desde, hasta],
    queryFn: () => {
      const q = new URLSearchParams();
      if (status !== "") q.set("status", status);
      if (desde !== "") q.set("from", desde);
      if (hasta !== "") q.set("to", hasta);
      return llamar<{ items: JournalEntry[]; total: number }>(
        `/v1/journal-entries?${q.toString()}`,
      );
    },
  });
  const recargar = () => void qc.invalidateQueries({ queryKey: ["diario", empresa.id] });

  async function postear(id: string): Promise<void> {
    setError(null);
    try {
      await llamar(`/v1/journal-entries/${id}/post`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id }),
      });
      toast.success("Asiento posteado", "Ya está en el mayor y es inmutable.");
      recargar();
    } catch (e) {
      setError(e);
      throw e;
    }
  }

  async function reversar(id: string): Promise<void> {
    setError(null);
    try {
      await llamar(`/v1/journal-entries/${id}/reverse`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id, reason: motivo.trim() }),
      });
      toast.success("Contra-asiento posteado", "Los dos quedan visibles; el neto es cero.");
      setMotivo("");
      recargar();
    } catch (e) {
      setError(e);
      throw e;
    }
  }

  const columnas = useMemo<ColumnDef<JournalEntry, unknown>[]>(
    () => [
      {
        id: "numero",
        header: "Nº",
        accessorFn: (e) => e.entry_number ?? "—",
        cell: (c) => <span className="font-mono text-[0.84rem]">{String(c.getValue())}</span>,
      },
      { id: "fecha", header: "Fecha", accessorKey: "posting_date" },
      { id: "descripcion", header: "Descripción", accessorKey: "description" },
      { id: "origen", header: "Origen", accessorKey: "source_kind", enableSorting: false },
      {
        id: "estado",
        header: "Estado",
        accessorKey: "status",
        enableSorting: false,
        cell: (c) => {
          const e = ESTADO_ASIENTO[c.getValue<string>()] ?? {
            etiqueta: c.getValue<string>(),
            tone: "outline" as const,
          };
          return <Badge tone={e.tone}>{e.etiqueta}</Badge>;
        },
      },
      {
        id: "debitos",
        header: () => <span className="block text-right">Débitos</span>,
        enableSorting: false,
        accessorKey: "total_debit",
        cell: (c) => (
          <span className="block text-right font-mono text-[0.84rem]">
            {mostrarImporte({ amount: c.getValue<string>(), currency: "VES" })}
          </span>
        ),
      },
      {
        id: "acciones",
        header: "",
        enableSorting: false,
        cell: (c) => {
          const e = c.row.original;
          return (
            <span className="flex justify-end gap-1" onClick={(ev) => ev.stopPropagation()}>
              {e.status === "draft" && (
                <Button variant="outline" size="sm" onClick={() => setPosteando(e.id)}>
                  Postear
                </Button>
              )}
              {e.status === "posted" && (
                <Button variant="ghost" size="sm" onClick={() => setReversando(e.id)}>
                  Reversar
                </Button>
              )}
            </span>
          );
        },
      },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      {error !== null && <MensajeError error={error} />}
      <DataTable
        columns={columnas}
        data={asientos.data?.items}
        error={asientos.error instanceof Error ? asientos.error.message : null}
        onRetry={() => void asientos.refetch()}
        getRowId={(e) => e.id}
        onRowClick={(e) => setAbierto(e.id)}
        density="compact"
        exportCsv={{ filename: `diario-${empresa.tax_id}.csv` }}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-40">
              <SimpleSelect
                ariaLabel="Estado del asiento"
                value={status === "" ? "todos" : status}
                onValueChange={(v) => setStatus(v === "todos" ? "" : v)}
                options={[
                  { value: "todos", label: "Todos" },
                  { value: "draft", label: "Borrador" },
                  { value: "posted", label: "Posteado" },
                  { value: "reversed", label: "Reversado" },
                ]}
              />
            </div>
            <DatePicker value={desde} onChange={setDesde} />
            <span className="text-faint-foreground">–</span>
            <DatePicker value={hasta} onChange={setHasta} />
          </div>
        }
        empty={{
          title: "Sin asientos con esos filtros",
          description: "Los asientos de ventas y compras se generan solos al emitir (ADR-0042).",
        }}
      />

      {abierto !== null && <DetalleAsiento id={abierto} onCerrar={() => setAbierto(null)} />}

      <ConfirmDialog
        open={posteando !== null}
        onOpenChange={(v) => !v && setPosteando(null)}
        title="Postear el asiento"
        confirmLabel="Postear el asiento"
        onConfirm={() => postear(posteando ?? "")}
      >
        Postear hace el asiento <strong>inmutable</strong> y lo lleva al mayor. A partir de ahí solo
        se corrige con un contra-asiento de reversión, y los dos quedan visibles.
      </ConfirmDialog>

      <ConfirmDialog
        open={reversando !== null}
        onOpenChange={(v) => !v && setReversando(null)}
        title="Reversar el asiento"
        confirmLabel="Reversar con contra-asiento"
        destructive
        onConfirm={() => reversar(reversando ?? "")}
      >
        <div className="space-y-2">
          <p>
            Se postea un contra-asiento espejo. El original NO desaparece: los dos quedan visibles y
            el neto por cuenta es cero.
          </p>
          <Textarea
            aria-label="Motivo de la reversión"
            placeholder="Motivo (obligatorio, queda en auditoría)…"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
          />
        </div>
      </ConfirmDialog>
    </div>
  );
}

function DetalleAsiento({ id, onCerrar }: { id: string; onCerrar: () => void }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const detalle = useQuery({
    queryKey: ["asiento", empresa.id, id],
    queryFn: () => llamar<JournalEntryDetail>(`/v1/journal-entries/${id}`),
  });
  const d = detalle.data;
  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-3xl">
        {d === undefined ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            <DialogTitle>
              Asiento {d.entry.entry_number ?? "(borrador)"} — {d.entry.description}
            </DialogTitle>
            <DialogDescription>
              {d.entry.posting_date}
              {d.entry.is_reversal_of !== null && " · es la reversión de otro asiento"}
              {d.entry.reversed_by_entry_id !== null && " · reversado por otro asiento"}
              {d.entry.source_id !== null &&
                ` · origen: ${d.entry.source_kind} (${d.entry.source_event ?? ""})`}
            </DialogDescription>
            <div className="mt-3">
              <Table>
                <THead>
                  <TR>
                    <TH>#</TH>
                    <TH>Cuenta</TH>
                    <TH className="text-right">Débito</TH>
                    <TH className="text-right">Crédito</TH>
                    <TH>Dimensiones</TH>
                  </TR>
                </THead>
                <TBody>
                  {d.lines.map((l) => (
                    <TR key={l.id}>
                      <TD className="text-faint-foreground">{l.line_number}</TD>
                      <TD>
                        <span className="font-mono text-[0.84rem]">{l.account_code}</span>{" "}
                        {l.account_name}
                      </TD>
                      <TDNum>
                        {l.functional_debit === "0.00000000"
                          ? ""
                          : mostrarImporte({
                              amount: l.functional_debit,
                              currency: l.functional_currency,
                            })}
                      </TDNum>
                      <TDNum>
                        {l.functional_credit === "0.00000000"
                          ? ""
                          : mostrarImporte({
                              amount: l.functional_credit,
                              currency: l.functional_currency,
                            })}
                      </TDNum>
                      <TD className="text-[0.8rem] text-muted-foreground">
                        {l.analytical_dimensions === null
                          ? ""
                          : Object.entries(l.analytical_dimensions)
                              .map(([k, v]) => `${k}=${String(v)}`)
                              .join(", ")}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              {/* Totales DEL SERVIDOR: sumar aquí sería una segunda contabilidad. */}
              <p className="mt-2 text-right text-[0.9rem]">
                Débitos{" "}
                <span className="font-mono font-medium">
                  {mostrarImporte({ amount: d.entry.total_debit, currency: "VES" })}
                </span>{" "}
                · Créditos{" "}
                <span className="font-mono font-medium">
                  {mostrarImporte({ amount: d.entry.total_credit, currency: "VES" })}
                </span>
              </p>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Asiento manual ──────────────────────────────────────────────────────────

interface LineaBorrador {
  clave: string;
  account_id: string;
  side: "debit" | "credit";
  amount: string;
  description: string;
}

function AsientoManual(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [fecha, setFecha] = useState(HOY());
  const [descripcion, setDescripcion] = useState("");
  const [lineas, setLineas] = useState<LineaBorrador[]>([
    { clave: crypto.randomUUID(), account_id: "", side: "debit", amount: "", description: "" },
    { clave: crypto.randomUUID(), account_id: "", side: "credit", amount: "", description: "" },
  ]);
  const [error, setError] = useState<unknown>(null);

  const cuentas = useQuery({
    queryKey: ["cuentas-hoja", empresa.id],
    queryFn: () => llamar<Account[]>("/v1/accounts?leaves_only=true"),
  });

  /**
   * EL único cálculo del cliente en todo el módulo, y es legítimo por las tres
   * condiciones documentadas en apps/web/CLAUDE.md: no persiste nada, no
   * decide nada (el trigger del servidor rechaza igual) y compara ENTEROS de
   * céntimos para no arrastrar coma flotante en la comparación.
   */
  const centimos = (s: string): number => {
    const n = Number.parseFloat(s.trim() === "" ? "0" : s);
    return Number.isFinite(n) ? Math.round(n * 100) : Number.NaN;
  };
  const debitos = lineas
    .filter((l) => l.side === "debit")
    .reduce((acc, l) => acc + centimos(l.amount), 0);
  const creditos = lineas
    .filter((l) => l.side === "credit")
    .reduce((acc, l) => acc + centimos(l.amount), 0);
  const cuadra =
    Number.isFinite(debitos) && Number.isFinite(creditos) && debitos === creditos && debitos > 0;
  const completo =
    lineas.every((l) => l.account_id !== "" && l.amount.trim() !== "") &&
    descripcion.trim().length >= 3;

  async function guardar(): Promise<void> {
    setError(null);
    try {
      const r = await llamar<JournalEntry>("/v1/journal-entries", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          posting_date: fecha,
          description: descripcion.trim(),
          lines: lineas.map((l) => ({
            account_id: l.account_id,
            ...(l.side === "debit" ? { debit: l.amount } : { credit: l.amount }),
            ...(l.description === "" ? {} : { description: l.description }),
          })),
        }),
      });
      toast.success("Borrador creado", `Asiento ${r.id.slice(0, 8)} — postéalo desde el diario.`);
      setDescripcion("");
      setLineas([
        { clave: crypto.randomUUID(), account_id: "", side: "debit", amount: "", description: "" },
        { clave: crypto.randomUUID(), account_id: "", side: "credit", amount: "", description: "" },
      ]);
    } catch (e) {
      setError(e);
    }
  }

  const opciones = (cuentas.data ?? []).map((a) => ({
    value: a.id,
    label: `${a.code} — ${a.name}`,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Asiento manual</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <CardDescription>
          Se crea en <strong>borrador</strong>. Postear es un acto aparte, con su propio permiso,
          porque es el que lo hace inmutable.
        </CardDescription>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FormField label="Fecha" required>
            {(a) => <DatePicker id={a.id} value={fecha} onChange={setFecha} />}
          </FormField>
          <FormField label="Descripción" required className="sm:col-span-2">
            {(a) => (
              <Input
                id={a.id}
                placeholder="Qué documenta este asiento"
                value={descripcion}
                onChange={(e) => setDescripcion(e.target.value)}
              />
            )}
          </FormField>
        </div>

        <div className="space-y-2">
          {lineas.map((l, i) => (
            <div key={l.clave} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <SimpleSelect
                  ariaLabel="Cuenta"
                  value={l.account_id === "" ? null : l.account_id}
                  onValueChange={(v) =>
                    setLineas((ls) => ls.map((x, j) => (j === i ? { ...x, account_id: v } : x)))
                  }
                  placeholder="Cuenta…"
                  options={opciones}
                />
              </div>
              <div className="w-28">
                <SimpleSelect
                  ariaLabel="Lado"
                  value={l.side}
                  onValueChange={(v) =>
                    setLineas((ls) =>
                      ls.map((x, j) => (j === i ? { ...x, side: v as "debit" | "credit" } : x)),
                    )
                  }
                  options={[
                    { value: "debit", label: "Débito" },
                    { value: "credit", label: "Crédito" },
                  ]}
                />
              </div>
              <Input
                aria-label="Importe"
                inputMode="decimal"
                placeholder="0.00"
                className="w-28 text-right font-mono"
                value={l.amount}
                onChange={(e) =>
                  setLineas((ls) =>
                    ls.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                  )
                }
              />
              <Input
                aria-label="Detalle de la línea"
                placeholder="Detalle (op.)"
                className="w-40"
                value={l.description}
                onChange={(e) =>
                  setLineas((ls) =>
                    ls.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)),
                  )
                }
              />
              <Button
                variant="ghost"
                size="iconSm"
                aria-label="Quitar línea"
                disabled={lineas.length <= 2}
                onClick={() => setLineas((ls) => ls.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setLineas((ls) => [
                ...ls,
                {
                  clave: crypto.randomUUID(),
                  account_id: "",
                  side: "debit",
                  amount: "",
                  description: "",
                },
              ])
            }
          >
            <Plus /> Añadir línea
          </Button>
        </div>

        <p role="status" className="text-[0.88rem]">
          {cuadra ? (
            <span className="font-medium text-accent-soft-foreground">Cuadra.</span>
          ) : (
            <span className="font-medium text-warning-soft-foreground">
              No cuadra todavía: débitos {(debitos / 100).toFixed(2)} contra créditos{" "}
              {(creditos / 100).toFixed(2)}.
            </span>
          )}{" "}
          <span className="text-[0.8rem] text-faint-foreground">
            Ayuda para escribir, no la que manda: el servidor la repite con un trigger y rechaza
            igual.
          </span>
        </p>

        {error !== null && <MensajeError error={error} />}

        <Button variant="primary" disabled={!cuadra || !completo} onClick={() => void guardar()}>
          Guardar borrador
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Mayor ───────────────────────────────────────────────────────────────────

function Mayor(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const [cuentaId, setCuentaId] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState(HOY());
  const [consulta, setConsulta] = useState<{ cuenta: string; desde: string; hasta: string } | null>(
    null,
  );

  const cuentas = useQuery({
    queryKey: ["cuentas-hoja", empresa.id],
    queryFn: () => llamar<Account[]>("/v1/accounts?leaves_only=true"),
  });

  const mayor = useQuery({
    queryKey: ["mayor", empresa.id, consulta],
    enabled: consulta !== null,
    queryFn: () => {
      const q = new URLSearchParams({ account: consulta?.cuenta ?? "", to: consulta?.hasta ?? "" });
      if (consulta?.desde !== "") q.set("from", consulta?.desde ?? "");
      return llamar<LedgerView>(`/v1/ledger?${q.toString()}`);
    },
  });

  const m = mayor.data;

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">
          <div className="w-72">
            <SimpleSelect
              ariaLabel="Cuenta"
              value={cuentaId === "" ? null : cuentaId}
              onValueChange={setCuentaId}
              placeholder="Elige cuenta…"
              options={(cuentas.data ?? []).map((a) => ({
                value: a.id,
                label: `${a.code} — ${a.name}`,
              }))}
            />
          </div>
          <DatePicker value={desde} onChange={setDesde} />
          <span className="text-faint-foreground">–</span>
          <DatePicker value={hasta} onChange={setHasta} />
          <Button
            variant="primary"
            disabled={cuentaId === ""}
            onClick={() => setConsulta({ cuenta: cuentaId, desde, hasta })}
          >
            <BookOpenCheck /> Consultar
          </Button>
        </CardContent>
      </Card>

      {m !== undefined && (
        <Card>
          <CardHeader>
            <CardTitle>
              <span className="font-mono">{m.account_code}</span> — {m.account_name} ({m.nature})
            </CardTitle>
            <span className="text-[0.85rem] text-muted-foreground">
              inicial{" "}
              <span className="font-mono">
                {mostrarImporte({ amount: m.opening_balance, currency: m.currency })}
              </span>{" "}
              · final{" "}
              <span className="font-mono font-medium">
                {mostrarImporte({ amount: m.closing_balance, currency: m.currency })}
              </span>
            </span>
          </CardHeader>
          <CardContent className="px-0 pb-1">
            <Table>
              <THead>
                <TR>
                  <TH>Fecha</TH>
                  <TH>Nº</TH>
                  <TH>Descripción</TH>
                  <TH className="text-right">Débito</TH>
                  <TH className="text-right">Crédito</TH>
                  <TH>Origen</TH>
                </TR>
              </THead>
              <TBody>
                {m.movements.map((mov, i) => (
                  <TR key={`${mov.entry_id}-${i}`}>
                    <TD>{mov.posting_date}</TD>
                    <TD className="font-mono text-[0.84rem]">{mov.entry_number ?? "—"}</TD>
                    <TD className="max-w-72 truncate whitespace-normal">{mov.description}</TD>
                    <TDNum>
                      {mov.debit === "0.00000000"
                        ? ""
                        : mostrarImporte({ amount: mov.debit, currency: m.currency })}
                    </TDNum>
                    <TDNum>
                      {mov.credit === "0.00000000"
                        ? ""
                        : mostrarImporte({ amount: mov.credit, currency: m.currency })}
                    </TDNum>
                    <TD className="text-[0.82rem] text-muted-foreground">{mov.source_kind}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Balance de comprobación ─────────────────────────────────────────────────

function Comprobacion(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const [fecha, setFecha] = useState(HOY());
  const [desde, setDesde] = useState("");
  const [consulta, setConsulta] = useState<{ fecha: string; desde: string } | null>(null);

  const balance = useQuery({
    queryKey: ["comprobacion", empresa.id, consulta],
    enabled: consulta !== null,
    queryFn: () => {
      const q = new URLSearchParams({ date: consulta?.fecha ?? "" });
      if (consulta?.desde !== "") q.set("from", consulta?.desde ?? "");
      return llamar<TrialBalance>(`/v1/trial-balance?${q.toString()}`);
    },
  });

  const b = balance.data;

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">
          <DatePicker value={desde} onChange={setDesde} />
          <span className="text-faint-foreground">–</span>
          <DatePicker value={fecha} onChange={setFecha} />
          <Button variant="primary" onClick={() => setConsulta({ fecha, desde })}>
            Generar
          </Button>
        </CardContent>
      </Card>

      {b !== undefined && (
        <>
          {!b.balanced && (
            <p
              role="alert"
              className="rounded-md border border-destructive bg-destructive-soft px-3 py-2 text-[0.9rem] text-destructive-soft-foreground"
            >
              El balance NO cuadra: débitos {b.total_debit} contra créditos {b.total_credit}. Eso es
              un asiento roto en la base, no un error de esta pantalla.
            </p>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Balance de comprobación</CardTitle>
              <Badge tone={b.balanced ? "accent" : "destructive"}>
                {b.balanced ? "Cuadra" : "NO cuadra"}
              </Badge>
            </CardHeader>
            <CardContent className="px-0 pb-1">
              <Table>
                <THead>
                  <TR>
                    <TH>Código</TH>
                    <TH>Cuenta</TH>
                    <TH className="text-right">Saldo inicial</TH>
                    <TH className="text-right">Débitos</TH>
                    <TH className="text-right">Créditos</TH>
                    <TH className="text-right">Saldo final</TH>
                  </TR>
                </THead>
                <TBody>
                  {b.rows.map((r) => (
                    <TR key={r.account_id}>
                      <TD className="font-mono text-[0.84rem]">{r.account_code}</TD>
                      <TD>{r.account_name}</TD>
                      <TDNum>
                        {mostrarImporte({ amount: r.opening_balance, currency: b.currency })}
                      </TDNum>
                      <TDNum>
                        {mostrarImporte({ amount: r.period_debit, currency: b.currency })}
                      </TDNum>
                      <TDNum>
                        {mostrarImporte({ amount: r.period_credit, currency: b.currency })}
                      </TDNum>
                      <TDNum>
                        {mostrarImporte({ amount: r.closing_balance, currency: b.currency })}
                      </TDNum>
                    </TR>
                  ))}
                  <TR className="bg-surface-muted/60 font-medium">
                    <TD colSpan={3}>Totales</TD>
                    <TDNum>{mostrarImporte({ amount: b.total_debit, currency: b.currency })}</TDNum>
                    <TDNum>
                      {mostrarImporte({ amount: b.total_credit, currency: b.currency })}
                    </TDNum>
                    <TD />
                  </TR>
                </TBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ── Cierre ──────────────────────────────────────────────────────────────────

function Cierre(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  const [anio, setAnio] = useState(String(new Date().getFullYear()));
  const [cerrando, setCerrando] = useState<FiscalPeriod | null>(null);
  const [reabriendo, setReabriendo] = useState<FiscalPeriod | null>(null);
  const [motivo, setMotivo] = useState("");
  const [cierreAnualAbierto, setCierreAnualAbierto] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const datos = useQuery({
    queryKey: ["cierre", empresa.id],
    queryFn: async () => {
      const [periodos, pendientes] = await Promise.all([
        llamar<FiscalPeriod[]>("/v1/fiscal-periods"),
        llamar<PendingJournal>("/v1/accounting/pending"),
      ]);
      return { periodos, pendientes };
    },
  });
  const recargar = () => void qc.invalidateQueries({ queryKey: ["cierre", empresa.id] });

  async function cerrar(id: string): Promise<void> {
    setError(null);
    try {
      await llamar(`/v1/fiscal-periods/${id}/close`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id }),
      });
      toast.success("Período cerrado");
      recargar();
    } catch (e) {
      setError(e);
      throw e;
    }
  }

  async function reabrir(id: string): Promise<void> {
    setError(null);
    try {
      await llamar(`/v1/fiscal-periods/${id}/reopen`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id, reason: motivo.trim() }),
      });
      toast.success("Período reabierto", "Con su motivo registrado.");
      setMotivo("");
      recargar();
    } catch (e) {
      setError(e);
      throw e;
    }
  }

  async function cierreAnual(): Promise<void> {
    setError(null);
    try {
      const r = await llamar<JournalEntry>("/v1/fiscal-periods/year-end-close", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id, year: Number.parseInt(anio, 10) }),
      });
      toast.success("Cierre anual posteado", `Asiento ${r.entry_number ?? ""}`);
      recargar();
    } catch (e) {
      setError(e);
      throw e;
    }
  }

  const d = datos.data;
  const pendientes = d?.pendientes.total ?? 0;

  return (
    <div className="space-y-4">
      {pendientes > 0 && (
        <p
          role="alert"
          className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-[0.9rem] text-warning-soft-foreground"
        >
          Hay <strong>{pendientes}</strong> documento(s) pendientes de contabilizar. Ningún período
          se cierra mientras queden: sería contabilidad que falta y que ya nadie podrá asentar en su
          fecha (ADR-0042).
        </p>
      )}
      {error !== null && <MensajeError error={error} />}

      {d === undefined ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Períodos</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-1">
            <Table>
              <THead>
                <TR>
                  <TH>Período</TH>
                  <TH>Estado</TH>
                  <TH className="text-right">Borradores</TH>
                  <TH>Motivo de reapertura</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {d.periodos.map((p) => (
                  <TR key={p.id}>
                    <TD className="font-mono text-[0.84rem]">
                      {p.year}-{String(p.month).padStart(2, "0")}
                    </TD>
                    <TD>
                      <Badge
                        tone={
                          p.status === "closed"
                            ? "neutral"
                            : p.status === "reopened"
                              ? "warning"
                              : "accent"
                        }
                      >
                        {p.status === "closed"
                          ? "Cerrado"
                          : p.status === "reopened"
                            ? "Reabierto"
                            : "Abierto"}
                      </Badge>
                    </TD>
                    <TDNum>{p.draft_entry_count}</TDNum>
                    <TD className="max-w-56 truncate text-[0.82rem] text-muted-foreground">
                      {p.reopened_reason ?? ""}
                    </TD>
                    <TD>
                      {p.status !== "closed" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={p.draft_entry_count > 0 || pendientes > 0}
                          onClick={() => setCerrando(p)}
                        >
                          <CalendarX2 /> Cerrar
                        </Button>
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => setReabriendo(p)}>
                          Reabrir
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {d !== undefined && d.pendientes.items.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Pendientes de contabilizar</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-[0.85rem] text-muted-foreground">
              {d.pendientes.items.map((i) => (
                <li key={i.id}>
                  {i.source_kind} · {i.source_event} · {i.reason}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Cierre anual</CardTitle>
        </CardHeader>
        <CardContent className="flex items-end gap-3">
          <FormField label="Ejercicio">
            {(a) => (
              <Input
                id={a.id}
                inputMode="numeric"
                className="w-24 text-center font-mono"
                value={anio}
                onChange={(e) => setAnio(e.target.value.replace(/\D/g, ""))}
              />
            )}
          </FormField>
          <Button variant="secondary" onClick={() => setCierreAnualAbierto(true)}>
            Ejecutar cierre de ejercicio…
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={cerrando !== null}
        onOpenChange={(v) => !v && setCerrando(null)}
        title={`Cerrar ${cerrando?.year ?? ""}-${String(cerrando?.month ?? "").padStart(2, "0")}`}
        confirmLabel="Cerrar el período"
        onConfirm={() => cerrar(cerrando?.id ?? "")}
      >
        Cerrar impide cualquier asiento con fecha en ese mes — y desde ADR-0044, también{" "}
        <strong>emitir documentos fechados en él</strong>. Reabrir exige permiso propio y un motivo
        escrito que queda en auditoría.
      </ConfirmDialog>

      <ConfirmDialog
        open={reabriendo !== null}
        onOpenChange={(v) => !v && setReabriendo(null)}
        title={`Reabrir ${reabriendo?.year ?? ""}-${String(reabriendo?.month ?? "").padStart(2, "0")}`}
        confirmLabel="Reabrir el período"
        destructive
        onConfirm={() => reabrir(reabriendo?.id ?? "")}
      >
        <div className="space-y-2">
          <p>
            La reapertura queda registrada en el período y en la auditoría — es exactamente lo que
            una fiscalización pregunta.
          </p>
          <Textarea
            aria-label="Motivo de la reapertura"
            placeholder="Motivo (mínimo 10 caracteres)…"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
          />
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={cierreAnualAbierto}
        onOpenChange={setCierreAnualAbierto}
        title={`Cierre del ejercicio ${anio}`}
        confirmLabel="Ejecutar el cierre"
        onConfirm={cierreAnual}
      >
        Lleva ingresos y gastos a <strong>Resultado del ejercicio</strong> y el resultado a{" "}
        <strong>Utilidades acumuladas</strong>, con un asiento POSTEADO. Exige esas dos cuentas
        configuradas en los papeles contables.
      </ConfirmDialog>
    </div>
  );
}

// ── Estados financieros ─────────────────────────────────────────────────────

function Estados(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const [desde, setDesde] = useState(`${new Date().getFullYear()}-01-01`);
  const [hasta, setHasta] = useState(HOY());
  const [consulta, setConsulta] = useState<{ desde: string; hasta: string } | null>(null);

  const estados = useQuery({
    queryKey: ["estados", empresa.id, consulta],
    enabled: consulta !== null,
    queryFn: async () => {
      const [resultados, situacion] = await Promise.all([
        llamar<IncomeStatement>(
          `/v1/accounting/reports/income-statement?from=${consulta?.desde}&to=${consulta?.hasta}`,
        ),
        llamar<BalanceSheet>(`/v1/accounting/reports/balance-sheet?date=${consulta?.hasta}`),
      ]);
      return { resultados, situacion };
    },
  });

  const d = estados.data;
  const filaImporte = (
    filas: { account_code: string; account_name: string; amount: string }[],
    currency: string,
  ) =>
    filas.map((f) => (
      <TR key={f.account_code}>
        <TD className="font-mono text-[0.84rem]">{f.account_code}</TD>
        <TD>{f.account_name}</TD>
        <TDNum>{mostrarImporte({ amount: f.amount, currency })}</TDNum>
      </TR>
    ));

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">
          <DatePicker value={desde} onChange={setDesde} />
          <span className="text-faint-foreground">–</span>
          <DatePicker value={hasta} onChange={setHasta} />
          <Button variant="primary" onClick={() => setConsulta({ desde, hasta })}>
            Generar
          </Button>
        </CardContent>
      </Card>

      {d !== undefined && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>
                Estado de resultados · {d.resultados.from_date} → {d.resultados.to_date}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-1">
              <Table>
                <TBody>
                  {filaImporte(d.resultados.income, d.resultados.currency)}
                  <TR className="bg-surface-muted/60 font-medium">
                    <TD colSpan={2}>Total ingresos</TD>
                    <TDNum>
                      {mostrarImporte({
                        amount: d.resultados.total_income,
                        currency: d.resultados.currency,
                      })}
                    </TDNum>
                  </TR>
                  {filaImporte(d.resultados.expenses, d.resultados.currency)}
                  <TR className="bg-surface-muted/60 font-medium">
                    <TD colSpan={2}>Total gastos</TD>
                    <TDNum>
                      {mostrarImporte({
                        amount: d.resultados.total_expenses,
                        currency: d.resultados.currency,
                      })}
                    </TDNum>
                  </TR>
                  <TR className="bg-accent-soft/50 font-semibold">
                    <TD colSpan={2}>Resultado</TD>
                    <TDNum>
                      {mostrarImporte({
                        amount: d.resultados.result,
                        currency: d.resultados.currency,
                      })}
                    </TDNum>
                  </TR>
                </TBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Balance general al {d.situacion.as_of}</CardTitle>
              {!d.situacion.balanced && <Badge tone="destructive">NO cuadra</Badge>}
            </CardHeader>
            <CardContent className="px-0 pb-1">
              {!d.situacion.balanced && (
                <p
                  role="alert"
                  className="px-4 pb-2 text-[0.85rem] text-destructive-soft-foreground"
                >
                  Activo ≠ pasivo + patrimonio: hay un asiento roto en la base, no un problema de
                  esta pantalla.
                </p>
              )}
              <Table>
                <TBody>
                  <TR className="bg-surface-muted/60 font-medium">
                    <TD colSpan={3}>Activo</TD>
                  </TR>
                  {filaImporte(d.situacion.assets, d.situacion.currency)}
                  <TR className="font-medium">
                    <TD colSpan={2}>Total activo</TD>
                    <TDNum>
                      {mostrarImporte({
                        amount: d.situacion.total_assets,
                        currency: d.situacion.currency,
                      })}
                    </TDNum>
                  </TR>
                  <TR className="bg-surface-muted/60 font-medium">
                    <TD colSpan={3}>Pasivo</TD>
                  </TR>
                  {filaImporte(d.situacion.liabilities, d.situacion.currency)}
                  <TR className="bg-surface-muted/60 font-medium">
                    <TD colSpan={3}>Patrimonio</TD>
                  </TR>
                  {filaImporte(d.situacion.equity, d.situacion.currency)}
                  <TR className="font-medium">
                    <TD colSpan={2}>Pasivo + patrimonio</TD>
                    <TDNum>
                      {mostrarImporte({
                        amount: d.situacion.total_liabilities,
                        currency: d.situacion.currency,
                      })}{" "}
                      +{" "}
                      {mostrarImporte({
                        amount: d.situacion.total_equity,
                        currency: d.situacion.currency,
                      })}
                    </TDNum>
                  </TR>
                </TBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

/**
 * COBERTURA CONTABLE (Nivel C de la auditoría de superficie): la pregunta del
 * invariante de ADR-0042 — ¿todo documento posteado tiene su asiento o su
 * fila en cola? — respondida en pantalla. La respuesta buena es CERO.
 */
function CoberturaContable(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const q = useQuery({
    queryKey: ["cobertura", empresa.id],
    queryFn: () =>
      llamar<{ items: { source_kind: string; source_id: string; problem: string }[] }>(
        "/v1/accounting/coverage-gaps",
      ),
  });
  const items = q.data?.items ?? [];
  return (
    <Card className={items.length > 0 ? "border-warning-soft" : undefined}>
      <CardHeader>
        <CardTitle>Cobertura contable</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <CardDescription>
            Cero huecos: todo documento posteado tiene su asiento o su fila en cola. Es el número
            que este panel existe para vigilar.
          </CardDescription>
        ) : (
          <>
            <CardDescription className="mb-2 text-warning-soft-foreground">
              {String(items.length)} documento(s) SIN asiento NI cola — esto nunca debería ser mayor
              que cero: avisa.
            </CardDescription>
            <ul className="space-y-1 font-mono text-[0.82rem]">
              {items.map((i) => (
                <li key={i.source_id}>
                  {i.source_kind} · {i.source_id} · {i.problem}
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
