import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Banknote, Lock, LockOpen, MessageCircle, Pencil, UserPlus } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DataTable } from "../../components/DataTable.js";
import { FormField, MoneyInput, importeValido } from "../../components/forms.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { Button } from "../../ui/button.js";
import { Input } from "../../ui/input.js";
import { SimpleSelect } from "../../ui/select.js";
import { Badge, type BadgeTone } from "../../ui/badge.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../ui/dialog.js";
import { useToast } from "../../ui/toast.js";
import { MensajeError } from "../ventas/comunes.js";
import { fechaRelativa } from "../negocio/comunes.js";
import { mostrarImporte } from "../../money.js";
import { compararImportes, esCero } from "../../components/decimal-compare.js";
import { errorDePersona } from "../../lib.js";
import type { Customer, CodeCatalog, PriceList } from "../../lib.js";

/** La fila con la deuda funcional de HOY que calcula el servidor (ADR-0047). */
type ClienteConDeuda = Customer & { readonly debt?: string };

/** Las facturas emitidas con saldo, tal como las devuelve el estado de cuenta. */
interface DocumentoAbierto {
  id: string;
  series: string;
  document_number: number | null;
  issued_at: string | null;
  total_amount: string;
  balance: string;
  status: string;
}
interface EstadoDeCuenta {
  currency: string;
  documents: DocumentoAbierto[];
  total_outstanding: string;
}
interface FormaDePago {
  id: string;
  name: string;
  kind: string;
  account_id: string;
  is_active: boolean;
}

/**
 * Clientes — Fase B sobre el patrón de ventas. Toda la funcionalidad de la
 * pantalla anterior, con el sistema: búsqueda y paginación DEL SERVIDOR,
 * alta/edición en diálogo, y las dos operaciones con permiso PROPIO —cambiar
 * el RIF (queda auditado con el valor anterior) y el bloqueo de cobranzas—
 * separadas de la edición normal, como en el dominio.
 */
const ESTADO: Record<string, { etiqueta: string; tone: BadgeTone }> = {
  lead: { etiqueta: "Prospecto", tone: "info" },
  active: { etiqueta: "Activo", tone: "accent" },
  inactive: { etiqueta: "Inactivo", tone: "neutral" },
  blocked: { etiqueta: "Bloqueado", tone: "destructive" },
};

const PER_PAGE = 25;

export function Clientes(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const [busqueda, setBusqueda] = useState("");
  const [pagina, setPagina] = useState(1);
  const [creando, setCreando] = useState(false);
  const [detalle, setDetalle] = useState<Customer | null>(null);
  const qc = useQueryClient();

  const clientes = useQuery({
    queryKey: ["clientes", empresa.id, busqueda, pagina],
    queryFn: () => {
      const q = new URLSearchParams({
        page: String(pagina),
        per_page: String(PER_PAGE),
        with_debt: "1",
      });
      if (busqueda.trim() !== "") q.set("search", busqueda.trim());
      return llamar<{ items: ClienteConDeuda[]; total: number }>(`/v1/customers?${q.toString()}`);
    },
  });

  const recargar = () => void qc.invalidateQueries({ queryKey: ["clientes", empresa.id] });

  const columnas = useMemo<ColumnDef<ClienteConDeuda, unknown>[]>(
    () => [
      {
        id: "rif",
        header: "RIF",
        accessorFn: (c) => c.tax_id ?? "—",
        cell: (c) => <span className="font-mono text-[0.84rem]">{c.getValue<string>()}</span>,
      },
      { id: "nombre", header: "Razón social", accessorKey: "legal_name" },
      {
        id: "persona",
        header: "Persona",
        accessorKey: "person_type_code",
        enableSorting: false,
      },
      {
        id: "fiscal",
        header: "Clasif. fiscal",
        accessorKey: "taxpayer_type_code",
        enableSorting: false,
      },
      {
        id: "estado",
        header: "Estado",
        accessorKey: "status",
        enableSorting: false,
        cell: (c) => {
          const e = ESTADO[c.getValue<string>()] ?? {
            etiqueta: c.getValue<string>(),
            tone: "outline" as const,
          };
          return <Badge tone={e.tone}>{e.etiqueta}</Badge>;
        },
      },
      {
        id: "deuda",
        header: "Deuda",
        enableSorting: false,
        // La misma deuda que ve el mostrador: funcional de HOY, del servidor.
        accessorFn: (c) => c.debt,
        cell: (c) => {
          const debt = c.getValue<string | undefined>();
          if (debt === undefined || esCero(debt)) {
            return <span className="text-[0.82rem] text-muted-foreground">Al día</span>;
          }
          return (
            <span className="font-mono text-[0.84rem] text-warning-soft-foreground">
              {mostrarImporte({ amount: debt, currency: "VES" })}
            </span>
          );
        },
      },
      {
        id: "cuenta",
        header: "",
        enableSorting: false,
        cell: (c) => (
          <Link
            to={`/admin/cuentas?cliente=${c.row.original.id}`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 text-[0.82rem] text-accent-soft-foreground hover:underline"
          >
            <Banknote className="size-3.5" /> Cuenta
          </Link>
        ),
      },
    ],
    [],
  );

  return (
    <div>
      <PageHeader
        title="Clientes"
        description="El maestro de contrapartes de venta: RIF, clasificación fiscal y bloqueo de cobranzas."
        actions={
          <Button variant="primary" onClick={() => setCreando(true)}>
            <UserPlus /> Nuevo cliente
          </Button>
        }
      />
      <DataTable
        columns={columnas}
        data={clientes.data?.items}
        error={clientes.error instanceof Error ? clientes.error.message : null}
        onRetry={() => void clientes.refetch()}
        getRowId={(c) => c.id}
        onRowClick={setDetalle}
        search={{
          value: busqueda,
          onChange: (v) => {
            setBusqueda(v);
            setPagina(1);
          },
          placeholder: "Buscar por RIF o razón social…",
        }}
        pagination={{
          total: clientes.data?.total ?? 0,
          page: pagina,
          perPage: PER_PAGE,
          onPageChange: setPagina,
        }}
        exportCsv={{ filename: `clientes-${empresa.tax_id}.csv` }}
        empty={{
          title: busqueda === "" ? "Todavía no hay clientes" : "Nada con esa búsqueda",
          description:
            busqueda === ""
              ? "El primer cliente habilita las ventas: la factura exige contraparte."
              : "La búsqueda es del servidor: prueba con parte del RIF o del nombre.",
          action:
            busqueda === "" ? (
              <Button variant="primary" size="sm" onClick={() => setCreando(true)}>
                Crear el primero
              </Button>
            ) : undefined,
        }}
      />

      {creando && <NuevoCliente onCerrar={(hecho) => (setCreando(false), hecho && recargar())} />}
      {detalle !== null && (
        <DetalleCliente
          cliente={detalle}
          onCerrar={(hecho) => (setDetalle(null), hecho && recargar())}
        />
      )}
    </div>
  );
}

function NuevoCliente({ onCerrar }: { onCerrar: (hecho: boolean) => void }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [form, setForm] = useState({
    tax_id: "",
    legal_name: "",
    person_type_code: "juridica",
    taxpayer_type_code: "ordinario",
    fiscal_address: "",
    email: "",
    phone: "",
    default_price_list_id: "",
  });
  const [error, setError] = useState<unknown>(null);
  const [guardando, setGuardando] = useState(false);

  const catalogos = useQuery({
    queryKey: ["catalogos-cliente", empresa.id],
    staleTime: 300_000,
    queryFn: async () => {
      const [personas, fiscales, listas] = await Promise.all([
        llamar<CodeCatalog[]>("/v1/person-types"),
        llamar<CodeCatalog[]>("/v1/taxpayer-types"),
        llamar<PriceList[]>("/v1/price-lists").catch(() => [] as PriceList[]),
      ]);
      return { personas, fiscales, listas };
    },
  });

  async function guardar(): Promise<void> {
    setError(null);
    setGuardando(true);
    const opcional = (v: string) => (v.trim() === "" ? undefined : v.trim());
    try {
      await llamar("/v1/customers", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          tax_id: form.tax_id.trim() === "" ? null : form.tax_id.trim(),
          legal_name: form.legal_name,
          person_type_code: form.person_type_code,
          taxpayer_type_code: form.taxpayer_type_code,
          fiscal_address: opcional(form.fiscal_address),
          email: opcional(form.email),
          phone: opcional(form.phone),
          default_price_list_id: opcional(form.default_price_list_id),
        }),
      });
      toast.success("Cliente creado", form.legal_name);
      onCerrar(true);
    } catch (e) {
      setError(e);
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar(false)}>
      <DialogContent className="max-w-xl">
        <DialogTitle>Nuevo cliente</DialogTitle>
        <DialogDescription>
          El RIF puede quedar vacío SOLO para persona natural; la clasificación fiscal la confirma
          el contador (VALIDAR-TRIBUTARIO).
        </DialogDescription>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="RIF" hint="Vacío solo para persona natural.">
            {(a) => (
              <Input
                id={a.id}
                className="font-mono"
                value={form.tax_id}
                onChange={(e) => setForm({ ...form, tax_id: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="Razón social / nombre" required>
            {(a) => (
              <Input
                id={a.id}
                value={form.legal_name}
                onChange={(e) => setForm({ ...form, legal_name: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="Tipo de persona" required>
            {(a) => (
              <SimpleSelect
                id={a.id}
                value={form.person_type_code}
                onValueChange={(v) => setForm({ ...form, person_type_code: v })}
                options={(catalogos.data?.personas ?? []).map((p) => ({
                  value: p.code,
                  label: p.name,
                }))}
              />
            )}
          </FormField>
          <FormField label="Clasificación fiscal" required>
            {(a) => (
              <SimpleSelect
                id={a.id}
                value={form.taxpayer_type_code}
                onValueChange={(v) => setForm({ ...form, taxpayer_type_code: v })}
                options={(catalogos.data?.fiscales ?? []).map((t) => ({
                  value: t.code,
                  label: t.name,
                }))}
              />
            )}
          </FormField>
          <FormField label="Lista de precios preferida">
            {(a) => (
              <SimpleSelect
                id={a.id}
                value={form.default_price_list_id === "" ? null : form.default_price_list_id}
                onValueChange={(v) => setForm({ ...form, default_price_list_id: v })}
                placeholder="Sin preferida"
                options={(catalogos.data?.listas ?? []).map((l) => ({
                  value: l.id,
                  label: `${l.name} (${l.currency_code})`,
                }))}
              />
            )}
          </FormField>
          <FormField
            label="Dirección fiscal"
            {...(form.person_type_code === "juridica" || form.person_type_code === "gobierno"
              ? { required: true, hint: "Obligatoria para jurídica y ente público (migración 33)." }
              : {})}
          >
            {(a) => (
              <Input
                id={a.id}
                value={form.fiscal_address}
                onChange={(e) => setForm({ ...form, fiscal_address: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="Email">
            {(a) => (
              <Input
                id={a.id}
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="Teléfono">
            {(a) => (
              <Input
                id={a.id}
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            )}
          </FormField>
        </div>
        {error !== null && (
          <div className="mt-3">
            <MensajeError error={error} />
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onCerrar(false)} disabled={guardando}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={
              guardando ||
              form.legal_name.trim() === "" ||
              ((form.person_type_code === "juridica" || form.person_type_code === "gobierno") &&
                form.fiscal_address.trim() === "")
            }
            onClick={() => void guardar()}
          >
            {guardando ? "Creando…" : "Crear cliente"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetalleCliente({
  cliente,
  onCerrar,
}: {
  cliente: Customer;
  onCerrar: (hecho: boolean) => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [editando, setEditando] = useState(false);
  const [form, setForm] = useState({
    legal_name: cliente.legal_name,
    trade_name: cliente.trade_name ?? "",
    fiscal_address: cliente.fiscal_address ?? "",
    email: cliente.email ?? "",
    phone: cliente.phone ?? "",
    status: cliente.status,
  });
  const [rif, setRif] = useState(cliente.tax_id ?? "");
  const [motivoBloqueo, setMotivoBloqueo] = useState("");
  const [confirmandoRif, setConfirmandoRif] = useState(false);
  const [confirmandoBloqueo, setConfirmandoBloqueo] = useState<boolean | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function guardarEdicion(): Promise<void> {
    setError(null);
    const oNull = (v: string) => (v.trim() === "" ? null : v.trim());
    try {
      await llamar(`/v1/customers/${cliente.id}`, {
        method: "PATCH",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          legal_name: form.legal_name,
          trade_name: oNull(form.trade_name),
          fiscal_address: oNull(form.fiscal_address),
          email: oNull(form.email),
          phone: oNull(form.phone),
          // El bloqueo NO se toca por aquí: tiene su endpoint y su permiso.
          ...(cliente.status !== "blocked" && form.status !== "blocked"
            ? { status: form.status }
            : {}),
        }),
      });
      toast.success("Cliente actualizado");
      onCerrar(true);
    } catch (e) {
      setError(e);
    }
  }

  async function cambiarRif(): Promise<void> {
    setError(null);
    try {
      await llamar(`/v1/customers/${cliente.id}/tax-id`, {
        method: "PUT",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          tax_id: rif.trim() === "" ? null : rif.trim(),
        }),
      });
      toast.success("RIF cambiado", "Auditado con el valor anterior.");
      onCerrar(true);
    } catch (e) {
      setError(e);
      toast.error("No se pudo cambiar el RIF");
    }
  }

  async function bloquear(blocked: boolean): Promise<void> {
    setError(null);
    try {
      await llamar(`/v1/customers/${cliente.id}/blocked`, {
        method: "PUT",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          blocked,
          ...(motivoBloqueo.trim() === "" ? {} : { reason: motivoBloqueo.trim() }),
        }),
      });
      toast.success(blocked ? "Cliente bloqueado" : "Cliente desbloqueado");
      onCerrar(true);
    } catch (e) {
      setError(e);
    }
  }

  const estado = ESTADO[cliente.status] ?? { etiqueta: cliente.status, tone: "outline" as const };

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar(false)}>
      <DialogContent className="max-w-xl">
        <DialogTitle>{cliente.legal_name}</DialogTitle>
        <DialogDescription>
          <span className="font-mono">{cliente.tax_id ?? "sin RIF"}</span> ·{" "}
          {cliente.person_type_code} · {cliente.taxpayer_type_code}
        </DialogDescription>
        <div className="mt-1">
          <Badge tone={estado.tone}>{estado.etiqueta}</Badge>
        </div>

        {!editando ? (
          <div className="mt-3 space-y-3">
            <DeudaDelCliente cliente={cliente} />
            <div className="grid grid-cols-1 gap-1 text-[0.9rem] sm:grid-cols-2">
              <p className="text-muted-foreground">
                Dirección: <span className="text-foreground">{cliente.fiscal_address ?? "—"}</span>
              </p>
              <p className="text-muted-foreground">
                Email: <span className="text-foreground">{cliente.email ?? "—"}</span>
              </p>
              <p className="text-muted-foreground">
                Teléfono: <span className="text-foreground">{cliente.phone ?? "—"}</span>
              </p>
              <Link
                to={`/admin/cuentas?cliente=${cliente.id}`}
                className="inline-flex items-center gap-1.5 text-accent-soft-foreground hover:underline"
              >
                <Banknote className="size-4" /> Estado de cuenta y aging
              </Link>
            </div>

            <div className="rounded-md border border-border bg-surface-muted/40 p-3">
              <p className="text-[0.85rem] font-medium">Cambiar RIF — permiso propio, auditado</p>
              <div className="mt-2 flex gap-2">
                <Input
                  aria-label="Nuevo RIF"
                  className="font-mono"
                  placeholder="Nuevo RIF (vacío = sin RIF, solo persona natural)"
                  value={rif}
                  onChange={(e) => setRif(e.target.value)}
                />
                <Button variant="secondary" onClick={() => setConfirmandoRif(true)}>
                  Cambiar
                </Button>
              </div>
            </div>

            <div className="rounded-md border border-border bg-surface-muted/40 p-3">
              <p className="text-[0.85rem] font-medium">Bloqueo de cobranzas</p>
              <div className="mt-2 flex gap-2">
                <Input
                  aria-label="Motivo del bloqueo"
                  placeholder="Motivo (opcional)"
                  value={motivoBloqueo}
                  onChange={(e) => setMotivoBloqueo(e.target.value)}
                />
                {cliente.status === "blocked" ? (
                  <Button variant="secondary" onClick={() => setConfirmandoBloqueo(false)}>
                    <LockOpen /> Desbloquear
                  </Button>
                ) : (
                  <Button variant="destructive" onClick={() => setConfirmandoBloqueo(true)}>
                    <Lock /> Bloquear
                  </Button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField label="Razón social" required>
              {(a) => (
                <Input
                  id={a.id}
                  value={form.legal_name}
                  onChange={(e) => setForm({ ...form, legal_name: e.target.value })}
                />
              )}
            </FormField>
            <FormField label="Nombre comercial">
              {(a) => (
                <Input
                  id={a.id}
                  value={form.trade_name}
                  onChange={(e) => setForm({ ...form, trade_name: e.target.value })}
                />
              )}
            </FormField>
            <FormField
              label="Estado"
              {...(cliente.status === "blocked"
                ? { hint: "Bloqueado: se cambia solo desde el bloqueo de cobranzas." }
                : {})}
            >
              {(a) => (
                <SimpleSelect
                  id={a.id}
                  value={form.status}
                  disabled={cliente.status === "blocked"}
                  onValueChange={(v) => setForm({ ...form, status: v as Customer["status"] })}
                  options={[
                    { value: "lead", label: "Prospecto" },
                    { value: "active", label: "Activo" },
                    { value: "inactive", label: "Inactivo" },
                  ]}
                />
              )}
            </FormField>
            <FormField label="Dirección fiscal">
              {(a) => (
                <Input
                  id={a.id}
                  value={form.fiscal_address}
                  onChange={(e) => setForm({ ...form, fiscal_address: e.target.value })}
                />
              )}
            </FormField>
            <FormField label="Email">
              {(a) => (
                <Input
                  id={a.id}
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              )}
            </FormField>
            <FormField label="Teléfono">
              {(a) => (
                <Input
                  id={a.id}
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              )}
            </FormField>
          </div>
        )}

        {error !== null && (
          <div className="mt-3">
            <MensajeError error={error} />
          </div>
        )}

        <DialogFooter>
          {!editando ? (
            <>
              <Button variant="ghost" onClick={() => onCerrar(false)}>
                Cerrar
              </Button>
              <Button variant="secondary" onClick={() => setEditando(true)}>
                <Pencil /> Editar
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setEditando(false)}>
                Volver
              </Button>
              <Button
                variant="primary"
                disabled={form.legal_name.trim() === ""}
                onClick={() => void guardarEdicion()}
              >
                Guardar cambios
              </Button>
            </>
          )}
        </DialogFooter>

        <ConfirmDialog
          open={confirmandoRif}
          onOpenChange={setConfirmandoRif}
          title="Cambiar el RIF"
          confirmLabel="Cambiar el RIF"
          onConfirm={cambiarRif}
        >
          De «{cliente.tax_id ?? "—"}» a «{rif.trim() === "" ? "—" : rif.trim()}». La identidad
          fiscal de una contraparte no se edita a la ligera: exige permiso propio y queda
          <strong> auditada con el valor anterior</strong>.
        </ConfirmDialog>

        <ConfirmDialog
          open={confirmandoBloqueo !== null}
          onOpenChange={(v) => !v && setConfirmandoBloqueo(null)}
          title={confirmandoBloqueo === true ? "Bloquear al cliente" : "Desbloquear al cliente"}
          confirmLabel={confirmandoBloqueo === true ? "Bloquear" : "Desbloquear"}
          destructive={confirmandoBloqueo === true}
          onConfirm={() => bloquear(confirmandoBloqueo === true)}
        >
          {confirmandoBloqueo === true ? (
            <>
              Un cliente bloqueado <strong>no puede comprar</strong>: toda venta nueva se rechaza
              hasta que cobranzas lo libere.
            </>
          ) : (
            <>El cliente vuelve a poder comprar. El bloqueo y su motivo quedan en la auditoría.</>
          )}
        </ConfirmDialog>
      </DialogContent>
    </Dialog>
  );
}

/**
 * La deuda, bien plasmada donde el dueño decidió que viva (2026-09-05): la
 * cifra de HOY en grande, las facturas pendientes con su cobro y el estado
 * de cuenta listo para WhatsApp. Todo lo calcula el servidor; el mostrador
 * solo muestra la información del cliente.
 */
function DeudaDelCliente({ cliente }: { cliente: Customer }): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const [cobrando, setCobrando] = useState<DocumentoAbierto | null>(null);
  const qc = useQueryClient();

  const estado = useQuery({
    queryKey: ["estado-cliente", empresa.id, cliente.id],
    queryFn: () => llamar<EstadoDeCuenta>(`/v1/customers/${cliente.id}/statement`),
  });

  const abiertas = (estado.data?.documents ?? []).filter(
    (d) => d.status === "issued" && compararImportes(d.balance, "0") > 0,
  );

  const textoEstado = (): string => {
    if (!estado.data) return "";
    const filas = abiertas
      .map(
        (d) =>
          `• Factura ${d.series}-${String(d.document_number ?? "")}: ${mostrarImporte({ amount: d.balance, currency: estado.data.currency })}`,
      )
      .join("\n");
    return `Hola ${cliente.legal_name}, te escribe ${empresa.legal_name}. Tu cuenta pendiente:\n${filas}\nTotal: ${mostrarImporte({ amount: estado.data.total_outstanding, currency: estado.data.currency })}. ¡Gracias!`;
  };

  const telefonoWa = (cliente.phone ?? "").replace(/[^0-9]/g, "").replace(/^0/, "58");

  return (
    <div className="rounded-lg border border-border bg-surface-muted/40 p-4">
      <div className="text-center">
        <p className="text-[0.85rem] text-muted-foreground">Debe hoy</p>
        <p className="text-3xl font-semibold tabular-nums">
          {estado.data
            ? mostrarImporte({
                amount: estado.data.total_outstanding,
                currency: estado.data.currency,
              })
            : "…"}
        </p>
      </div>

      {abiertas.length > 0 && (
        <div className="mt-3">
          <p className="pb-1.5 text-[0.9rem] font-medium">Facturas pendientes</p>
          <div className="divide-y divide-border rounded-md border border-border bg-surface">
            {abiertas.map((d) => (
              <div key={d.id} className="flex items-center gap-2 px-3 py-2 text-[0.9rem]">
                <span className="min-w-0 flex-1">
                  {d.series}-{String(d.document_number ?? "").padStart(6, "0")}
                  <span className="text-[0.8rem] text-muted-foreground">
                    {" "}
                    · {d.issued_at !== null ? fechaRelativa(d.issued_at) : ""}
                  </span>
                </span>
                <span className="tabular-nums">
                  {mostrarImporte({
                    amount: d.balance,
                    currency: estado.data?.currency ?? "VES",
                  })}
                </span>
                {puede("sales.payment.register") && (
                  <Button variant="secondary" size="sm" onClick={() => setCobrando(d)}>
                    Cobrar
                  </Button>
                )}
              </div>
            ))}
          </div>
          {cliente.phone !== null && cliente.phone !== undefined ? (
            <a
              className="mt-2 block"
              href={`https://wa.me/${telefonoWa}?text=${encodeURIComponent(textoEstado())}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button variant="secondary" className="w-full">
                <MessageCircle /> Mandar estado de cuenta por WhatsApp
              </Button>
            </a>
          ) : (
            <p className="mt-2 text-center text-[0.82rem] text-faint-foreground">
              Ponle teléfono al cliente para mandarle su cuenta por WhatsApp.
            </p>
          )}
        </div>
      )}

      {cobrando !== null && estado.data && (
        <CobrarFactura
          documento={cobrando}
          moneda={estado.data.currency}
          onCerrar={() => setCobrando(null)}
          onCobrada={() => {
            setCobrando(null);
            void qc.invalidateQueries({ queryKey: ["estado-cliente", empresa.id, cliente.id] });
            void qc.invalidateQueries({ queryKey: ["clientes", empresa.id] });
          }}
        />
      )}
    </div>
  );
}

const MONEDA_FORMA: Record<string, string> = {
  efectivo_bs: "VES",
  efectivo_usd: "USD",
  pago_movil: "VES",
  transferencia: "VES",
  punto_venta: "VES",
  tarjeta: "VES",
  zelle: "USD",
  usdt: "USD",
  otro: "VES",
};

function CobrarFactura({
  documento,
  moneda,
  onCerrar,
  onCobrada,
}: {
  documento: DocumentoAbierto;
  moneda: string;
  onCerrar: () => void;
  onCobrada: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [monto, setMonto] = useState(documento.balance);
  const [forma, setForma] = useState<string | null>(null);

  const formas = useQuery({
    queryKey: ["formas-pago", empresa.id],
    staleTime: 60_000,
    queryFn: () => llamar<{ methods: FormaDePago[] }>("/v1/payment-methods"),
  });
  const configuradas = (formas.data?.methods ?? []).filter((f) => f.is_active);
  const opciones = [
    ...configuradas.map((f) => ({ value: `m:${f.id}`, label: f.name })),
    { value: "i:efectivo_bs", label: "Efectivo Bs." },
    { value: "i:efectivo_usd", label: "Efectivo USD" },
  ];

  const metodoElegido = forma?.startsWith("m:")
    ? configuradas.find((f) => `m:${f.id}` === forma)
    : undefined;
  const tipoDePago = metodoElegido?.kind ?? (forma !== null ? forma.slice(2) : null);
  const monedaCobro = tipoDePago !== null ? (MONEDA_FORMA[tipoDePago] ?? moneda) : moneda;

  const cobrar = useMutation({
    mutationFn: () =>
      llamar("/v1/payments", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          document_id: documento.id,
          currency: monedaCobro,
          amount: monto.trim().replace(",", "."),
          instrument: tipoDePago,
          ...(metodoElegido === undefined ? {} : { account_id: metodoElegido.account_id }),
        }),
      }),
    onSuccess: () => {
      toast.success("Cobro registrado");
      onCobrada();
    },
    onError: (e) => toast.error("No se pudo cobrar", errorDePersona(e)),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-sm">
        <DialogTitle>
          Cobrar {documento.series}-{String(documento.document_number ?? "")}
        </DialogTitle>
        <DialogDescription>
          Puede ser un abono: lo que se cobre se resta de la deuda.
        </DialogDescription>
        <div className="space-y-3 pt-2">
          <FormField label="¿Cómo pagó?" required>
            {(p) => (
              <SimpleSelect
                id={p.id}
                value={forma}
                onValueChange={(v) => {
                  // Si la forma nueva vive en OTRA moneda, el monto tecleado
                  // deja de significar lo mismo: se limpia, no se reinterpreta.
                  const metodo = v.startsWith("m:")
                    ? configuradas.find((f) => `m:${f.id}` === v)
                    : undefined;
                  const inst = metodo?.kind ?? v.slice(2);
                  const monedaNueva = MONEDA_FORMA[inst] ?? moneda;
                  if (monedaNueva !== monedaCobro) setMonto("");
                  setForma(v);
                }}
                options={opciones}
              />
            )}
          </FormField>
          <FormField
            label="¿Cuánto pagó?"
            required
            {...(monedaCobro !== moneda
              ? { hint: "En la moneda con la que pagó; el sistema convierte a la tasa de hoy." }
              : {})}
          >
            {(p) => (
              <MoneyInput
                {...p}
                value={monto}
                onChange={setMonto}
                currency={monedaCobro === "VES" ? "Bs." : monedaCobro}
              />
            )}
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={
              forma === null || !importeValido(monto.trim().replace(",", ".")) || cobrar.isPending
            }
            onClick={() => cobrar.mutate()}
          >
            Registrar cobro
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
