import { useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSesion } from "../../app/session.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DateRangePicker, FormField } from "../../components/forms.js";
import { Button } from "../../ui/button.js";
import { Badge } from "../../ui/badge.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card.js";
import { Skeleton } from "../../ui/card.js";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "../../ui/table.js";
import { useToast } from "../../ui/toast.js";
import { mostrarImporte } from "../../money.js";
import { mostrarPorcentaje } from "../../porcentaje.js";
import { fechaLocal } from "../../fechas.js";
import { MensajeError } from "../ventas/comunes.js";
import { IGTF_PERCEPCIONES } from "../../components/capa-fiscal/textos.js";
import { errorDePersona, type IgtfPerceptions, type IgtfStatus } from "../../lib.js";

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
  // L-15: la quincena en curso la calcula el SERVIDOR (CLAUDE.md §7: cero reglas tributarias en
  // la web). Mientras el usuario no elija otra, se usa la que trae el estado.
  const [elegido, setRango] = useState<{ from: string; to: string } | null>(null);
  const estado = useQuery({
    queryKey: ["igtf-status", empresa.id],
    queryFn: () => llamar<IgtfStatus>("/v1/igtf/status"),
  });
  const rango = elegido ?? estado.data?.fortnight ?? { from: "", to: "" };

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
      ) : estado.data.perceiving !== true ? (
        <NoPercibe estado={estado.data} />
      ) : (
        <div className="space-y-4">
          <Absorcion estado={estado.data} />
          <Instrumentos estado={estado.data} />
          <Card>
            <CardContent className="flex flex-wrap items-end gap-3 pt-4">
              <FormField label="Quincena">
                {() => (
                  <DateRangePicker from={rango.from} to={rango.to} onChange={(r) => setRango(r)} />
                )}
              </FormField>
              {/* L-15: el vencimiento lo da el servidor desde el calendario (PA SNAT/2025/000091). */}
              {rango.from === estado.data.fortnight.from && (
                <p className="text-[0.85rem] text-muted-foreground">
                  {estado.data.fortnight.due.status === "secondary_source" &&
                  estado.data.fortnight.due.date !== null
                    ? `Esta quincena vence el ${fechaLocal(estado.data.fortnight.due.date)}.`
                    : estado.data.fortnight.due.status === "pending_review"
                      ? "El vencimiento de esta quincena está pendiente de cotejo en el calendario: no se muestra una fecha sin confirmar."
                      : "No hay calendario cargado para esta quincena: consulta el vencimiento con tu asesor."}
                </p>
              )}
            </CardContent>
          </Card>
          {/* La clave reinicia la página al cambiar la quincena. */}
          <Percepciones key={`${rango.from}_${rango.to}`} desde={rango.from} hasta={rango.to} />
        </div>
      )}
    </div>
  );
}

/**
 * Re-revisión 7: la percepción NO se activa. Percibe quien el SENIAT designó sujeto pasivo
 * especial, desde la notificación de la providencia, según el tipo DECLARADO (ADR-0072 §1-2). Aquí
 * solo se explica y se lleva a declarar el tipo.
 */
function NoPercibe({ estado }: { estado: IgtfStatus | undefined }): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Esta empresa no percibe IGTF hoy</CardTitle>
        <CardDescription>
          Percibe IGTF quien el SENIAT designó sujeto pasivo especial, desde la fecha de
          notificación de la providencia. Ladino lo sabe por el tipo de contribuyente que
          declaraste: si eres especial, declara el tipo con esa fecha y la percepción empieza sola.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {estado?.rate !== null && estado?.rate !== undefined && (
          <p className="text-[0.88rem] text-muted-foreground">
            Regla vigente: <strong>{mostrarPorcentaje(estado.rate)}</strong>. {estado.legal_source}
          </p>
        )}
        <Link
          to="/admin/configuracion"
          className="text-[0.9rem] font-medium text-accent underline-offset-2 hover:underline"
        >
          Declarar el tipo de contribuyente (Configuración → Mi empresa)
        </Link>
      </CardContent>
    </Card>
  );
}

/**
 * F-05: quién paga el IGTF. Por omisión el cliente (la caja lo suma al total); si la empresa lo
 * asume, el cliente paga el documento justo y el IGTF se asienta como gasto. Se entera igual.
 */
function Absorcion({ estado }: { estado: IgtfStatus }): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [enviando, setEnviando] = useState(false);
  async function cambiar(valor: boolean): Promise<void> {
    setError(null);
    setEnviando(true);
    try {
      await llamar("/v1/company-settings", {
        method: "PUT",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ absorb_igtf: valor }),
      });
      toast.success(valor ? "La empresa asume el IGTF" : "El cliente paga el IGTF");
      await qc.invalidateQueries({ queryKey: ["igtf-status", empresa.id] });
    } catch (e) {
      setError(e);
    } finally {
      setEnviando(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Quién paga el IGTF</CardTitle>
        <CardDescription>
          {estado.absorbs
            ? "La empresa lo asume: el cliente paga el documento justo y el IGTF se registra como gasto. Se entera igual."
            : "El cliente: la caja lo suma al total a pagar en divisas. Si el cliente entrega solo el documento, lo que falta queda pendiente."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <MensajeError error={error} />
        {puede(PERMISO_CONFIGURAR) && (
          <Button
            variant="secondary"
            disabled={enviando}
            onClick={() => void cambiar(!estado.absorbs)}
          >
            {estado.absorbs ? "Que lo pague el cliente" : "Que lo asuma la empresa"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Qué forma de pago causa IGTF (auditoría fiscal, PA SNAT/2022/000013 art. 1): pagos en divisas o
 * criptoactivos SIN mediación de instituciones financieras. Es data de la plataforma con su fuente
 * (el servidor la sirve); la empresa no la cambia. Aquí solo se enseña: sin interruptores.
 */
function Instrumentos({ estado }: { estado: IgtfStatus }): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Qué forma de pago causa IGTF</CardTitle>
        <CardDescription>
          Un sujeto pasivo especial percibe {tasaTexto(estado)} en los pagos en divisas o
          criptoactivos que recibe sin mediación de instituciones financieras (PA SNAT/2022/000013
          art. 1). La lista la fija la norma, no la empresa; cada forma de pago dice su fuente.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <THead>
            <TR>
              <TH>Forma de pago</TH>
              <TH className="text-right">¿Causa IGTF?</TH>
            </TR>
          </THead>
          <TBody>
            {estado.instruments.map((i) => (
              <TR key={i.instrument}>
                <TD>
                  {ROTULO[i.instrument] ?? i.instrument}
                  {i.legal_source != null && (
                    <span className="block text-[0.78rem] text-muted-foreground">
                      {i.legal_source}
                    </span>
                  )}
                </TD>
                <TD className="text-right">
                  <Badge tone={i.causes ? "warning" : "neutral"}>
                    {i.causes ? "Sí, en divisas" : "No"}
                  </Badge>
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
          {IGTF_PERCEPCIONES.descripcion}
          {/* Las dos cifras vienen del servidor (platform.igtf_period_totals): aquí no se suma. */}
          {(datos.pending_refund_count ?? 0) > 0 &&
            datos.pending_refund_functional !== undefined && (
              <>
                {" "}
                <strong>
                  {IGTF_PERCEPCIONES.pendienteDeReintegro(
                    mostrarImporte({
                      amount: datos.pending_refund_functional,
                      currency: datos.functional_currency,
                    }),
                    datos.pending_refund_count ?? 0,
                  )}
                </strong>
              </>
            )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {pendientes.length > 0 && (
          <p
            role="alert"
            className="mb-3 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-[0.88rem] text-warning-soft-foreground"
          >
            {IGTF_PERCEPCIONES.avisoPendientes(pendientes.length, paginas > 1)}
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
