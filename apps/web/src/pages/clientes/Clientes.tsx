import { useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Banknote,
  Lock,
  LockOpen,
  MessageCircle,
  Pencil,
  Upload,
  UserPlus,
} from "lucide-react";
import {
  ImportarArchivo,
  PLANTILLA_CLIENTES,
  NOTA_FORMATO_CLIENTES,
} from "../../components/importar.js";
import { useSesion } from "../../app/session.js";
import { useAccionPedida } from "../../app/accion-pedida.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DataTable } from "../../components/DataTable.js";
import {
  FormField,
  MotivoDeLectura,
  importeLimpio,
  importeValido,
  motivoDeImporte,
} from "../../components/forms.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { CobrarDocumento } from "../../components/CobrarDocumento.js";
import { numeroDocumento } from "../../components/documento.js";
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
import { KIND_LABEL, MensajeError } from "../ventas/comunes.js";
import { fechaRelativa } from "../negocio/comunes.js";
import { mostrarImporte } from "../../money.js";
import {
  FALTA_LA_TASA,
  decisionDeCobro,
  estadoDeDeuda,
  nominalPorMoneda,
  textoDeDeuda,
} from "../../components/deuda.js";
import { errorDePersona } from "../../lib.js";
import type { Customer, CodeCatalog, PriceList } from "../../lib.js";
import { sufijoDeArchivo } from "../../app/rif.js";
import { avisoDigitoRif, formatearDocumento } from "@ladino/schemas";
import { useConFacturas } from "../../app/modo-venta.js";
import { Cartera } from "../../components/Cartera.js";
import { CLIENTE_ESPECIAL } from "../../components/capa-fiscal/textos.js";

/** La fila con la deuda funcional de HOY que calcula el servidor (ADR-0047). */
/** `debt` null = debe algo en divisa y falta la tasa de hoy (el servidor no lo puede valorar). */
type ClienteConDeuda = Customer & {
  readonly debt?: string | null;
  /**
   * P-05: lo VENCIDO de esa deuda, del servidor. «0.00» = nada vencido; null con
   * `overdue_reason: "sin_tasa"` = hay vencido y no se puede valorar hoy.
   */
  readonly overdue?: string | null;
  readonly overdue_reason?: "sin_tasa" | null;
};

type OrdenDeClientes = "nombre" | "deuda" | "deuda-asc" | "vencido" | "vencido-asc";
const ORDENES: readonly string[] = ["deuda", "deuda-asc", "vencido", "vencido-asc"];
/** Cómo se llama cada orden en `GET /v1/customers?sort=`. */
const SORT_DE_ORDEN: Record<Exclude<OrdenDeClientes, "nombre">, string> = {
  deuda: "debt_desc",
  "deuda-asc": "debt_asc",
  vencido: "overdue_desc",
  "vencido-asc": "overdue_asc",
};

/** Las facturas emitidas con saldo, tal como las devuelve el estado de cuenta. */
interface DocumentoAbierto {
  id: string;
  /** factura, recibo o nota de débito: el mensaje lo nombra por lo que es (A10). */
  kind: string;
  series: string;
  document_number: number | null;
  issued_at: string | null;
  total_amount: string;
  /** null = documento en divisa sin tasa de hoy (o sin saldo calculable). */
  balance: string | null;
  status: string;
  /** Días desde la emisión, contados por el servidor. */
  days_outstanding: number;
  /** P-05: el día en que vence (`AAAA-MM-DD`) y si ya venció; los dos del servidor. */
  due_date?: string | null;
  overdue?: boolean;
}
interface EstadoDeCuenta {
  currency: string;
  documents: DocumentoAbierto[];
  /** null = hay deuda en divisa y falta la tasa de hoy; el nominal va en `debt.by_currency`. */
  total_outstanding: string | null;
  /** La deuda por la única función del servidor (ADR-0075 §5): nominal por moneda y a la tasa de hoy. */
  debt: {
    functional_currency: string;
    as_of: string;
    by_currency: {
      currency: string;
      nominal: string;
      rate: string | null;
      functional_today: string | null;
    }[];
  };
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
  const { empresa, llamar, puede } = useSesion();
  // K-11 (ADR-0068 §4): crear e importar exigen customer.manage en el servidor; sin él, la
  // pantalla no los ofrece.
  const gestiona = puede("customer.manage");
  // P-04: la deuda de cada cliente se pide solo con `ar.read`; sin él, el servidor da 403.
  const verDeuda = puede("ar.read");
  const [busqueda, setBusqueda] = useState("");
  const [pagina, setPagina] = useState(1);
  /**
   * P-05: EL ORDEN POR DEUDA, EN LA URL (`?orden=deuda`, mayor primero; `?orden=deuda-asc`). Es
   * adonde llevan «Te deben…» del Inicio y «Ver quién me debe» de Mi dinero, y una vista con su
   * orden en la URL se puede compartir. Lo ordena el SERVIDOR sobre todos los clientes (la lista
   * se pagina allí): ordenar aquí solo ordenaría la página que se ve. Sin `ar.read` no hay deuda
   * que ordenar, y la lista va por nombre aunque la URL diga otra cosa.
   */
  const [params, setParams] = useSearchParams();
  const ordenPedido = params.get("orden");
  // `?orden=vencido` (lo vencido primero; `vencido-asc`): adonde llevan los recordatorios desde
  // que el fiado tiene vencimiento. El orden por deuda total sigue en la cabecera «Deuda».
  const orden: OrdenDeClientes =
    verDeuda && ordenPedido !== null && ORDENES.includes(ordenPedido)
      ? (ordenPedido as OrdenDeClientes)
      : "nombre";
  const alternarOrden = useCallback(
    (campo: "deuda" | "vencido"): void => {
      // Cada cabecera recorre lo suyo: mayor primero → menor primero → por nombre.
      const siguiente: OrdenDeClientes =
        orden === campo ? `${campo}-asc` : orden === `${campo}-asc` ? "nombre" : campo;
      setParams(
        (antes) => {
          const q = new URLSearchParams(antes);
          if (siguiente === "nombre") q.delete("orden");
          else q.set("orden", siguiente);
          return q;
        },
        { replace: true },
      );
      setPagina(1);
    },
    [orden, setParams],
  );
  const [creando, setCreando] = useState(false);
  // P-06: «Nuevo cliente» de la paleta llega con `?accion=nuevo` y abre el mismo diálogo del botón.
  useAccionPedida("nuevo", true, () => {
    if (gestiona) setCreando(true);
  });
  const [importando, setImportando] = useState(false);
  const [detalle, setDetalle] = useState<Customer | null>(null);
  const qc = useQueryClient();

  const clientes = useQuery({
    queryKey: ["clientes", empresa.id, busqueda, pagina, verDeuda, orden],
    queryFn: () => {
      const q = new URLSearchParams({
        page: String(pagina),
        per_page: String(PER_PAGE),
      });
      if (verDeuda) q.set("with_debt", "1");
      if (orden !== "nombre") q.set("sort", SORT_DE_ORDEN[orden]);
      if (busqueda.trim() !== "") q.set("search", busqueda.trim());
      return llamar<{ items: ClienteConDeuda[]; total: number }>(`/v1/customers?${q.toString()}`);
    },
  });

  const recargar = () => void qc.invalidateQueries({ queryKey: ["clientes", empresa.id] });

  // Sin RIF: cédula y nombre, nada de clasificación fiscal (regla del dueño, 2026-09-16).
  const conFacturas = useConFacturas();
  const columnas = useMemo<ColumnDef<ClienteConDeuda, unknown>[]>(
    () => [
      {
        id: "rif",
        header: conFacturas ? "RIF" : "Cédula o RIF",
        // Vestido con la función compartida (P-02): el crudo «J408887776» no se enseña.
        accessorFn: (c) => (c.tax_id === null ? "—" : formatearDocumento(c.tax_id)),
        cell: (c) => <span className="font-mono text-[0.84rem]">{c.getValue<string>()}</span>,
      },
      { id: "nombre", header: conFacturas ? "Razón social" : "Nombre", accessorKey: "legal_name" },
      ...(conFacturas
        ? ([
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
          ] as ColumnDef<ClienteConDeuda, unknown>[])
        : []),
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
      // H1 (P-04): sin ar.read no hay columna de deuda ni enlace al estado de cuenta: el servidor
      // no los da, y una columna vacía diría «Al día» de quien sí debe.
      ...(verDeuda
        ? ([
            {
              id: "deuda",
              // P-05: el orden por deuda es del servidor (no el de la tabla, que solo ordena la
              // página): por eso el botón vive aquí y `enableSorting` sigue apagado.
              header: () => (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 hover:text-foreground"
                  onClick={() => alternarOrden("deuda")}
                  aria-label={
                    orden === "deuda"
                      ? "Deuda: de mayor a menor. Ordenar de menor a mayor"
                      : orden === "deuda-asc"
                        ? "Deuda: de menor a mayor. Volver al orden por nombre"
                        : "Ordenar por deuda, de mayor a menor"
                  }
                >
                  Deuda
                  {orden === "deuda" ? (
                    <ArrowDown className="size-3" />
                  ) : orden === "deuda-asc" ? (
                    <ArrowUp className="size-3" />
                  ) : (
                    <ArrowUpDown className="size-3 opacity-40" />
                  )}
                </button>
              ),
              // El CSV sigue diciendo «Deuda»: la cabecera ya no es un texto.
              meta: { exportHeader: "Deuda" },
              enableSorting: false,
              // La misma deuda que ve el mostrador: funcional de HOY, del servidor.
              accessorFn: (c) => c.debt,
              cell: (c) => {
                const debt = c.getValue<string | null | undefined>();
                const estado = estadoDeDeuda(debt);
                if (estado === "sin_deuda") {
                  return <span className="text-[0.82rem] text-muted-foreground">Al día</span>;
                }
                // Debe, y falta la tasa para decirlo en bolívares: se dice eso, no «Al día».
                if (estado === "sin_valorar") {
                  return (
                    <span className="text-[0.82rem] text-warning-soft-foreground">
                      {FALTA_LA_TASA}
                    </span>
                  );
                }
                return (
                  <span className="font-mono text-[0.84rem] text-warning-soft-foreground">
                    {textoDeDeuda(debt, "VES")}
                  </span>
                );
              },
            },
            {
              id: "vencido",
              // P-05: lo vencido de esa deuda. La cifra y el orden son del servidor; aquí solo
              // se pinta: «—» sin nada vencido, el texto único cuando falta la tasa.
              header: () => (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 hover:text-foreground"
                  onClick={() => alternarOrden("vencido")}
                  aria-label={
                    orden === "vencido"
                      ? "Vencido: de mayor a menor. Ordenar de menor a mayor"
                      : orden === "vencido-asc"
                        ? "Vencido: de menor a mayor. Volver al orden por nombre"
                        : "Ordenar por deuda vencida, de mayor a menor"
                  }
                >
                  Vencido
                  {orden === "vencido" ? (
                    <ArrowDown className="size-3" />
                  ) : orden === "vencido-asc" ? (
                    <ArrowUp className="size-3" />
                  ) : (
                    <ArrowUpDown className="size-3 opacity-40" />
                  )}
                </button>
              ),
              meta: { exportHeader: "Vencido" },
              enableSorting: false,
              accessorFn: (c) => c.overdue,
              cell: (c) => {
                const vencido = c.getValue<string | null | undefined>();
                const estado = estadoDeDeuda(vencido);
                if (estado === "sin_deuda") {
                  return <span className="text-[0.82rem] text-muted-foreground">—</span>;
                }
                if (estado === "sin_valorar") {
                  return <span className="text-[0.82rem] text-destructive">{FALTA_LA_TASA}</span>;
                }
                return (
                  <span className="font-mono text-[0.84rem] font-medium text-destructive">
                    {textoDeDeuda(vencido, "VES")}
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
          ] as ColumnDef<ClienteConDeuda, unknown>[])
        : []),
    ],
    [conFacturas, verDeuda, orden, alternarOrden],
  );

  return (
    <div>
      <PageHeader
        title="Clientes"
        description={
          conFacturas
            ? "El maestro de contrapartes de venta: RIF, clasificación fiscal y bloqueo de cobranzas."
            : verDeuda
              ? "Quién te compra, cómo contactarlo y quién te debe."
              : "Quién te compra y cómo contactarlo."
        }
        actions={
          gestiona ? (
            <>
              <Button variant="secondary" onClick={() => setImportando(true)}>
                <Upload /> Importar
              </Button>
              <Button variant="primary" onClick={() => setCreando(true)}>
                <UserPlus /> Nuevo cliente
              </Button>
            </>
          ) : undefined
        }
      />

      {importando && (
        <ImportarArchivo
          titulo="Importar clientes"
          descripcion="Descarga la plantilla, llénala y súbela. Las filas buenas entran; las malas se explican con su número."
          notaFormato={NOTA_FORMATO_CLIENTES}
          endpoint="/v1/customers/import"
          plantilla={PLANTILLA_CLIENTES}
          onCerrar={() => setImportando(false)}
          onListo={recargar}
        />
      )}
      {/* F-13: la lista ordenada por deuda ES la cartera; arriba, su total, lo vencido y el
          nominal por moneda (del servidor). Los tramos por cliente, en Cuentas por cobrar. */}
      {verDeuda && orden !== "nombre" && (
        <div className="mb-4 space-y-2">
          <Cartera tipo="receivables" soloResumen />
          <Link
            to="/admin/cuentas?orden=vencido"
            className="text-[0.85rem] text-accent-soft-foreground hover:underline"
          >
            Ver la cartera por antigüedad
          </Link>
        </div>
      )}
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
          placeholder: conFacturas
            ? "Buscar por RIF o razón social…"
            : "Buscar por cédula o nombre…",
        }}
        pagination={{
          total: clientes.data?.total ?? 0,
          page: pagina,
          perPage: PER_PAGE,
          onPageChange: setPagina,
        }}
        exportCsv={{ filename: `clientes-${sufijoDeArchivo(empresa)}.csv` }}
        empty={{
          title: busqueda === "" ? "Todavía no hay clientes" : "Nada con esa búsqueda",
          description:
            busqueda === ""
              ? conFacturas
                ? "El primer cliente habilita las ventas: la factura exige contraparte."
                : "Registra a quien te compra fiado o quiere su nombre en el recibo."
              : conFacturas
                ? "La búsqueda es del servidor: prueba con parte del RIF o del nombre."
                : "Prueba con parte de la cédula o del nombre.",
          action:
            busqueda === "" && gestiona ? (
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
  const conFacturas = useConFacturas();
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
          // Sin RIF no se preguntan: el servidor los deduce de la letra del documento.
          ...(conFacturas
            ? {
                person_type_code: form.person_type_code,
                taxpayer_type_code: form.taxpayer_type_code,
              }
            : {}),
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
          {conFacturas
            ? "El RIF puede quedar vacío SOLO para persona natural; la clasificación fiscal la confirma el contador (VALIDAR-TRIBUTARIO)."
            : "Con el nombre basta. La cédula ayuda a encontrarlo después."}
        </DialogDescription>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField
            label={conFacturas ? "RIF" : "Cédula o RIF"}
            hint={conFacturas ? "Vacío solo para persona natural." : "Opcional para una persona."}
          >
            {(a) => (
              <Input
                id={a.id}
                className="font-mono"
                value={form.tax_id}
                onChange={(e) => setForm({ ...form, tax_id: e.target.value })}
              />
            )}
          </FormField>
          {/* El dígito verificador solo avisa: el servidor acepta y lo registra (A-08). */}
          {avisoDigitoRif(form.tax_id) !== null && (
            <p role="status" className="text-[0.85rem] text-warning-soft-foreground">
              {avisoDigitoRif(form.tax_id)}
            </p>
          )}
          <FormField label={conFacturas ? "Razón social / nombre" : "Nombre"} required>
            {(a) => (
              <Input
                id={a.id}
                value={form.legal_name}
                onChange={(e) => setForm({ ...form, legal_name: e.target.value })}
              />
            )}
          </FormField>
          {conFacturas && (
            <>
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
            </>
          )}
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
            label={conFacturas ? "Dirección fiscal" : "Dirección"}
            {...(conFacturas &&
            (form.person_type_code === "juridica" || form.person_type_code === "gobierno")
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
  const { empresa, llamar, puede } = useSesion();
  const conFacturasFicha = useConFacturas();
  const toast = useToast();
  const [editando, setEditando] = useState(false);
  const [form, setForm] = useState({
    legal_name: cliente.legal_name,
    trade_name: cliente.trade_name ?? "",
    fiscal_address: cliente.fiscal_address ?? "",
    email: cliente.email ?? "",
    phone: cliente.phone ?? "",
    status: cliente.status,
    default_price_list_id: cliente.default_price_list_id ?? "",
  });
  // E-09: el límite de fiado, en USD. Lo fija quien tenga customers.credit.set.
  const [limite, setLimite] = useState("");
  // E-14: la clasificación fiscal se cambia aparte, con permiso propio.
  const [clasificacion, setClasificacion] = useState(cliente.taxpayer_type_code);
  const catalogos = useQuery({
    queryKey: ["catalogos-ficha-cliente", empresa.id],
    staleTime: 300_000,
    queryFn: async () => {
      const [fiscales, listas] = await Promise.all([
        llamar<CodeCatalog[]>("/v1/taxpayer-types").catch(() => [] as CodeCatalog[]),
        llamar<PriceList[]>("/v1/price-lists").catch(() => [] as PriceList[]),
      ]);
      return { fiscales, listas };
    },
  });

  async function fijarLimite(): Promise<void> {
    setError(null);
    try {
      await llamar(`/v1/customers/${cliente.id}/credit-limit`, {
        method: "PUT",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          credit_limit_usd: importeLimpio(limite),
        }),
      });
      toast.success("Límite de fiado fijado", "Quedó el acta con el valor anterior.");
      onCerrar(true);
    } catch (e) {
      setError(e);
      toast.error("No se pudo fijar el límite", errorDePersona(e));
    }
  }

  async function cambiarClasificacion(): Promise<void> {
    setError(null);
    try {
      await llamar(`/v1/customers/${cliente.id}/taxpayer-type`, {
        method: "PUT",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id, taxpayer_type_code: clasificacion }),
      });
      toast.success("Clasificación cambiada", "Auditada con el valor anterior.");
      onCerrar(true);
    } catch (e) {
      setError(e);
      toast.error("No se pudo cambiar la clasificación", errorDePersona(e));
    }
  }
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
          // E-14: la lista preferida también se elige al editar (antes solo al crear).
          default_price_list_id: oNull(form.default_price_list_id),
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
          {conFacturasFicha ? (
            <>
              <span className="font-mono">
                {cliente.tax_id === null ? "sin RIF" : formatearDocumento(cliente.tax_id)}
              </span>{" "}
              · {cliente.person_type_code} · {cliente.taxpayer_type_code}
            </>
          ) : (
            <span className="tabular-nums">
              {cliente.tax_id === null ? "Sin cédula" : formatearDocumento(cliente.tax_id)}
            </span>
          )}
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
                <Banknote className="size-4" />{" "}
                {conFacturasFicha ? "Estado de cuenta y aging" : "Lo que me debe"}
              </Link>
            </div>

            <div className="rounded-md border border-border bg-surface-muted/40 p-3">
              <p className="text-[0.85rem] font-medium">
                {conFacturasFicha
                  ? "Cambiar RIF — permiso propio, auditado"
                  : "Cambiar la cédula o el RIF"}
              </p>
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

            <div
              className="rounded-md border border-border bg-surface-muted/40 p-3"
              data-testid="cliente-limite-fiado"
            >
              <p className="text-[0.85rem] font-medium">
                Límite de fiado:{" "}
                <span className="tabular-nums">
                  {mostrarImporte({
                    amount: cliente.credit_limit_usd ?? "0",
                    currency: "USD",
                  })}
                </span>
              </p>
              <p className="mt-1 text-[0.8rem] text-muted-foreground">
                Hasta cuánto puede deber este cliente, en dólares. Con 0 no se le fía. Cambiarlo
                deja acta.
              </p>
              {puede("customers.credit.set") && (
                <>
                  <div className="mt-2 flex gap-2">
                    <Input
                      aria-label="Nuevo límite de fiado en dólares"
                      inputMode="decimal"
                      className="tabular-nums"
                      placeholder="Nuevo límite en USD (ej. 50)"
                      value={limite}
                      onChange={(e) => setLimite(e.target.value)}
                    />
                    <Button
                      variant="secondary"
                      disabled={!importeValido(limite)}
                      onClick={() => void fijarLimite()}
                    >
                      Fijar
                    </Button>
                  </div>
                  {/* F-06: lo que no se pudo leer se dice; no se manda mil veces menor. */}
                  <MotivoDeLectura className="mt-1" motivo={motivoDeImporte(limite)} />
                </>
              )}
            </div>

            {conFacturasFicha && puede("customer.tax_id.manage") && (
              <div className="rounded-md border border-border bg-surface-muted/40 p-3">
                <p className="text-[0.85rem] font-medium">{CLIENTE_ESPECIAL.fichaTitulo}</p>
                <p className="mt-1 text-[0.8rem] text-muted-foreground">
                  {CLIENTE_ESPECIAL.fichaAyuda}
                </p>
                <div className="mt-2 flex gap-2">
                  <SimpleSelect
                    ariaLabel="Clasificación fiscal del cliente"
                    className="flex-1"
                    value={clasificacion}
                    onValueChange={setClasificacion}
                    options={(catalogos.data?.fiscales ?? []).map((t) => ({
                      value: t.code,
                      label: t.name,
                    }))}
                  />
                  <Button
                    variant="secondary"
                    disabled={clasificacion === cliente.taxpayer_type_code}
                    onClick={() => void cambiarClasificacion()}
                  >
                    Cambiar
                  </Button>
                </div>
              </div>
            )}

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
            <FormField label={conFacturasFicha ? "Dirección fiscal" : "Dirección"}>
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
            <FormField
              label="Lista de precios preferida"
              hint="Opcional. Sin ella, la de mostrador."
            >
              {(a) => (
                <SimpleSelect
                  id={a.id}
                  value={form.default_price_list_id === "" ? "ninguna" : form.default_price_list_id}
                  onValueChange={(v) =>
                    setForm({ ...form, default_price_list_id: v === "ninguna" ? "" : v })
                  }
                  options={[
                    { value: "ninguna", label: "Sin preferida" },
                    ...(catalogos.data?.listas ?? []).map((l) => ({
                      value: l.id,
                      label: `${l.name} (${l.currency_code})`,
                    })),
                  ]}
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
          De «{cliente.tax_id === null ? "—" : formatearDocumento(cliente.tax_id)}» a «
          {rif.trim() === "" ? "—" : formatearDocumento(rif.trim())}». La identidad fiscal de una
          contraparte no se edita a la ligera: exige permiso propio y queda
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
    // Sin valorar (null) también está abierta: debe, y falta la tasa para decir cuánto en Bs.
    (d) => d.status === "issued" && estadoDeDeuda(d.balance) !== "sin_deuda",
  );

  // «Desde hace N días»: la factura abierta MÁS VIEJA manda, con el color de
  // su bucket de antigüedad (los mismos cortes de Cuentas por cobrar). Los
  // días los contó el servidor; aquí solo se elige el máximo.
  const diasDeuda = abiertas.reduce((max, d) => Math.max(max, d.days_outstanding), 0);
  const colorDeuda =
    diasDeuda > 60
      ? "text-destructive-soft-foreground"
      : diasDeuda > 30
        ? "text-warning-soft-foreground"
        : "text-muted-foreground";

  const textoEstado = (): string => {
    if (!estado.data) return "";
    const filas = abiertas
      .map(
        (d) =>
          `• ${KIND_LABEL[d.kind] ?? "Documento"} ${d.series}-${String(d.document_number ?? "")}: ${textoDeDeuda(d.balance, estado.data.currency)}`,
      )
      .join("\n");
    // F-04 (ADR-0075 §5): el aviso dice lo que se debe EN SU MONEDA y, al lado, los bolívares
    // a la tasa de hoy con su fecha. Todas las cifras vienen del servidor: aquí solo se escriben.
    const [a, m, dia] = estado.data.debt.as_of.split("-");
    const fecha = `${dia ?? ""}/${m ?? ""}/${a ?? ""}`;
    const enDivisa = estado.data.debt.by_currency.filter(
      (x) =>
        x.currency !== estado.data.debt.functional_currency &&
        x.rate !== null &&
        x.functional_today !== null,
    );
    const divisa = enDivisa
      .map(
        (x) =>
          `${mostrarImporte({ amount: x.nominal, currency: x.currency })} = ${textoDeDeuda(x.functional_today, estado.data.debt.functional_currency)} a la tasa BCV del ${fecha} (${mostrarImporte({ amount: x.rate ?? "0", currency: estado.data.debt.functional_currency })} por ${x.currency})`,
      )
      .join("; ");
    const total = textoDeDeuda(estado.data.total_outstanding, estado.data.currency);
    // Sin tasa de hoy no hay total en bolívares que decirle al cliente: se le dice lo que debe
    // en su moneda, que sí se conoce. Nunca «Total: Bs. 0,00».
    const nominal = nominalPorMoneda(estado.data.debt.by_currency);
    const cierre =
      estado.data.total_outstanding === null
        ? `Total: ${nominal === "" ? "pendiente" : nominal} al ${fecha}.`
        : enDivisa.length > 0
          ? `Total: ${total} al ${fecha}. De eso, en divisas: ${divisa}.`
          : `Total: ${total} al ${fecha}.`;
    return `Hola ${cliente.legal_name}, te escribe ${empresa.trade_name ?? empresa.legal_name}. Tu cuenta pendiente:\n${filas}\n${cierre} ¡Gracias!`;
  };

  const telefonoWa = (cliente.phone ?? "").replace(/[^0-9]/g, "").replace(/^0/, "58");

  return (
    <div className="rounded-lg border border-border bg-surface-muted/40 p-4">
      <div className="text-center">
        <p className="text-[0.85rem] text-muted-foreground">Debe hoy</p>
        <p className="text-3xl font-semibold tabular-nums">
          {estado.data
            ? textoDeDeuda(estado.data.total_outstanding, estado.data.currency)
            : estado.isError
              ? "—"
              : "…"}
        </p>
        {/* Sin tasa del día: lo que SÍ se sabe es cuánto debe en su moneda. */}
        {estado.data &&
          estado.data.total_outstanding === null &&
          nominalPorMoneda(estado.data.debt.by_currency) !== "" && (
            <p className="text-[0.9rem] tabular-nums">
              Debe {nominalPorMoneda(estado.data.debt.by_currency)}
            </p>
          )}
        {/* Un fallo del estado de cuenta no se disfraza de «…» eterno: se dice
            en voz de persona y se puede reintentar. */}
        {estado.isError && (
          <div className="mt-1 space-y-1">
            <p role="alert" className="text-[0.85rem] text-destructive-soft-foreground">
              {errorDePersona(estado.error)}
            </p>
            <Button variant="ghost" size="sm" onClick={() => void estado.refetch()}>
              Reintentar
            </Button>
          </div>
        )}
        {abiertas.length > 0 && (
          <p className={`text-[0.85rem] ${colorDeuda}`}>
            {diasDeuda === 0
              ? "desde hoy"
              : `desde hace ${String(diasDeuda)} día${diasDeuda === 1 ? "" : "s"}`}
          </p>
        )}
      </div>

      {abiertas.length > 0 && (
        <div className="mt-3">
          <p className="pb-1.5 text-[0.9rem] font-medium">Pendientes de cobro</p>
          <div className="divide-y divide-border rounded-md border border-border bg-surface">
            {abiertas.map((d) => (
              <div key={d.id} className="flex items-center gap-2 px-3 py-2 text-[0.9rem]">
                <span className="min-w-0 flex-1">
                  {d.series}-{String(d.document_number ?? "").padStart(6, "0")}
                  <span className="text-[0.8rem] text-muted-foreground">
                    {" "}
                    · {d.issued_at !== null ? fechaRelativa(d.issued_at) : ""}
                  </span>
                  {/* P-05: cuándo vence y si ya venció, dicho por el servidor (día de Caracas). */}
                  {d.due_date !== undefined && d.due_date !== null && (
                    <span
                      className={`block text-[0.8rem] ${
                        d.overdue === true ? "text-destructive" : "text-muted-foreground"
                      }`}
                    >
                      {d.overdue === true ? "Venció el " : "Vence el "}
                      {d.due_date.slice(8, 10)}/{d.due_date.slice(5, 7)}/{d.due_date.slice(0, 4)}
                    </span>
                  )}
                </span>
                <span className="tabular-nums">
                  {textoDeDeuda(d.balance, estado.data?.currency ?? "VES")}
                </span>
                {/* Sin valorar (saldo nulo): el botón queda APAGADO con su motivo; el cobro no
                    se abre con un «0» precargado (components/deuda.ts, decisionDeCobro). */}
                {puede("sales.payment.register") && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={decisionDeCobro(d.balance).apagado}
                    title={decisionDeCobro(d.balance).motivo ?? undefined}
                    onClick={() => setCobrando(d)}
                  >
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

      {cobrando !== null && cobrando.balance !== null && estado.data && (
        <CobrarDocumento
          documentId={cobrando.id}
          customerId={cliente.id}
          // Sin tasa de hoy el saldo no se conoce y el cobro NO se abre (el botón está apagado):
          // aquí el saldo siempre es una cifra del servidor.
          saldo={{ amount: cobrando.balance, currency: estado.data.currency }}
          // El estado de cuenta no trae la moneda de emisión de cada factura:
          // se asume la funcional; la narrativa de tasas la da el detalle.
          documentCurrency={estado.data.currency}
          etiqueta={numeroDocumento(cobrando.series, cobrando.document_number)}
          onCerrar={() => setCobrando(null)}
          onCobrado={() => {
            setCobrando(null);
            void qc.invalidateQueries({ queryKey: ["estado-cliente", empresa.id, cliente.id] });
            void qc.invalidateQueries({ queryKey: ["clientes", empresa.id] });
            void qc.invalidateQueries({ queryKey: ["documentos", empresa.id] });
            void qc.invalidateQueries({ queryKey: ["documento", empresa.id, cobrando.id] });
          }}
        />
      )}
    </div>
  );
}
