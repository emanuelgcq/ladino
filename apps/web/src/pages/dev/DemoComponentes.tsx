import { useState } from "react";
import { Package, Wallet } from "lucide-react";
import { PageHeader } from "../../components/PageHeader.js";
import { DualMoney } from "../../components/DualMoney.js";
import { FiscalStatusBadge } from "../../components/FiscalStatusBadge.js";
import { ExchangeDiffIndicator } from "../../components/ExchangeDiffIndicator.js";
import { KpiCard } from "../../components/KpiCard.js";
import { EmptyState } from "../../components/EmptyState.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import {
  DatePicker,
  DateRangePicker,
  EntityPicker,
  FormField,
  MoneyInput,
  type EntityOption,
} from "../../components/forms.js";
import { Button } from "../../ui/button.js";
import { Badge } from "../../ui/badge.js";
import { Input } from "../../ui/input.js";
import { SimpleSelect } from "../../ui/select.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card.js";
import { useToast } from "../../ui/toast.js";

/**
 * /dev/components — cada componente fundamental, aislado y con datos de
 * MENTIRA EVIDENTE (importes redondos, «Cliente de ejemplo»): esta página
 * existe para VER los componentes, no para confundirse con datos reales.
 * Solo se registra en desarrollo (nav.ts la marca devOnly).
 */
export function DemoComponentes(): React.JSX.Element {
  const toast = useToast();
  const [confirmar, setConfirmar] = useState(false);
  const [importe, setImporte] = useState("1234.50");
  const [fecha, setFecha] = useState("2026-08-15");
  const [rango, setRango] = useState({ from: "2026-08-01", to: "2026-08-31" });
  const [entidad, setEntidad] = useState<EntityOption | null>(null);
  const [opcion, setOpcion] = useState<string | null>("b");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Componentes del sistema"
        description="La familia completa, aislada. Si algo se ve mal aquí, se verá mal en los 12 módulos."
      />

      <Seccion titulo="DualMoney — la firma">
        <div className="flex flex-wrap items-end gap-8">
          <DualMoney
            variant="kpi"
            amount="125000.00000000"
            currency="VES"
            secondary={{ amount: "1000.00000000", currency: "USD" }}
            rate={{ rate: "125.00000000", source: "BCV", timestamp: "2026-08-31T10:00:00Z" }}
          />
          <DualMoney
            variant="inline"
            amount="1000.00000000"
            currency="USD"
            secondary={{ amount: "125000.00000000", currency: "VES" }}
            rate={{ rate: "125.00000000", source: "BCV" }}
          />
          <div className="w-40 rounded-sm border border-border p-2">
            <DualMoney
              variant="cell"
              amount="86.10000000"
              currency="USD"
              secondary={{ amount: "10762.50000000", currency: "VES" }}
            />
          </div>
        </div>
      </Seccion>

      <Seccion titulo="FiscalStatusBadge — el vocabulario de estados">
        <div className="flex flex-wrap gap-2">
          {[
            "draft",
            "confirmed",
            "issued",
            "paid",
            "annulled",
            "cancelled",
            "queued",
            "pending_accounting",
            "no_rule",
          ].map((e) => (
            <FiscalStatusBadge key={e} estado={e} />
          ))}
        </div>
      </Seccion>

      <Seccion titulo="ExchangeDiffIndicator — ganancia esmeralda, pérdida ámbar">
        <div className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
          <ExchangeDiffIndicator
            variant="detail"
            difference="1250.00000000"
            currency="VES"
            rateIssue="120.00000000"
            ratePayment="125.00000000"
          />
          <ExchangeDiffIndicator
            variant="detail"
            difference="-830.00000000"
            currency="VES"
            rateIssue="125.00000000"
            ratePayment="121.00000000"
          />
          <ExchangeDiffIndicator variant="detail" difference="0" currency="VES" />
        </div>
        <p className="mt-2">
          Inline: <ExchangeDiffIndicator difference="1250.00000000" currency="VES" /> ·{" "}
          <ExchangeDiffIndicator difference="-830.00000000" currency="VES" />
        </p>
      </Seccion>

      <Seccion titulo="KpiCard">
        <div className="grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiCard
            title="Ventas del mes"
            icon={Wallet}
            value={<DualMoney variant="kpi" amount="450000.00000000" currency="VES" />}
            delta={{ direction: "up", label: "mes anterior: Bs 380.000,00", positiveIsGood: true }}
            spark={[{ v: 2 }, { v: 5 }, { v: 3 }, { v: 8 }, { v: 6 }, { v: 9 }]}
          />
          <KpiCard
            title="Cobros pendientes"
            value={<span className="font-mono text-[1.55rem] font-semibold">7 facturas</span>}
            delta={{ direction: "up", label: "2 más que ayer", positiveIsGood: false }}
          />
          <KpiCard title="Cargando" value={null} loading />
        </div>
      </Seccion>

      <Seccion titulo="Formularios — FormField, MoneyInput, DatePicker, EntityPicker">
        <div className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Importe" required hint="Hasta 16 enteros y 8 decimales.">
            {(a) => <MoneyInput id={a.id} value={importe} onChange={setImporte} currency="VES" />}
          </FormField>
          <FormField label="Con error" error="Este mensaje viene de Zod o del servidor.">
            {(a) => <Input id={a.id} aria-invalid={a["aria-invalid"]} />}
          </FormField>
          <FormField label="Fecha">
            {(a) => <DatePicker id={a.id} value={fecha} onChange={setFecha} />}
          </FormField>
          <FormField label="Período">
            {() => <DateRangePicker from={rango.from} to={rango.to} onChange={setRango} />}
          </FormField>
          <FormField label="EntityPicker (fuente simulada)">
            {(a) => (
              <EntityPicker
                id={a.id}
                value={entidad}
                onChange={setEntidad}
                placeholder="Busca «a»…"
                buscar={(q) =>
                  Promise.resolve(
                    [
                      { id: "1", label: "Cliente de ejemplo A", detalle: "J-11111111-1" },
                      { id: "2", label: "Cliente de ejemplo B", detalle: "J-22222222-2" },
                    ].filter((c) => c.label.toLowerCase().includes(q.toLowerCase())),
                  )
                }
              />
            )}
          </FormField>
          <FormField label="SimpleSelect">
            {(a) => (
              <SimpleSelect
                id={a.id}
                value={opcion}
                onValueChange={setOpcion}
                options={[
                  { value: "a", label: "Opción A" },
                  { value: "b", label: "Opción B" },
                ]}
              />
            )}
          </FormField>
        </div>
      </Seccion>

      <Seccion titulo="EmptyState, ConfirmDialog y Toast">
        <div className="max-w-md space-y-3">
          <EmptyState
            icon={Package}
            title="Sin productos todavía"
            description="El catálogo vacío no es un error: es el punto de partida."
            action={
              <Button variant="primary" size="sm">
                Crear el primero
              </Button>
            }
          />
          <div className="flex gap-2">
            <Button variant="destructive" onClick={() => setConfirmar(true)}>
              Acción irreversible…
            </Button>
            <Button
              variant="secondary"
              onClick={() => toast.success("Operación completada", "Con su descripción.")}
            >
              Toast éxito
            </Button>
            <Button
              variant="ghost"
              onClick={() => toast.warning("Cuidado", "Ámbar: advertencia, no error.")}
            >
              Toast aviso
            </Button>
          </div>
        </div>
        <ConfirmDialog
          open={confirmar}
          onOpenChange={setConfirmar}
          title="Anular el documento de ejemplo"
          confirmLabel="Anular"
          destructive
          onConfirm={() => {
            toast.info("Era un ejemplo");
            return Promise.resolve();
          }}
        >
          El correlativo se conserva, el inventario se repone y el asiento se reversa. Esto no se
          puede deshacer.
        </ConfirmDialog>
      </Seccion>

      <Seccion titulo="Badges y botones">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">neutral</Badge>
          <Badge tone="accent">accent</Badge>
          <Badge tone="warning">warning</Badge>
          <Badge tone="destructive">destructive</Badge>
          <Badge tone="info">info</Badge>
          <Badge tone="outline">outline</Badge>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary">Primario</Button>
          <Button variant="secondary">Secundario</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Fantasma</Button>
          <Button variant="destructive">Destructivo</Button>
          <Button variant="primary" disabled>
            Deshabilitado
          </Button>
        </div>
      </Seccion>
    </div>
  );
}

function Seccion({
  titulo,
  children,
}: {
  titulo: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{titulo}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
