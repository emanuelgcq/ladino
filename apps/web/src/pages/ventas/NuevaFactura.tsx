import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { CreateInvoiceRequest } from "@ladino/schemas";
import { useSesion } from "../../app/session.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DualMoney } from "../../components/DualMoney.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { FormField, EntityPicker, type EntityOption } from "../../components/forms.js";
import { Button } from "../../ui/button.js";
import { Input } from "../../ui/input.js";
import { SimpleSelect } from "../../ui/select.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card.js";
import { useToast } from "../../ui/toast.js";
import { mostrarImporte } from "../../money.js";
import { MensajeError } from "./comunes.js";

/**
 * Alta de factura. Dos botones con PESO DISTINTO a propósito (UX no
 * negociable): «Guardar cotización» es secundario y reversible; «Emitir
 * factura» es primario, pasa por confirmación con las consecuencias y no
 * tiene vuelta atrás.
 *
 * Los números: el precio de cada línea es el VIGENTE de la lista según el
 * SERVIDOR (platform.price_at, con la fecha explícita), y los totales los
 * calcula el servidor — la cotización es exactamente eso: el documento de
 * cálculo previo que el negocio ya tiene, con sus totales de verdad. Esta
 * pantalla no suma ni un céntimo (apps/web/CLAUDE.md).
 */
interface LineaForm {
  clave: string;
  producto: EntityOption | null;
  quantity: string;
}

interface DocumentoCreado {
  id: string;
  series: string;
  document_number: number | null;
  transaction_currency: string;
  functional_currency: string;
  fx_rate: string;
  rate_source: string;
  subtotal_amount: string;
  tax_amount: string;
  total_amount: string;
}

const nuevaLinea = (): LineaForm => ({
  clave: crypto.randomUUID(),
  producto: null,
  quantity: "1",
});

export function NuevaFactura(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const navigate = useNavigate();
  const toast = useToast();

  const [cliente, setCliente] = useState<EntityOption | null>(null);
  const [listaId, setListaId] = useState<string>("");
  const [almacenId, setAlmacenId] = useState<string>("");
  const [lineas, setLineas] = useState<LineaForm[]>([nuevaLinea()]);
  const [error, setError] = useState<unknown>(null);
  const [erroresCampo, setErroresCampo] = useState<Record<string, string>>({});
  const [cotizacion, setCotizacion] = useState<DocumentoCreado | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [ocupado, setOcupado] = useState(false);

  const listas = useQuery({
    queryKey: ["listas", empresa.id],
    queryFn: () =>
      llamar<{ id: string; name: string; currency_code: string; status: string }[]>(
        "/v1/price-lists",
      ),
  });
  const almacenes = useQuery({
    queryKey: ["almacenes", empresa.id],
    queryFn: () => llamar<{ id: string; code: string; name: string }[]>("/v1/warehouses"),
  });

  // La lista preferida del cliente manda por defecto; cambiarla exige el
  // permiso sales.price_list.override y el servidor lo verifica — aquí solo
  // se avisa de que es una atribución, no una preferencia de pantalla.
  const clienteDetalle = useQuery({
    queryKey: ["cliente", empresa.id, cliente?.id],
    enabled: cliente !== null,
    queryFn: () => llamar<{ default_price_list_id: string | null }>(`/v1/customers/${cliente?.id}`),
  });
  useEffect(() => {
    const porDefecto = clienteDetalle.data?.default_price_list_id;
    if (porDefecto != null) setListaId(porDefecto);
  }, [clienteDetalle.data]);

  useEffect(() => {
    const a = almacenes.data;
    if (a !== undefined && a.length === 1) setAlmacenId(a[0]?.id ?? "");
  }, [almacenes.data]);

  const listaElegida = listas.data?.find((l) => l.id === listaId);
  const listaDelCliente = clienteDetalle.data?.default_price_list_id ?? null;
  const cambioDeLista = listaDelCliente !== null && listaId !== "" && listaId !== listaDelCliente;

  const buscarProducto = useCallback(
    async (q: string): Promise<EntityOption[]> => {
      const r = await llamar<{ items: { id: string; name: string; sku: string }[] }>(
        `/v1/products?search=${encodeURIComponent(q)}&per_page=8`,
      );
      return r.items.map((p) => ({ id: p.id, label: p.name, detalle: p.sku }));
    },
    [llamar],
  );

  function cuerpo(): unknown {
    return {
      company_id: empresa.id,
      customer_id: cliente?.id ?? "",
      ...(listaId === "" ? {} : { price_list_id: listaId }),
      lines: lineas
        .filter((l) => l.producto !== null)
        .map((l) => ({ product_id: l.producto?.id ?? "", quantity: l.quantity.trim() })),
    };
  }

  function validar(conAlmacen: boolean): boolean {
    setErroresCampo({});
    const errores: Record<string, string> = {};
    if (cliente === null) errores["cliente"] = "Elige el cliente.";
    if (conAlmacen && almacenId === "") errores["almacen"] = "Elige el almacén que despacha.";
    if (lineas.every((l) => l.producto === null)) errores["lineas"] = "Añade al menos un producto.";
    // El MISMO esquema Zod del contrato (packages/schemas), reutilizado aquí.
    const parsed = CreateInvoiceRequest.safeParse(
      conAlmacen ? { ...(cuerpo() as object), warehouse_id: almacenId } : undefined,
    );
    if (conAlmacen && !parsed.success && Object.keys(errores).length === 0) {
      errores["lineas"] = parsed.error.issues[0]?.message ?? "Revisa los datos.";
    }
    setErroresCampo(errores);
    return Object.keys(errores).length === 0;
  }

  async function guardarCotizacion(): Promise<void> {
    if (!validar(false)) return;
    setError(null);
    setOcupado(true);
    try {
      const q = await llamar<DocumentoCreado>("/v1/quotes", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(cuerpo()),
      });
      setCotizacion(q);
      toast.success("Cotización guardada", "Totales calculados por el servidor.");
    } catch (e) {
      setError(e);
    } finally {
      setOcupado(false);
    }
  }

  async function emitir(): Promise<void> {
    setError(null);
    try {
      const doc = await llamar<DocumentoCreado>("/v1/invoices", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ ...(cuerpo() as object), warehouse_id: almacenId }),
      });
      toast.success(
        `Factura ${doc.series}-${String(doc.document_number ?? "")} emitida`,
        "Kardex descargado y asiento generado en la misma transacción.",
      );
      void navigate(`/ventas/${doc.id}`);
    } catch (e) {
      setError(e);
      toast.error("No se pudo emitir");
    }
  }

  return (
    <div>
      <PageHeader
        title="Nueva factura"
        description="El precio vigente lo dice la lista en el servidor; los totales, la cotización o la emisión."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Cliente y condiciones</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <FormField label="Cliente" required error={erroresCampo["cliente"]}>
                {(a) => (
                  <EntityPicker
                    id={a.id}
                    ariaInvalid={a["aria-invalid"]}
                    ariaDescribedby={a["aria-describedby"]}
                    placeholder="Buscar por nombre o RIF…"
                    value={cliente}
                    onChange={(v) => {
                      setCliente(v);
                      setCotizacion(null);
                    }}
                    buscar={async (q) => {
                      const r = await llamar<{
                        items: { id: string; legal_name: string; tax_id: string | null }[];
                      }>(`/v1/customers?search=${encodeURIComponent(q)}&per_page=8`);
                      return r.items.map((c) => ({
                        id: c.id,
                        label: c.legal_name,
                        ...(c.tax_id === null ? {} : { detalle: c.tax_id }),
                      }));
                    }}
                  />
                )}
              </FormField>
              <FormField
                label="Lista de precios"
                {...(cambioDeLista
                  ? {
                      hint: "Distinta a la preferida del cliente: exige el permiso sales.price_list.override.",
                    }
                  : {})}
              >
                {(a) => (
                  <SimpleSelect
                    id={a.id}
                    value={listaId === "" ? null : listaId}
                    onValueChange={(v) => {
                      setListaId(v);
                      setCotizacion(null);
                    }}
                    placeholder="Preferida del cliente"
                    options={(listas.data ?? [])
                      .filter((l) => l.status === "active")
                      .map((l) => ({ value: l.id, label: `${l.name} (${l.currency_code})` }))}
                  />
                )}
              </FormField>
              <FormField label="Almacén" required error={erroresCampo["almacen"]}>
                {(a) => (
                  <SimpleSelect
                    id={a.id}
                    value={almacenId === "" ? null : almacenId}
                    onValueChange={setAlmacenId}
                    placeholder="¿De dónde sale?"
                    options={(almacenes.data ?? []).map((w) => ({
                      value: w.id,
                      label: `${w.code} — ${w.name}`,
                    }))}
                  />
                )}
              </FormField>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Líneas</CardTitle>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setLineas((ls) => [...ls, nuevaLinea()])}
              >
                <Plus /> Añadir línea
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {erroresCampo["lineas"] !== undefined && (
                <p role="alert" className="text-[0.85rem] text-destructive-soft-foreground">
                  {erroresCampo["lineas"]}
                </p>
              )}
              {lineas.map((l, i) => (
                <LineaEditor
                  key={l.clave}
                  linea={l}
                  listaId={listaId === "" ? listaDelCliente : listaId}
                  monedaLista={listaElegida?.currency_code ?? null}
                  buscarProducto={buscarProducto}
                  onChange={(nueva) => {
                    setCotizacion(null);
                    setLineas((ls) => ls.map((x, j) => (j === i ? nueva : x)));
                  }}
                  onQuitar={
                    lineas.length > 1 ? () => setLineas((ls) => ls.filter((_, j) => j !== i)) : null
                  }
                />
              ))}
            </CardContent>
          </Card>

          {error !== null && <MensajeError error={error} />}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Totales</CardTitle>
            </CardHeader>
            <CardContent>
              {cotizacion === null ? (
                <p className="text-[0.88rem] text-muted-foreground">
                  Los totales los calcula el servidor. Guarda la cotización para verlos con la
                  alícuota y la tasa vigentes — esta pantalla no suma dinero.
                </p>
              ) : (
                <div className="space-y-1.5 text-[0.9rem]">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span className="font-mono">
                      {mostrarImporte({
                        amount: cotizacion.subtotal_amount,
                        currency: cotizacion.functional_currency,
                      })}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">IVA</span>
                    <span className="font-mono">
                      {mostrarImporte({
                        amount: cotizacion.tax_amount,
                        currency: cotizacion.functional_currency,
                      })}
                    </span>
                  </div>
                  <div className="my-2 h-px bg-border" />
                  <div className="flex items-baseline justify-between">
                    <span className="font-medium">Total</span>
                    <DualMoney
                      amount={cotizacion.total_amount}
                      currency={cotizacion.functional_currency}
                      rate={
                        cotizacion.transaction_currency === cotizacion.functional_currency
                          ? null
                          : {
                              rate: cotizacion.fx_rate,
                              source: `${cotizacion.rate_source} · doc. en ${cotizacion.transaction_currency}`,
                            }
                      }
                    />
                  </div>
                  <p className="pt-1 text-[0.78rem] text-faint-foreground">
                    Según cotización guardada — la emisión recalcula con las reglas de su fecha.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex flex-col gap-2">
            {/* Peso visual distinto A PROPÓSITO: guardar es reversible, emitir no. */}
            <Button variant="secondary" disabled={ocupado} onClick={() => void guardarCotizacion()}>
              Guardar cotización
            </Button>
            <Button
              variant="primary"
              size="lg"
              disabled={ocupado}
              onClick={() => {
                if (validar(true)) setConfirmando(true);
              }}
            >
              Emitir factura…
            </Button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmando}
        onOpenChange={setConfirmando}
        title="Emitir la factura"
        confirmLabel="Emitir la factura"
        onConfirm={emitir}
      >
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            Se asigna el <strong>correlativo fiscal</strong> y no se libera nunca, ni anulando.
          </li>
          <li>La mercancía se descarga del almacén elegido en la misma operación.</li>
          <li>El asiento contable se genera y postea junto con la factura.</li>
          <li>
            Una factura emitida <strong>no se edita ni se borra</strong>: se corrige con nota de
            crédito.
          </li>
        </ul>
      </ConfirmDialog>
    </div>
  );
}

function LineaEditor({
  linea,
  listaId,
  monedaLista,
  buscarProducto,
  onChange,
  onQuitar,
}: {
  linea: LineaForm;
  listaId: string | null;
  monedaLista: string | null;
  buscarProducto: (q: string) => Promise<EntityOption[]>;
  onChange: (l: LineaForm) => void;
  onQuitar: (() => void) | null;
}): React.JSX.Element {
  const { llamar } = useSesion();
  // El precio VIGENTE según el servidor (platform.price_at) con fecha explícita.
  const precio = useQuery({
    queryKey: ["precio", listaId, linea.producto?.id],
    enabled: listaId !== null && linea.producto !== null,
    queryFn: () =>
      llamar<{ vigente: { amount: string; currency: string } | null }>(
        `/v1/price-lists/${listaId}/prices?product_id=${linea.producto?.id}&at=${encodeURIComponent(
          new Date().toISOString(),
        )}`,
      ),
  });
  const vigente = precio.data?.vigente ?? null;

  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <EntityPicker
          placeholder="Producto (nombre o SKU)…"
          value={linea.producto}
          onChange={(v) => onChange({ ...linea, producto: v })}
          buscar={buscarProducto}
        />
      </div>
      <Input
        aria-label="Cantidad"
        inputMode="decimal"
        className="w-20 text-right font-mono"
        value={linea.quantity}
        onChange={(e) => onChange({ ...linea, quantity: e.target.value })}
      />
      <div className="flex h-8 w-32 items-center justify-end font-mono text-[0.84rem] text-muted-foreground">
        {linea.producto === null || listaId === null ? (
          <span className="text-faint-foreground">—</span>
        ) : precio.isPending ? (
          "…"
        ) : vigente !== null ? (
          mostrarImporte(vigente)
        ) : (
          <span
            className="text-warning-soft-foreground"
            title={`Sin precio vigente en la lista${monedaLista === null ? "" : ` (${monedaLista})`}`}
          >
            sin precio
          </span>
        )}
      </div>
      <Button
        variant="ghost"
        size="iconSm"
        aria-label="Quitar línea"
        disabled={onQuitar === null}
        onClick={onQuitar ?? undefined}
      >
        <Trash2 />
      </Button>
    </div>
  );
}
