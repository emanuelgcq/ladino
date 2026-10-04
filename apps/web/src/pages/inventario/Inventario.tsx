import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowLeftRight, ArrowUpFromLine, ClipboardList, Scale, TimerReset } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DataTable } from "../../components/DataTable.js";
import { FormField, EntityPicker, type EntityOption } from "../../components/forms.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { PorRecibir } from "../../components/PorRecibir.js";
import { Button } from "../../ui/button.js";
import { Input } from "../../ui/input.js";
import { SimpleSelect } from "../../ui/select.js";
import { Badge } from "../../ui/badge.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card.js";
import { Skeleton } from "../../ui/card.js";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../../ui/tabs.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../ui/dialog.js";
import { useToast } from "../../ui/toast.js";
import { mostrarCantidad, mostrarImporte } from "../../money.js";
import { MensajeError } from "../ventas/comunes.js";
import { errorDePersona, LlamadaApiError } from "../../lib.js";
import type {
  ExpiringLot,
  InventoryMove,
  LowStockItem,
  Product,
  RecipeLineView,
  StockBalance,
  Warehouse,
} from "../../lib.js";
import { fechaLocal, fechaHoraLocal } from "../../fechas.js";
import { sufijoDeArchivo } from "../../app/rif.js";

/**
 * Inventario — Fase B. Cuatro superficies en pestañas: existencias (con el
 * kardex VIRTUALIZADO por producto), los cuatro movimientos, las alertas de
 * reposición/vencimiento y las recetas de compuestos.
 *
 * CERO aritmética: saldo, valor y costo de cada línea del kardex vienen del
 * movimiento tal como el esquema los calculó y guardó (`quantity_after`,
 * `value_after`, `unit_cost`). Recalcularlos aquí sería una segunda verdad.
 */
/**
 * INVENTARIO NO METE MERCANCÍA (ADR-0066 §7). Aquí se cuenta, se ajusta y se traslada; lo que
 * ENTRA de fuera —comprado o aportado— pasa por «Llegó mercancía», que además pregunta de quién
 * vino, si hay factura y si ya se pagó, y deriva el asiento de eso. La «entrada de existencias»
 * que vivía aquí era la segunda puerta: mandaba todo contra «aportes en inventario» aunque la
 * mercancía se hubiera comprado y pagado.
 */
type Operacion = "salida" | "conteo" | "ajuste" | "transferencia";

/**
 * EL MOTIVO DE LA SALIDA, lista cerrada (ADR-0078 §2, I-01): lo que la base guarda y lo que decide
 * adónde va en el mayor. La pantalla solo lo nombra; la cuenta y el débito los decide el servidor.
 */
const MOTIVOS_SALIDA: { value: string; label: string; retiro: boolean }[] = [
  { value: "merma", label: "Merma", retiro: false },
  { value: "rotura", label: "Rotura", retiro: false },
  { value: "vencido", label: "Vencido", retiro: false },
  { value: "faltante", label: "Faltante justificado", retiro: false },
  { value: "consumo_propio", label: "Consumo propio", retiro: true },
  { value: "regalo", label: "Regalo", retiro: true },
  { value: "donacion", label: "Donación", retiro: true },
  { value: "muestra", label: "Muestra", retiro: true },
];
const NOMBRE_MOTIVO: Record<string, string> = Object.fromEntries(
  MOTIVOS_SALIDA.map((m) => [m.value, m.label]),
);

/** El tipo del kardex en palabras de persona (I-06). */
const TIPO_LEGIBLE: Record<string, string> = {
  entrada: "Entrada",
  salida: "Salida",
  ajuste: "Ajuste",
  revaluacion: "Revaluación",
  transferencia_in: "Traslado (entra)",
  transferencia_out: "Traslado (sale)",
};

/** Los campos que el servidor rechazó, por nombre de campo (I-09): se marcan en el formulario. */
function camposDelError(e: unknown): Record<string, string> {
  if (!(e instanceof LlamadaApiError) || !Array.isArray(e.body.details)) return {};
  const campos: Record<string, string> = {};
  for (const d of e.body.details as { path?: unknown; message?: unknown }[]) {
    const ruta: unknown[] = Array.isArray(d.path) ? (d.path as unknown[]) : [];
    const clave = [...ruta].reverse().find((p): p is string => typeof p === "string");
    if (clave !== undefined && typeof d.message === "string") campos[clave] = d.message;
  }
  return campos;
}

const OPERACION: Record<
  Operacion,
  {
    etiqueta: string;
    /** «la entrada», «el ajuste»: el título de la confirmación concuerda. */
    articulo: "la" | "el";
    icono: React.JSX.Element;
    consecuencia: string;
    permiso: string;
  }
> = {
  salida: {
    etiqueta: "Salida",
    articulo: "la",
    icono: <ArrowUpFromLine />,
    permiso: "inventory.move",
    consecuencia:
      "Sale al costo promedio vigente, que calcula el servidor. Merma, rotura, vencido y faltante van a «Pérdidas por mermas y faltantes»; consumo propio, regalo, donación y muestra son un retiro: si facturas, llevan IVA sobre el precio de venta y una Nota de retiro numerada.",
  },
  conteo: {
    etiqueta: "Conteo",
    articulo: "el",
    icono: <ClipboardList />,
    permiso: "inventory.adjust",
    consecuencia:
      "Escribe lo que contaste: el sistema calcula la diferencia contra su existencia y te la enseña antes de registrarla como ajuste, con tu nombre y el motivo.",
  },
  ajuste: {
    etiqueta: "Ajuste",
    articulo: "el",
    icono: <Scale />,
    permiso: "inventory.adjust",
    consecuencia:
      "Queda en la auditoría con tu nombre y su motivo. Un ajuste sin motivo no es un ajuste.",
  },
  transferencia: {
    etiqueta: "Transferencia",
    articulo: "la",
    icono: <ArrowLeftRight />,
    permiso: "inventory.transfer",
    consecuencia:
      "Sale y entra en el mismo instante, al costo de origen: no hay estado «en tránsito». Necesitas permiso sobre los dos almacenes.",
  },
};

export function Inventario(): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const navigate = useNavigate();
  const [busqueda, setBusqueda] = useState("");
  const [almacen, setAlmacen] = useState("");
  const [operacion, setOperacion] = useState<Operacion | null>(null);
  const [kardexDe, setKardexDe] = useState<StockBalance | null>(null);
  const qc = useQueryClient();

  const almacenes = useQuery({
    queryKey: ["almacenes", empresa.id],
    queryFn: () => llamar<Warehouse[]>("/v1/warehouses"),
  });

  // El endpoint pagina desde siempre (`page`, `per_page`, `total`) y esta
  // pantalla no le pasaba nada: enseñaba las 50 primeras filas del almacén como
  // si fueran todas, sin decirlo y sin manera de ver el resto.
  const POR_PAGINA = 50;
  const [pagina, setPagina] = useState(1);
  const stock = useQuery({
    queryKey: ["stock", empresa.id, busqueda, almacen, pagina],
    queryFn: () => {
      const p = new URLSearchParams();
      if (busqueda.trim() !== "") p.set("search", busqueda.trim());
      if (almacen !== "") p.set("warehouse_id", almacen);
      p.set("page", String(pagina));
      p.set("per_page", String(POR_PAGINA));
      return llamar<{ items: StockBalance[]; total: number }>(
        `/v1/inventory/stock?${p.toString()}`,
      );
    },
  });

  const recargar = () => {
    void qc.invalidateQueries({ queryKey: ["stock", empresa.id] });
    void qc.invalidateQueries({ queryKey: ["alertas-inv", empresa.id] });
  };

  const columnas = useMemo<ColumnDef<StockBalance, unknown>[]>(
    () => [
      { id: "almacen", header: "Depósito", accessorKey: "warehouse_name" },
      {
        id: "sku",
        header: "SKU",
        accessorKey: "product_sku",
        cell: (c) => <span className="font-mono text-[0.84rem]">{c.getValue<string>()}</span>,
      },
      { id: "producto", header: "Producto", accessorKey: "product_name" },
      {
        id: "lote",
        header: "Lote",
        enableSorting: false,
        accessorFn: (b) => b.lot_code ?? "—",
      },
      {
        id: "cantidad",
        header: () => <span className="block text-right">Cantidad</span>,
        accessorKey: "quantity",
        enableSorting: false,
        cell: (c) => (
          <span className="block text-right font-mono text-[0.84rem]">
            {mostrarCantidad(c.getValue<string>())}
          </span>
        ),
      },
      {
        id: "valor",
        header: () => <span className="block text-right">Valor</span>,
        enableSorting: false,
        accessorKey: "value",
        cell: (c) => (
          <span className="block text-right font-mono text-[0.84rem]">
            {mostrarImporte({ amount: c.row.original.value, currency: c.row.original.currency })}
          </span>
        ),
      },
      {
        id: "costo",
        header: () => <span className="block text-right">Costo unit.</span>,
        enableSorting: false,
        accessorKey: "last_unit_cost",
        cell: (c) => (
          <span className="block text-right font-mono text-[0.84rem]">
            {mostrarImporte({
              amount: c.row.original.last_unit_cost,
              currency: c.row.original.currency,
            })}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div>
      <PageHeader
        title="Inventario"
        description="Existencias al costo promedio ponderado del servidor; cada movimiento es un hecho que no se edita."
        actions={
          <div className="flex flex-wrap gap-2">
            {/* ADR-0048: cada verbo aparece según el rol; el servidor decide. */}
            {(Object.keys(OPERACION) as Operacion[])
              .filter((op) => puede(OPERACION[op].permiso))
              .map((op) => (
                <Button key={op} variant="secondary" size="sm" onClick={() => setOperacion(op)}>
                  {OPERACION[op].icono} {OPERACION[op].etiqueta}
                </Button>
              ))}
          </div>
        }
      />

      {/* Lo que el negocio espera va ANTES de lo que ya tiene: mientras un pedido siga abierto,
          la existencia de esta tabla no es toda la historia (ADR-0066, entrega iii). */}
      <div className="mb-4">
        <PorRecibir />
      </div>

      <Tabs defaultValue="existencias">
        <TabsList className="mb-3">
          <TabsTab value="existencias">Existencias</TabsTab>
          <TabsTab value="alertas">Alertas</TabsTab>
          <TabsTab value="recetas">Recetas</TabsTab>
        </TabsList>

        <TabsPanel value="existencias">
          <DataTable
            columns={columnas}
            data={stock.data?.items}
            error={stock.error === null ? null : errorDePersona(stock.error)}
            onRetry={() => void stock.refetch()}
            onRowClick={setKardexDe}
            density="compact"
            exportCsv={{ filename: `existencias-${sufijoDeArchivo(empresa)}.csv` }}
            pagination={{
              total: stock.data?.total ?? 0,
              page: pagina,
              perPage: POR_PAGINA,
              onPageChange: setPagina,
            }}
            search={{
              value: busqueda,
              // Filtrar y quedarse en la página 7 no enseña nada: se vuelve a la 1.
              onChange: (v) => {
                setBusqueda(v);
                setPagina(1);
              },
              placeholder: "SKU o nombre…",
            }}
            toolbar={
              <div className="w-52">
                <SimpleSelect
                  ariaLabel="Almacén"
                  value={almacen === "" ? "todos" : almacen}
                  onValueChange={(v) => {
                    setAlmacen(v === "todos" ? "" : v);
                    setPagina(1);
                  }}
                  options={[
                    { value: "todos", label: "Todos los almacenes" },
                    ...(almacenes.data ?? []).map((w) => ({
                      value: w.id,
                      label: `${w.code} · ${w.name}`,
                    })),
                  ]}
                />
              </div>
            }
            empty={{
              title: "Sin existencias con ese filtro",
              description:
                "La primera llegada de mercancía abre el kardex del producto — clic en una fila para verlo.",
              ...(puede("inventory.move")
                ? {
                    action: (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => void navigate("/admin/llego-mercancia")}
                      >
                        ¿Te llegó mercancía? Regístrala aquí
                      </Button>
                    ),
                  }
                : {}),
            }}
          />
        </TabsPanel>

        <TabsPanel value="alertas">
          <Alertas />
        </TabsPanel>

        <TabsPanel value="recetas">
          <Recetas almacenes={almacenes.data ?? []} onConsumido={recargar} />
        </TabsPanel>
      </Tabs>

      {operacion !== null && (
        <Movimiento
          operacion={operacion}
          almacenes={almacenes.data ?? []}
          onCerrar={(hecho) => {
            setOperacion(null);
            if (hecho) recargar();
          }}
        />
      )}
      {kardexDe !== null && <Kardex balance={kardexDe} onCerrar={() => setKardexDe(null)} />}
    </div>
  );
}

function Kardex({
  balance,
  onCerrar,
}: {
  balance: StockBalance;
  onCerrar: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  // El kardex de un producto con años de movimientos no cabe en una página:
  // se pagina contra el servidor (`total`) y se dice cuántas hay.
  const POR_PAGINA = 100;
  const [pagina, setPagina] = useState(1);
  const movimientos = useQuery({
    queryKey: ["kardex", empresa.id, balance.product_id, balance.warehouse_id, pagina],
    queryFn: () =>
      llamar<{ items: InventoryMove[]; total: number }>(
        `/v1/inventory/moves?product_id=${balance.product_id}&warehouse_id=${balance.warehouse_id}&per_page=${POR_PAGINA}&page=${pagina}`,
      ),
  });

  const columnas = useMemo<ColumnDef<InventoryMove, unknown>[]>(
    () => [
      {
        id: "fecha",
        header: "Fecha",
        accessorFn: (m) => fechaHoraLocal(m.occurred_at),
      },
      {
        id: "tipo",
        header: "Tipo",
        accessorKey: "kind",
        enableSorting: false,
        cell: (c) => {
          const k = c.getValue<string>();
          return (
            <Badge tone={k === "entrada" ? "accent" : k === "salida" ? "warning" : "neutral"}>
              {TIPO_LEGIBLE[k] ?? k}
            </Badge>
          );
        },
      },
      {
        id: "cantidad",
        header: () => <span className="block text-right">Cantidad</span>,
        enableSorting: false,
        accessorKey: "quantity",
        cell: (c) => (
          <span className="block text-right font-mono text-[0.84rem]">
            {mostrarCantidad(c.getValue<string>())}
          </span>
        ),
      },
      {
        id: "importe",
        header: () => <span className="block text-right">Importe</span>,
        enableSorting: false,
        accessorKey: "functional_amount",
        cell: (c) => {
          const m = c.row.original;
          return (
            <span className="block text-right font-mono text-[0.84rem]">
              {mostrarImporte({ amount: m.functional_amount, currency: m.functional_currency })}
            </span>
          );
        },
      },
      {
        id: "saldo",
        header: () => <span className="block text-right">Saldo</span>,
        enableSorting: false,
        accessorKey: "quantity_after",
        cell: (c) => (
          <span className="block text-right font-mono text-[0.84rem]">
            {mostrarCantidad(c.getValue<string>())}
          </span>
        ),
      },
      {
        id: "valor",
        header: () => <span className="block text-right">Valor acum.</span>,
        enableSorting: false,
        accessorKey: "value_after",
        cell: (c) => {
          const m = c.row.original;
          return (
            <span className="block text-right font-mono text-[0.84rem]">
              {mostrarImporte({ amount: m.value_after, currency: m.functional_currency })}
            </span>
          );
        },
      },
      {
        id: "costo",
        header: () => <span className="block text-right">Costo unit.</span>,
        enableSorting: false,
        accessorKey: "unit_cost",
        cell: (c) => {
          const m = c.row.original;
          return (
            <span className="block text-right font-mono text-[0.84rem]">
              {mostrarImporte({ amount: m.unit_cost, currency: m.functional_currency })}
            </span>
          );
        },
      },
      {
        id: "ref",
        header: "Referencia",
        enableSorting: false,
        accessorFn: (m) =>
          `${m.reference ?? "—"}${m.exit_reason != null ? ` · ${NOMBRE_MOTIVO[m.exit_reason] ?? m.exit_reason}` : ""}${m.reason != null ? ` · ${m.reason}` : ""}`,
        cell: (c) => (
          <span className="block max-w-44 truncate text-[0.82rem] text-muted-foreground">
            {c.getValue<string>()}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-5xl">
        <DialogTitle>
          Kardex — <span className="font-mono">{balance.product_sku}</span> {balance.product_name} ·{" "}
          {balance.warehouse_name}
          {balance.lot_code !== null ? ` · lote ${balance.lot_code}` : ""}
        </DialogTitle>
        <DialogDescription>
          Saldo y costo de cada línea son los que el kardex calculó y guardó al registrar. Un
          movimiento no se edita ni se borra: se corrige con un ajuste nuevo.
        </DialogDescription>
        <div className="mt-3">
          <DataTable
            columns={columnas}
            data={movimientos.data?.items}
            error={movimientos.error === null ? null : errorDePersona(movimientos.error)}
            onRetry={() => void movimientos.refetch()}
            density="compact"
            virtualized
            pagination={{
              total: movimientos.data?.total ?? 0,
              page: pagina,
              perPage: POR_PAGINA,
              onPageChange: setPagina,
            }}
            exportCsv={{ filename: `kardex-${balance.product_sku}.csv` }}
            empty={{
              title: "Sin movimientos",
              description: "El kardex nace con la primera entrada.",
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Movimiento({
  operacion,
  almacenes,
  onCerrar,
}: {
  operacion: Operacion;
  almacenes: Warehouse[];
  onCerrar: (hecho: boolean) => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [producto, setProducto] = useState<EntityOption | null>(null);
  const [form, setForm] = useState({
    warehouse_id: "",
    to_warehouse_id: "",
    quantity: "",
    amount: "",
    currency: "USD",
    reason: "",
    reference: "",
    /** El soporte de una pérdida (RLIVA art. 14): obligatorio en merma, rotura, vencido y faltante. */
    evidence: "",
    /** El lote contado, si el producto se lleva por lotes (el servidor lo exige). */
    lot_id: "",
  });
  const [confirmando, setConfirmando] = useState(false);
  // Los lotes de ESTA posición, para el conteo: se piden al servidor, no se deducen.
  const lotes = useQuery({
    queryKey: ["lotes-conteo", empresa.id, producto?.id, form.warehouse_id],
    enabled: operacion === "conteo" && producto !== null && form.warehouse_id !== "",
    queryFn: () =>
      llamar<{ items: { lot_id: string | null; lot_code: string | null; quantity: string }[] }>(
        `/v1/inventory/stock?product_id=${producto?.id ?? ""}&warehouse_id=${form.warehouse_id}`,
      ),
  });
  const opcionesLote = (lotes.data?.items ?? [])
    .filter((b) => b.lot_id !== null)
    .map((b) => ({ value: b.lot_id ?? "", label: b.lot_code ?? "lote" }));
  const [error, setError] = useState<unknown>(null);
  /** La diferencia del conteo, CALCULADA POR EL SERVIDOR (I-07): la pantalla no resta. */
  const [diferencia, setDiferencia] = useState<{
    system_quantity: string;
    counted: string;
    delta: string;
  } | null>(null);
  const campos = camposDelError(error);

  const def = OPERACION[operacion];
  const cantidadValida =
    operacion === "ajuste"
      ? /^-?\d{1,16}(\.\d{1,8})?$/.test(form.quantity)
      : operacion === "conteo"
        ? /^\d{1,16}(\.\d{1,8})?$/.test(form.quantity)
        : /^\d{1,16}(\.\d{1,8})?$/.test(form.quantity) && /[1-9]/.test(form.quantity);
  const motivoRetiro = MOTIVOS_SALIDA.find((m) => m.value === form.reason)?.retiro === true;
  const motivoPerdida =
    operacion === "salida" && NOMBRE_MOTIVO[form.reason] !== undefined && !motivoRetiro;
  // El faltante de un conteo va a pérdidas y lleva la misma evidencia que la salida «faltante»
  // (RLIVA art. 14). El signo lo dice el servidor en la vista previa: la pantalla no resta.
  const faltanteDeConteo =
    operacion === "conteo" && diferencia !== null && diferencia.delta.startsWith("-");
  const listo =
    producto !== null &&
    form.warehouse_id !== "" &&
    cantidadValida &&
    // La salida exige un motivo DE LA LISTA (ADR-0078 §2); el ajuste y el conteo, uno escrito.
    (operacion === "transferencia" ||
      (operacion === "salida"
        ? NOMBRE_MOTIVO[form.reason] !== undefined &&
          (!motivoPerdida || form.evidence.trim().length >= 3)
        : form.reason.trim().length >= 3)) &&
    (operacion !== "conteo" || opcionesLote.length === 0 || form.lot_id !== "") &&
    (operacion !== "transferencia" ||
      (form.to_warehouse_id !== "" && form.to_warehouse_id !== form.warehouse_id));

  /** El conteo pregunta al servidor la diferencia antes de registrarla. */
  async function calcularDiferencia(): Promise<void> {
    setError(null);
    try {
      const r = await llamar<{ system_quantity: string; counted: string; delta: string }>(
        "/v1/inventory/counts",
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            company_id: empresa.id,
            product_id: producto?.id ?? "",
            warehouse_id: form.warehouse_id,
            counted: form.quantity,
            reason: form.reason.trim(),
            ...(form.lot_id === "" ? {} : { lot_id: form.lot_id }),
            preview: true,
          }),
        },
      );
      setDiferencia(r);
      // Un faltante sin evidencia no se confirma todavía: aparece el campo y se pide.
      if (r.delta.startsWith("-") && form.evidence.trim().length < 3) return;
      setConfirmando(true);
    } catch (e) {
      setError(e);
    }
  }

  async function enviar(): Promise<void> {
    setError(null);
    const comun = {
      company_id: empresa.id,
      product_id: producto?.id ?? "",
      ...(form.reference.trim() === "" ? {} : { reference: form.reference.trim() }),
    };
    try {
      if (operacion === "salida") {
        await llamar("/v1/inventory/issues", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            ...comun,
            warehouse_id: form.warehouse_id,
            quantity: form.quantity,
            reason: form.reason,
            ...(motivoPerdida ? { evidence: form.evidence.trim() } : {}),
          }),
        });
      } else if (operacion === "conteo") {
        let r: { delta: string; move: unknown };
        try {
          r = await llamar<{ delta: string; move: unknown }>("/v1/inventory/counts", {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({
              ...comun,
              warehouse_id: form.warehouse_id,
              counted: form.quantity,
              reason: form.reason.trim(),
              ...(form.lot_id === "" ? {} : { lot_id: form.lot_id }),
              ...(faltanteDeConteo ? { evidence: form.evidence.trim() } : {}),
              // Lo que la persona VIO: si el sistema cambió desde entonces, 409 y se recalcula.
              ...(diferencia !== null
                ? { expected_system_quantity: diferencia.system_quantity }
                : {}),
            }),
          });
        } catch (e) {
          // Solo el 409 que produce «la existencia cambió» (code CONFLICT del conteo): cualquier otro
          // 409 (llave de idempotencia en curso, existencia negativa…) enseña su propio mensaje.
          if (e instanceof LlamadaApiError && e.status === 409 && e.body.code === "CONFLICT") {
            // La existencia cambió: se vuelve a pedir la diferencia y se confirma de nuevo.
            await calcularDiferencia();
            setError(e);
            return;
          }
          throw e;
        }
        // El aviso enseña el delta REAL que devolvió el servidor, no el de la vista previa.
        if (r.move === null) {
          toast.success("Conteo registrado", "Sin diferencia: no se registró ningún ajuste.");
        } else {
          toast.success(
            "Conteo registrado",
            `Ajuste de ${mostrarCantidad(r.delta)} × ${producto?.detalle ?? ""}`,
          );
        }
        onCerrar(true);
        return;
      } else if (operacion === "ajuste") {
        await llamar("/v1/inventory/adjustments", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            ...comun,
            warehouse_id: form.warehouse_id,
            delta: form.quantity,
            reason: form.reason.trim(),
          }),
        });
      } else {
        await llamar("/v1/inventory/transfers", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            ...comun,
            from_warehouse_id: form.warehouse_id,
            to_warehouse_id: form.to_warehouse_id,
            quantity: form.quantity,
          }),
        });
      }
      toast.success(
        `${def.etiqueta} ${def.articulo === "el" ? "registrado" : "registrada"}`,
        `${mostrarCantidad(form.quantity)} × ${producto?.detalle ?? ""}`,
      );
      onCerrar(true);
    } catch (e) {
      // UN solo aviso (I-09): el error vuelve al formulario, que marca el campo rechazado; la
      // confirmación se cierra en vez de repetirlo detrás.
      setError(e);
      setConfirmando(false);
    }
  }

  // Solo los activos para mover mercancía: un depósito apagado no recibe ni despacha (migración 60).
  const opcionesAlmacen = almacenes
    .filter((w) => w.status !== "inactive")
    .map((w) => ({ value: w.id, label: w.name }));
  const nombreDeposito = (id: string): string => almacenes.find((w) => w.id === id)?.name ?? "";

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar(false)}>
      <DialogContent className="max-w-xl">
        <DialogTitle>{def.etiqueta} de existencias</DialogTitle>
        <DialogDescription>{def.consecuencia}</DialogDescription>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Producto" required className="sm:col-span-2">
            {(a) => (
              <EntityPicker
                id={a.id}
                placeholder="SKU o nombre (los compuestos se consumen por receta, no aquí)…"
                value={producto}
                onChange={setProducto}
                buscar={async (q) => {
                  const r = await llamar<{ items: Product[] }>(
                    `/v1/products?search=${encodeURIComponent(q)}&per_page=10`,
                  );
                  return r.items
                    .filter((p) => p.kind === "good" && !p.is_composed)
                    .map((p) => ({ id: p.id, label: p.name, detalle: p.sku }));
                }}
              />
            )}
          </FormField>
          <FormField
            label={operacion === "transferencia" ? "Depósito de origen" : "Depósito"}
            required
          >
            {(a) => (
              <SimpleSelect
                id={a.id}
                value={form.warehouse_id === "" ? null : form.warehouse_id}
                onValueChange={(v) => setForm({ ...form, warehouse_id: v })}
                placeholder="Elige…"
                options={opcionesAlmacen}
              />
            )}
          </FormField>
          {operacion === "transferencia" && (
            <FormField label="Depósito de destino" required>
              {(a) => (
                <SimpleSelect
                  id={a.id}
                  value={form.to_warehouse_id === "" ? null : form.to_warehouse_id}
                  onValueChange={(v) => setForm({ ...form, to_warehouse_id: v })}
                  placeholder="Elige…"
                  options={opcionesAlmacen.filter((o) => o.value !== form.warehouse_id)}
                />
              )}
            </FormField>
          )}
          <FormField
            label={
              operacion === "ajuste"
                ? "Delta (con signo)"
                : operacion === "conteo"
                  ? "Lo que contaste"
                  : "Cantidad"
            }
            required
            error={campos["quantity"] ?? campos["delta"] ?? campos["counted"]}
            {...(operacion === "ajuste"
              ? { hint: "Ej. -3 para faltante, 3 para sobrante. Si contaste, usa «Conteo»." }
              : operacion === "conteo"
                ? { hint: "Lo que hay en el estante. La diferencia la calcula el sistema." }
                : {})}
          >
            {(a) => (
              <Input
                id={a.id}
                aria-invalid={a["aria-invalid"]}
                aria-describedby={a["aria-describedby"]}
                inputMode="decimal"
                className="text-right font-mono"
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              />
            )}
          </FormField>
          {operacion === "salida" && (
            <FormField
              label="Motivo"
              required
              className="sm:col-span-2"
              error={campos["reason"]}
              {...(motivoRetiro
                ? {
                    hint: "Es un retiro (LIVA art. 4.3): si facturas, lleva IVA sobre el precio de venta y una Nota de retiro numerada.",
                  }
                : {})}
            >
              {(a) => (
                <SimpleSelect
                  id={a.id}
                  value={form.reason === "" ? null : form.reason}
                  onValueChange={(v) => setForm({ ...form, reason: v })}
                  placeholder="¿Por qué sale?"
                  options={MOTIVOS_SALIDA.map((m) => ({ value: m.value, label: m.label }))}
                />
              )}
            </FormField>
          )}
          {(motivoPerdida || faltanteDeConteo) && (
            <FormField
              label="Evidencia"
              required
              className="sm:col-span-2"
              error={campos["evidence"]}
              hint={
                faltanteDeConteo
                  ? "El conteo da un faltante: va a pérdidas. Referencia del acta, la foto o el informe que respalda la pérdida (RLIVA art. 14)."
                  : "Referencia del acta, la foto o el informe que respalda la pérdida (RLIVA art. 14)."
              }
            >
              {(a) => (
                <Input
                  id={a.id}
                  aria-invalid={a["aria-invalid"]}
                  aria-describedby={a["aria-describedby"]}
                  value={form.evidence}
                  onChange={(e) => setForm({ ...form, evidence: e.target.value })}
                />
              )}
            </FormField>
          )}
          {operacion === "conteo" && opcionesLote.length > 0 && (
            <FormField label="Lote contado" required error={campos["lot_id"]}>
              {(a) => (
                <SimpleSelect
                  id={a.id}
                  value={form.lot_id === "" ? null : form.lot_id}
                  onValueChange={(v) => setForm({ ...form, lot_id: v })}
                  placeholder="Elige el lote que contaste"
                  options={opcionesLote}
                />
              )}
            </FormField>
          )}
          {(operacion === "ajuste" || operacion === "conteo") && (
            <FormField label="Motivo" required className="sm:col-span-2" error={campos["reason"]}>
              {(a) => (
                <Input
                  id={a.id}
                  aria-invalid={a["aria-invalid"]}
                  aria-describedby={a["aria-describedby"]}
                  placeholder={
                    operacion === "conteo"
                      ? "Obligatorio: conteo de fin de mes, revisión del estante…"
                      : "Obligatorio: queda en la auditoría"
                  }
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                />
              )}
            </FormField>
          )}
          <FormField label="Referencia" className="sm:col-span-2">
            {(a) => (
              <Input
                id={a.id}
                placeholder="Guía, nota de entrega… (opcional)"
                value={form.reference}
                onChange={(e) => setForm({ ...form, reference: e.target.value })}
              />
            )}
          </FormField>
        </div>
        {error !== null && (
          <div className="mt-3">
            <MensajeError error={error} />
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onCerrar(false)}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={!listo}
            onClick={() =>
              operacion === "conteo" ? void calcularDiferencia() : setConfirmando(true)
            }
          >
            {operacion === "conteo"
              ? "Calcular la diferencia…"
              : `Registrar ${def.etiqueta.toLowerCase()}…`}
          </Button>
        </div>

        <ConfirmDialog
          open={confirmando}
          onOpenChange={setConfirmando}
          title={`Registrar ${def.articulo} ${def.etiqueta.toLowerCase()}`}
          confirmLabel={`Registrar ${def.articulo} ${def.etiqueta.toLowerCase()}`}
          onConfirm={enviar}
        >
          {operacion === "conteo" && diferencia !== null ? (
            <>
              {producto?.label ?? "—"} · {nombreDeposito(form.warehouse_id)}. El sistema tiene{" "}
              {mostrarCantidad(diferencia.system_quantity)}; contaste{" "}
              {mostrarCantidad(diferencia.counted)}.{" "}
              {/^-?0+(\.0+)?$/.test(diferencia.delta) ? (
                "No hay diferencia: no se registra ningún ajuste. "
              ) : (
                <>
                  Diferencia: <strong>{mostrarCantidad(diferencia.delta)}</strong>
                  {diferencia.delta.startsWith("-") ? " (faltante)" : " (sobrante)"}.{" "}
                </>
              )}
            </>
          ) : (
            <>
              {mostrarCantidad(form.quantity || "0")} × {producto?.label ?? "—"}
              {operacion === "salida" && NOMBRE_MOTIVO[form.reason] !== undefined
                ? ` · ${NOMBRE_MOTIVO[form.reason]}`
                : ""}
            </>
          )}
          {operacion === "transferencia"
            ? ` · de ${nombreDeposito(form.warehouse_id)} a ${nombreDeposito(form.to_warehouse_id)}`
            : ` · ${nombreDeposito(form.warehouse_id)}`}
          . {def.consecuencia}
        </ConfirmDialog>
      </DialogContent>
    </Dialog>
  );
}

function Alertas(): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const [dias, setDias] = useState("30");
  const [definiendo, setDefiniendo] = useState(false);
  const qc = useQueryClient();

  const alertas = useQuery({
    queryKey: ["alertas-inv", empresa.id, dias],
    queryFn: async () => {
      const [bajo, vencen] = await Promise.all([
        llamar<{ items: LowStockItem[] }>("/v1/inventory/low-stock"),
        llamar<{ items: ExpiringLot[] }>(`/v1/inventory/expiring-lots?days=${dias}`),
      ]);
      return { bajo: bajo.items, vencen: vencen.items };
    },
  });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Por reponer ({alertas.data?.bajo.length ?? 0})</CardTitle>
          {puede("inventory.threshold.manage") && (
            <Button variant="secondary" size="sm" onClick={() => setDefiniendo(true)}>
              Definir umbral…
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {alertas.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : alertas.isError ? (
            <AlertaFallida error={alertas.error} onReintentar={() => void alertas.refetch()} />
          ) : (alertas.data?.bajo ?? []).length === 0 ? (
            <CardDescription>
              Nada por debajo del mínimo. Solo aparecen los productos con umbral definido.
            </CardDescription>
          ) : (
            <ul className="space-y-1.5 text-[0.9rem]">
              {(alertas.data?.bajo ?? []).map((i) => (
                <li
                  key={`${i.warehouse_id}-${i.product_id}`}
                  className="flex items-baseline justify-between gap-2"
                >
                  <span>
                    <span className="font-mono text-[0.82rem]">{i.product_sku}</span>{" "}
                    {i.product_name}
                  </span>
                  <span className="font-mono text-[0.84rem] text-warning-soft-foreground">
                    faltan {mostrarCantidad(i.missing)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Por vencer ({alertas.data?.vencen.length ?? 0})</CardTitle>
          <label className="flex items-center gap-1.5 text-[0.82rem] text-muted-foreground">
            <TimerReset className="size-3.5" /> próximos{" "}
            <Input
              aria-label="Días"
              className="h-6 w-14 text-center"
              value={dias}
              onChange={(e) => setDias(e.target.value.replace(/\D/g, "") || "0")}
            />{" "}
            días
          </label>
        </CardHeader>
        <CardContent>
          {alertas.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : alertas.isError ? (
            <AlertaFallida error={alertas.error} onReintentar={() => void alertas.refetch()} />
          ) : (alertas.data?.vencen ?? []).length === 0 ? (
            <CardDescription>Ningún lote con existencia vence en ese plazo.</CardDescription>
          ) : (
            <ul className="space-y-1.5 text-[0.9rem]">
              {(alertas.data?.vencen ?? []).map((l) => (
                <li
                  key={`${l.lot_id}-${l.warehouse_id}`}
                  className="flex items-baseline justify-between gap-2"
                >
                  <span>
                    <span className="font-mono text-[0.82rem]">{l.lot_code}</span> {l.product_sku} ·
                    vence {fechaLocal(l.expires_at)}
                  </span>
                  {l.days_left < 0 ? (
                    <Badge tone="destructive">vencido hace {String(-l.days_left)} d</Badge>
                  ) : (
                    <Badge tone={l.days_left <= 7 ? "warning" : "neutral"}>{l.days_left} d</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[0.8rem] text-faint-foreground">
            Un lote vencido no se despacha sin el permiso de existencia vencida; entrar sí puede —
            el control es sobre lo que llega al cliente.
          </p>
        </CardContent>
      </Card>

      {definiendo && (
        <DefinirUmbral
          onCerrar={(hecho) => {
            setDefiniendo(false);
            if (hecho) void qc.invalidateQueries({ queryKey: ["alertas-inv", empresa.id] });
          }}
        />
      )}
    </div>
  );
}

/** Una alerta que no pudo consultarse NO es «nada por reponer»: se dice y se reintenta. */
function AlertaFallida({
  error,
  onReintentar,
}: {
  error: unknown;
  onReintentar: () => void;
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <p role="alert" className="text-[0.88rem] text-destructive-soft-foreground">
        No se pudieron consultar las alertas: {errorDePersona(error)}
      </p>
      <Button variant="secondary" size="sm" onClick={onReintentar}>
        Reintentar
      </Button>
    </div>
  );
}

/**
 * UMBRAL DE REPOSICIÓN (Nivel B de la auditoría de superficie): la alerta de
 * «por reponer» decía «solo con umbral definido»… y no había dónde definirlo.
 */
function DefinirUmbral({ onCerrar }: { onCerrar: (hecho: boolean) => void }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [producto, setProducto] = useState<EntityOption | null>(null);
  const [almacen, setAlmacen] = useState<string | null>(null);
  const [minimo, setMinimo] = useState("");
  const [maximo, setMaximo] = useState("");

  const almacenes = useQuery({
    queryKey: ["almacenes", empresa.id],
    queryFn: () => llamar<Warehouse[]>("/v1/warehouses"),
  });
  // El primer almacén se preselecciona cuando LLEGA la lista, en un efecto:
  // un setState durante el render es un render extra y una advertencia.
  const primerAlmacen = almacenes.data?.[0]?.id ?? null;
  useEffect(() => {
    if (primerAlmacen !== null) setAlmacen((actual) => actual ?? primerAlmacen);
  }, [primerAlmacen]);

  const guardar = useMutation({
    mutationFn: () =>
      llamar("/v1/inventory/thresholds", {
        method: "PUT",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          warehouse_id: almacen,
          product_id: producto?.id ?? "",
          stock_min: minimo.trim().replace(",", "."),
          ...(maximo.trim() === "" ? {} : { stock_max: maximo.trim().replace(",", ".") }),
        }),
      }),
    onSuccess: () => {
      toast.success("Umbral definido", "La alerta de reposición ya lo vigila.");
      onCerrar(true);
    },
    onError: (e) => toast.error("No se pudo definir", errorDePersona(e)),
  });

  const listo =
    producto !== null &&
    almacen !== null &&
    /^\d{1,16}(\.\d{1,8})?$/.test(minimo.trim().replace(",", "."));

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar(false)}>
      <DialogContent className="max-w-md">
        <DialogTitle>Definir umbral de reposición</DialogTitle>
        <DialogDescription>
          Cuando la existencia baje del mínimo, el producto aparece en «Por reponer».
        </DialogDescription>
        <div className="space-y-3 pt-2">
          <FormField label="Producto" required>
            {(a) => (
              <EntityPicker
                id={a.id}
                placeholder="SKU o nombre…"
                value={producto}
                onChange={setProducto}
                buscar={async (q) => {
                  const r = await llamar<{ items: Product[] }>(
                    "/v1/products?search=" + encodeURIComponent(q) + "&per_page=10",
                  );
                  return r.items
                    .filter((x) => x.kind === "good")
                    .map((x) => ({ id: x.id, label: x.name, detalle: x.sku }));
                }}
              />
            )}
          </FormField>
          <FormField label="Almacén" required>
            {(a) => (
              <SimpleSelect
                id={a.id}
                value={almacen}
                onValueChange={setAlmacen}
                options={(almacenes.data ?? []).map((w) => ({
                  value: w.id,
                  label: w.code + " · " + w.name,
                }))}
              />
            )}
          </FormField>
          <div className="grid grid-cols-2 gap-2">
            <FormField label="Mínimo" required>
              {(a) => (
                <Input
                  id={a.id}
                  inputMode="decimal"
                  className="text-right font-mono"
                  value={minimo}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMinimo(e.target.value)}
                />
              )}
            </FormField>
            <FormField label="Máximo (opcional)">
              {(a) => (
                <Input
                  id={a.id}
                  inputMode="decimal"
                  className="text-right font-mono"
                  value={maximo}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMaximo(e.target.value)}
                />
              )}
            </FormField>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onCerrar(false)}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={!listo || guardar.isPending}
            onClick={() => guardar.mutate()}
          >
            Guardar umbral
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Recetas({
  almacenes,
  onConsumido,
}: {
  almacenes: Warehouse[];
  onConsumido: () => void;
}): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  const [compuesto, setCompuesto] = useState<EntityOption | null>(null);
  const [almacen, setAlmacen] = useState("");
  const [unidades, setUnidades] = useState("1");
  const [confirmando, setConfirmando] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const receta = useQuery({
    queryKey: ["receta", empresa.id, compuesto?.id, almacen],
    enabled: compuesto !== null && almacen !== "",
    queryFn: () =>
      llamar<{ lines: RecipeLineView[]; estimated_unit_cost: string | null; currency: string }>(
        `/v1/products/${compuesto?.id}/recipe?warehouse_id=${almacen}`,
      ),
  });

  const faltaConversion = (receta.data?.lines ?? []).some(
    (l) => l.quantity_in_product_unit === null,
  );

  async function consumir(): Promise<void> {
    setError(null);
    try {
      const r = await llamar<{ total_cost: string; currency: string; moves: unknown[] }>(
        "/v1/inventory/recipe-consumptions",
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            company_id: empresa.id,
            warehouse_id: almacen,
            product_id: compuesto?.id ?? "",
            quantity: unidades,
          }),
        },
      );
      toast.success(
        "Receta consumida",
        `${String(r.moves.length)} salidas por ${mostrarImporte({ amount: r.total_cost, currency: r.currency })}`,
      );
      onConsumido();
    } catch (e) {
      setError(e);
      throw e;
    }
  }

  const [definiendo, setDefiniendo] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Consumo por receta</CardTitle>
        {puede("product.recipe.manage") && (
          <Button variant="secondary" size="sm" onClick={() => setDefiniendo(true)}>
            Definir receta…
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <CardDescription>
          Un compuesto no tiene existencias propias: consumirlo genera UNA salida por ingrediente,
          todas en el mismo instante y ligadas al mismo documento.
        </CardDescription>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FormField label="Producto compuesto" required>
            {(a) => (
              <EntityPicker
                id={a.id}
                placeholder="Buscar compuesto…"
                value={compuesto}
                onChange={setCompuesto}
                buscar={async (q) => {
                  const r = await llamar<{ items: Product[] }>(
                    `/v1/products?search=${encodeURIComponent(q)}&per_page=10`,
                  );
                  return r.items
                    .filter((p) => p.is_composed)
                    .map((p) => ({ id: p.id, label: p.name, detalle: p.sku }));
                }}
              />
            )}
          </FormField>
          <FormField label="Almacén" required>
            {(a) => (
              <SimpleSelect
                id={a.id}
                value={almacen === "" ? null : almacen}
                onValueChange={setAlmacen}
                placeholder="¿De dónde salen los ingredientes?"
                options={almacenes.map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }))}
              />
            )}
          </FormField>
          <FormField label="Unidades a consumir" required>
            {(a) => (
              <Input
                id={a.id}
                inputMode="decimal"
                className="text-right font-mono"
                value={unidades}
                onChange={(e) => setUnidades(e.target.value)}
              />
            )}
          </FormField>
        </div>

        {compuesto !== null && almacen !== "" && receta.data !== undefined && (
          <div className="rounded-md border border-border bg-surface-muted/40 p-3">
            {receta.data.lines.length === 0 ? (
              <p className="text-[0.88rem] text-muted-foreground">
                Sin receta. Un compuesto sin receta no se puede consumir: no descontaría nada.
              </p>
            ) : (
              <>
                <ul className="space-y-1 text-[0.88rem]">
                  {receta.data.lines.map((l) => (
                    <li key={l.child_product_id} className="flex justify-between gap-2">
                      <span>
                        <span className="font-mono text-[0.8rem]">{l.child_sku}</span>{" "}
                        {l.child_name}
                      </span>
                      <span className="font-mono text-[0.84rem]">
                        {l.quantity_in_product_unit === null ? (
                          <span className="text-warning-soft-foreground">
                            sin conversión {l.unit_code}→{l.product_unit_code}
                          </span>
                        ) : (
                          `${mostrarCantidad(l.quantity_in_product_unit)} ${l.product_unit_code}`
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[0.85rem]">
                  Costo estimado por unidad:{" "}
                  {receta.data.estimated_unit_cost === null ? (
                    <span className="text-warning-soft-foreground">
                      no calculable — falta una conversión
                    </span>
                  ) : (
                    <span className="font-mono">
                      {mostrarImporte({
                        amount: receta.data.estimated_unit_cost,
                        currency: receta.data.currency,
                      })}
                    </span>
                  )}
                  <span className="ml-1 text-[0.78rem] text-faint-foreground">
                    (el real será la suma de las salidas al ejecutarse)
                  </span>
                </p>
              </>
            )}
          </div>
        )}

        {error !== null && <MensajeError error={error} />}

        {/* Consumir genera salidas de inventario: el servidor exige
            `inventory.move` (recipe-consumptions → issueStockBatch). */}
        {puede("inventory.move") && (
          <Button
            variant="primary"
            disabled={
              compuesto === null ||
              almacen === "" ||
              faltaConversion ||
              (receta.data?.lines ?? []).length === 0
            }
            onClick={() => setConfirmando(true)}
          >
            Consumir receta…
          </Button>
        )}

        {definiendo && (
          <DefinirReceta
            onCerrar={(compuestoId) => {
              setDefiniendo(false);
              // La receta guardada se vuelve a leer: la que estaba en caché
              // era la anterior, y consumir con ella descontaría lo viejo.
              if (compuestoId !== null) {
                void qc.invalidateQueries({ queryKey: ["receta", empresa.id, compuestoId] });
              }
            }}
          />
        )}

        <ConfirmDialog
          open={confirmando}
          onOpenChange={setConfirmando}
          title="Consumir la receta"
          confirmLabel="Consumir la receta"
          onConfirm={consumir}
        >
          {mostrarCantidad(unidades)} × {compuesto?.label}. Se genera una salida POR INGREDIENTE,
          ninguna se puede editar ni borrar después; el compuesto no se descuenta a sí mismo.
        </ConfirmDialog>
      </CardContent>
    </Card>
  );
}

/**
 * DEFINIR LA RECETA (Nivel B de la auditoría de superficie): consumirla
 * existía; crearla o corregirla, no. La receta se reemplaza ENTERA — una
 * receta a medias no es una receta (contrato del servidor).
 */
interface LineaReceta {
  /** Estable desde que nace: quitar la segunda línea no reasigna el estado de la tercera. */
  id: string;
  ingrediente: EntityOption | null;
  quantity: string;
  unit_code: string;
}
function lineaNueva(): LineaReceta {
  return { id: crypto.randomUUID(), ingrediente: null, quantity: "", unit_code: "unidad" };
}

function DefinirReceta({
  onCerrar,
}: {
  /** El id del compuesto cuya receta se guardó; null si se canceló. */
  onCerrar: (compuestoId: string | null) => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [compuesto, setCompuesto] = useState<EntityOption | null>(null);
  const [lineas, setLineas] = useState<LineaReceta[]>(() => [lineaNueva()]);
  const [error, setError] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);

  const unidades = useQuery({
    queryKey: ["unidades"],
    staleTime: 300_000,
    queryFn: () => llamar<{ code: string; name: string }[]>("/v1/units"),
  });

  const validas = lineas.filter(
    (l) => l.ingrediente !== null && l.quantity.trim() !== "" && l.unit_code !== "",
  );
  const listo = compuesto !== null && validas.length > 0;

  async function guardar(): Promise<void> {
    setError(null);
    setOcupado(true);
    try {
      await llamar("/v1/products/" + (compuesto?.id ?? "") + "/recipe", {
        method: "PUT",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          lines: validas.map((l) => ({
            child_product_id: l.ingrediente!.id,
            quantity: l.quantity.trim().replace(",", "."),
            unit_code: l.unit_code,
          })),
        }),
      });
      toast.success("Receta guardada", "Reemplaza a la anterior por completo.");
      onCerrar(compuesto?.id ?? null);
    } catch (e) {
      setError(e);
      toast.error("No se pudo guardar la receta");
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar(null)}>
      <DialogContent className="max-w-xl">
        <DialogTitle>Definir la receta</DialogTitle>
        <DialogDescription>
          Cuánto de cada ingrediente consume UNA unidad del compuesto. Guardar reemplaza la receta
          anterior entera; lo ya consumido no cambia.
        </DialogDescription>
        <div className="space-y-3 pt-2">
          <FormField label="Producto compuesto" required>
            {(a) => (
              <EntityPicker
                id={a.id}
                placeholder="Buscar compuesto…"
                value={compuesto}
                onChange={setCompuesto}
                buscar={async (q) => {
                  const r = await llamar<{ items: Product[] }>(
                    "/v1/products?search=" + encodeURIComponent(q) + "&per_page=10",
                  );
                  return r.items
                    .filter((x) => x.is_composed)
                    .map((x) => ({ id: x.id, label: x.name, detalle: x.sku }));
                }}
              />
            )}
          </FormField>
          <div className="space-y-2">
            {lineas.map((l, i) => (
              <div key={l.id} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <EntityPicker
                    placeholder="Ingrediente…"
                    value={l.ingrediente}
                    onChange={(v) =>
                      setLineas((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, ingrediente: v } : x)),
                      )
                    }
                    buscar={async (q) => {
                      const r = await llamar<{ items: Product[] }>(
                        "/v1/products?search=" + encodeURIComponent(q) + "&per_page=10",
                      );
                      return r.items
                        .filter((x) => x.kind === "good" && !x.is_composed)
                        .map((x) => ({ id: x.id, label: x.name, detalle: x.sku }));
                    }}
                  />
                </div>
                <Input
                  aria-label="Cantidad por unidad"
                  placeholder="Cant."
                  inputMode="decimal"
                  className="w-20 text-right font-mono"
                  value={l.quantity}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setLineas((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)),
                    )
                  }
                />
                <div className="w-32">
                  <SimpleSelect
                    ariaLabel="Unidad del ingrediente"
                    value={l.unit_code}
                    onValueChange={(v) =>
                      setLineas((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, unit_code: v } : x)),
                      )
                    }
                    options={(unidades.data ?? []).map((u) => ({
                      value: u.code,
                      label: u.name,
                    }))}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="iconSm"
                  aria-label="Quitar ingrediente"
                  disabled={lineas.length <= 1}
                  onClick={() => setLineas((prev) => prev.filter((_, j) => j !== i))}
                >
                  ×
                </Button>
              </div>
            ))}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setLineas((prev) => [...prev, lineaNueva()])}
            >
              Otro ingrediente
            </Button>
          </div>
          {error !== null && <MensajeError error={error} />}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onCerrar(null)} disabled={ocupado}>
            Cancelar
          </Button>
          <Button variant="primary" disabled={!listo || ocupado} onClick={() => void guardar()}>
            {ocupado ? "Guardando…" : "Guardar la receta"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
