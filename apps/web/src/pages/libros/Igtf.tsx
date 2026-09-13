import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DateRangePicker, FormField } from "../../components/forms.js";
import { Button } from "../../ui/button.js";
import { Badge } from "../../ui/badge.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card.js";
import { Skeleton } from "../../ui/card.js";
import { Switch } from "../../ui/switch.js";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "../../ui/table.js";
import { Textarea } from "../../ui/input.js";
import { useToast } from "../../ui/toast.js";
import { mostrarImporte } from "../../money.js";
import { mostrarPorcentaje } from "../../porcentaje.js";
import { MensajeError } from "../ventas/comunes.js";
import { errorDePersona, type IgtfPerceptions, type IgtfStatus } from "../../lib.js";
import { quincenaLocal } from "../../fechas.js";

/** El permiso REAL que exigen enable / instruments / taxpayer-type (packages/domain/src/igtf.ts). */
const PERMISO_CONFIGURAR = "company.settings.manage";

/** Cuántas filas trae cada página de percepciones (el default del servidor). */
const POR_PAGINA = 50;

/**
 * La tasa VIGENTE, como texto, o una frase honesta mientras no se sabe. El
 * «3 %» que antes iba escrito a mano en tres sitios es una regla efectiva por
 * fecha y fuente (CLAUDE.md §1.8): la manda el servidor y aquí solo se enseña.
 */
function tasaTexto(estado: IgtfStatus | undefined): string {
  return estado?.rate === null || estado?.rate === undefined
    ? "la tasa vigente"
    : `el ${mostrarPorcentaje(estado.rate)}`;
}

/**
 * IGTF — la percepción a la tasa vigente (migración 46).
 *
 * Lo que la pantalla tiene que dejar claro, porque el error es caro en las dos
 * direcciones: percibir de más es cobrarle al cliente un impuesto que no
 * causó; percibir de menos deja al agente respondiendo con su patrimonio.
 * Por eso el catálogo de instrumentos es editable y avisa de sus dos casos
 * incómodos —`otro`, y la ausencia de exenciones cargadas— en vez de decidir
 * en silencio.
 */
function quincenaActual(): { from: string; to: string } {
  // La quincena del día de CARACAS, no del día UTC (CLAUDE.md §3).
  const q = quincenaLocal();
  return { from: q.desde, to: q.hasta };
}

const ROTULO: Record<string, string> = {
  efectivo_bs: "Efectivo en bolívares",
  efectivo_usd: "Efectivo en divisas",
  zelle: "Zelle",
  usdt: "USDT",
  transferencia: "Transferencia",
  punto_venta: "Punto de venta",
  pago_movil: "Pago móvil",
  tarjeta: "Tarjeta",
  cashea: "Cashea",
  otro: "Otro",
};

export function Igtf(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const [rango, setRango] = useState(quincenaActual());
  const estado = useQuery({
    queryKey: ["igtf-status", empresa.id],
    queryFn: () => llamar<IgtfStatus>("/v1/igtf/status"),
  });

  return (
    <div>
      <PageHeader
        title="IGTF"
        description={`Lo que un sujeto pasivo especial percibe en los pagos en divisas (${tasaTexto(estado.data)}). Se calcula en el servidor, pago por pago, y se entera quincenalmente.`}
      />
      {estado.isPending ? (
        <Skeleton className="h-64" />
      ) : estado.isError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-[0.88rem] text-destructive-soft-foreground"
        >
          <span>{errorDePersona(estado.error)}</span>
          <Button variant="secondary" size="sm" onClick={() => void estado.refetch()}>
            Reintentar
          </Button>
        </div>
      ) : estado.data.enabled !== true ? (
        <Activacion estado={estado.data} />
      ) : (
        <div className="space-y-4">
          <Instrumentos estado={estado.data} />
          <Card>
            <CardContent className="flex flex-wrap items-end gap-3 pt-4">
              <FormField label="Quincena">
                {() => (
                  <DateRangePicker from={rango.from} to={rango.to} onChange={(r) => setRango(r)} />
                )}
              </FormField>
            </CardContent>
          </Card>
          {/* La clave reinicia la página al cambiar la quincena. */}
          <Percepciones key={`${rango.from}_${rango.to}`} desde={rango.from} hasta={rango.to} />
        </div>
      )}
    </div>
  );
}

function Activacion({ estado }: { estado: IgtfStatus | undefined }): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  // Que la pantalla esconda el botón no es control de acceso (el servidor lo
  // repite); es no ofrecer un acto que va a fallar.
  const puedeConfigurar = puede(PERMISO_CONFIGURAR);
  const [acta, setActa] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [enviando, setEnviando] = useState(false);
  const [clasificando, setClasificando] = useState(false);

  async function activar(): Promise<void> {
    setError(null);
    setEnviando(true);
    try {
      await llamar<IgtfStatus>("/v1/igtf/enable", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id, reason: acta }),
      });
      toast.success("Percepción activada", "Desde ahora, cada pago en divisas que cause percibe.");
      await qc.invalidateQueries({ queryKey: ["igtf-status", empresa.id] });
    } catch (e) {
      setError(e);
    } finally {
      setEnviando(false);
    }
  }

  /**
   * La CLASIFICACIÓN de la empresa (2026-09-10). Activar el IGTF exige ser
   * sujeto pasivo especial, y hasta ahora, si no lo eras, el botón fallaba con
   * un mensaje y NO había pantalla en toda la aplicación donde corregirlo: el
   * endpoint existía sin puerta. La puerta va aquí, que es donde se topa uno
   * con el requisito.
   */
  async function marcarEspecial(): Promise<void> {
    setError(null);
    setClasificando(true);
    try {
      await llamar("/v1/companies/taxpayer-type", {
        method: "PUT",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id, taxpayer_type_code: "especial" }),
      });
      toast.success(
        "Empresa clasificada como sujeto pasivo especial",
        "Queda en la auditoría con su valor anterior. Ya puedes activar la percepción.",
      );
      await qc.invalidateQueries({ queryKey: ["igtf-status", empresa.id] });
      // La empresa de la sesión (`useSesion().empresa`) no vive en una query
      // de TanStack — la carga session.tsx por su cuenta y no expone una
      // recarga—, así que no hay clave que invalidar: el `taxpayer_type` nuevo
      // se verá en la sesión al recargarla. Lo que esta pantalla necesita
      // (`igtf-status`) sí se invalida arriba.
    } catch (e) {
      setError(e);
    } finally {
      setClasificando(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>La percepción está apagada</CardTitle>
        <CardDescription>
          Solo percibe IGTF quien el SENIAT designó sujeto pasivo especial. Si es tu caso, actívala
          y deja escrito por qué: esa nota queda en la auditoría con la providencia citada.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <MensajeError error={error} />
        {estado?.rate !== null && estado?.rate !== undefined && (
          <p className="text-[0.88rem] text-muted-foreground">
            Regla vigente: <strong>{mostrarPorcentaje(estado.rate)}</strong>. {estado.legal_source}
          </p>
        )}
        {!puedeConfigurar ? (
          <p className="text-[0.88rem] text-muted-foreground">
            Activarla, o clasificar la empresa, exige el permiso{" "}
            <code className="text-[0.82rem]">{PERMISO_CONFIGURAR}</code>. Pídeselo a quien
            administra la empresa.
          </p>
        ) : (
          <>
            <div className="rounded-md border border-border bg-surface-muted px-3 py-2">
              <p className="text-[0.88rem]">
                ¿El SENIAT designó a esta empresa <strong>sujeto pasivo especial</strong> y aún no
                está marcada así en Ladino?
              </p>
              <Button
                variant="secondary"
                className="mt-2"
                onClick={() => void marcarEspecial()}
                disabled={clasificando || enviando}
              >
                {clasificando ? "Guardando…" : "Marcarla como sujeto pasivo especial"}
              </Button>
            </div>
            <FormField label="Por qué esta empresa percibe (queda en la auditoría)">
              {(a) => (
                <Textarea
                  id={a.id}
                  value={acta}
                  rows={3}
                  placeholder="Ej.: Designada sujeto pasivo especial según notificación del SENIAT del …"
                  onChange={(e) => setActa(e.target.value)}
                />
              )}
            </FormField>
            <Button
              onClick={() => void activar()}
              disabled={enviando || clasificando || acta.trim().length < 10}
            >
              <ShieldCheck className="mr-2 h-4 w-4" />
              Activar la percepción
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Instrumentos({ estado }: { estado: IgtfStatus }): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  // Mientras un cambio viaja, los interruptores se bloquean: dos clics
  // seguidos sobre el mismo mandaban dos PUT con dos claves distintas.
  const [cambiando, setCambiando] = useState(false);
  const puedeConfigurar = puede(PERMISO_CONFIGURAR);

  async function cambiar(instrument: string, causes: boolean): Promise<void> {
    setError(null);
    setCambiando(true);
    try {
      await llamar("/v1/igtf/instruments", {
        method: "PUT",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id, instrument, causes }),
      });
      toast.success(
        causes
          ? `${ROTULO[instrument] ?? instrument} ahora causa`
          : `${ROTULO[instrument] ?? instrument} ya no causa`,
        "Aplica a los cobros siguientes; lo ya percibido no cambia.",
      );
      await qc.invalidateQueries({ queryKey: ["igtf-status", empresa.id] });
    } catch (e) {
      setError(e);
    } finally {
      setCambiando(false);
    }
  }

  const otroCausa = estado.instruments.find((i) => i.instrument === "otro")?.causes === true;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Qué forma de pago causa IGTF</CardTitle>
        <CardDescription>
          Solo causa un pago en moneda distinta a la de tus libros. De esos, marca los que de verdad
          son una transacción en divisas.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <MensajeError error={error} />
        <p
          role="note"
          className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-[0.88rem] text-warning-soft-foreground"
        >
          Ladino no trae cargada ninguna exención del IGTF: mientras no las cargue tu asesor, todo
          pago que encaje aquí <strong>percibe</strong>. Y «Otro» viene apagado a propósito — bajo
          ese nombre suele esconderse un pago en bolívares, y percibirle {tasaTexto(estado)} sería
          cobrarle al cliente un impuesto que no causó.
          {otroCausa && (
            <>
              {" "}
              <strong>Lo tienes encendido:</strong> revisa que ahí solo entren pagos en divisas.
            </>
          )}
        </p>
        {!puedeConfigurar && (
          <p className="text-[0.85rem] text-muted-foreground">
            Cambiar el catálogo exige el permiso{" "}
            <code className="text-[0.82rem]">{PERMISO_CONFIGURAR}</code>: aquí se ve, no se toca.
          </p>
        )}
        <Table>
          <THead>
            <TR>
              <TH>Forma de pago</TH>
              <TH className="text-right">Causa IGTF</TH>
            </TR>
          </THead>
          <TBody>
            {estado.instruments.map((i) => (
              <TR key={i.instrument}>
                <TD>{ROTULO[i.instrument] ?? i.instrument}</TD>
                <TD className="text-right">
                  <Switch
                    checked={i.causes}
                    disabled={cambiando || !puedeConfigurar}
                    aria-label={`${ROTULO[i.instrument] ?? i.instrument} causa IGTF`}
                    onCheckedChange={(v) => void cambiar(i.instrument, v)}
                  />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Percepciones({ desde, hasta }: { desde: string; hasta: string }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const [pagina, setPagina] = useState(1);
  // El servidor pagina (default 50) y manda `total`; el importe a enterar lo
  // suma sobre TODAS las filas, así que la cabecera es completa aunque la
  // tabla sea una página.
  const percepciones = useQuery({
    queryKey: ["igtf-percepciones", empresa.id, desde, hasta, pagina],
    queryFn: () =>
      llamar<IgtfPerceptions & { total: number }>(
        `/v1/igtf/perceptions?from=${desde}&to=${hasta}&per_page=${POR_PAGINA}&page=${pagina}`,
      ),
  });

  if (percepciones.isPending) return <Skeleton className="h-48" />;
  if (percepciones.isError) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-[0.88rem] text-destructive-soft-foreground"
      >
        <span>{errorDePersona(percepciones.error)}</span>
        <Button variant="secondary" size="sm" onClick={() => void percepciones.refetch()}>
          Reintentar
        </Button>
      </div>
    );
  }
  const datos = percepciones.data;
  const paginas = Math.max(1, Math.ceil(datos.total / POR_PAGINA));
  const pendientes = datos.items.filter((p) => p.status === "pendiente_reintegro");

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          A enterar esta quincena:{" "}
          {mostrarImporte({
            amount: datos.total_functional,
            currency: datos.functional_currency,
          })}
        </CardTitle>
        <CardDescription>
          Una fila por cobro que causó. Lo pendiente de reintegro —facturas anuladas después de
          percibir— se lista, pero no se suma: ese dinero se le devuelve al cliente, no al fisco.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {pendientes.length > 0 && (
          <p
            role="alert"
            className="mb-3 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-[0.88rem] text-warning-soft-foreground"
          >
            {pendientes.length === 1
              ? "Hay 1 percepción pendiente de reintegro"
              : `Hay ${pendientes.length} percepciones pendientes de reintegro`}
            {paginas > 1 ? " en esta página" : ""}: su factura se anuló después de cobrarla. Habla
            con tu contador antes de devolver.
          </p>
        )}
        {datos.items.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground">
            Ningún cobro causó IGTF en esta quincena.
          </p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Cuándo</TH>
                <TH className="text-right">Base del pago</TH>
                <TH className="text-right">Percibido</TH>
                <TH className="text-right">En tus libros</TH>
                <TH>Estado</TH>
              </TR>
            </THead>
            <TBody>
              {datos.items.map((p) => (
                <TR key={p.id}>
                  <TD>{new Date(p.occurred_at).toLocaleString()}</TD>
                  <TDNum>{mostrarImporte({ amount: p.base_amount, currency: p.currency })}</TDNum>
                  <TDNum>{mostrarImporte({ amount: p.amount, currency: p.currency })}</TDNum>
                  <TDNum>
                    {mostrarImporte({
                      amount: p.functional_amount,
                      currency: datos.functional_currency,
                    })}
                  </TDNum>
                  <TD>
                    {p.status === "percibido" ? (
                      <Badge tone="accent">percibido</Badge>
                    ) : (
                      <Badge tone="warning" title={p.status_reason ?? undefined}>
                        por reintegrar
                      </Badge>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {paginas > 1 && (
          <div className="mt-3 flex items-center justify-between text-[0.82rem] text-muted-foreground">
            <span>
              {datos.total} cobros · página {pagina} de {paginas}
            </span>
            <span className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={pagina <= 1}
                onClick={() => setPagina(pagina - 1)}
              >
                Anterior
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={pagina >= paginas}
                onClick={() => setPagina(pagina + 1)}
              >
                Siguiente
              </Button>
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
