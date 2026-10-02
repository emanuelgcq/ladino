import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSesion } from "../app/session.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { SimpleSelect } from "../ui/select.js";
import { Badge } from "../ui/badge.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card.js";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "../ui/table.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../ui/dialog.js";
import { useToast } from "../ui/toast.js";
import { DatePicker, FormField } from "./forms.js";
import { mostrarImporte } from "../money.js";
import { errorDePersona } from "../lib.js";
import { abrirPdf } from "../pdf.js";
import { hoyLocal, fechaLocal } from "../fechas.js";

/**
 * RETENCIÓN DE IVA QUE PRACTICAMOS (ADR-0072 §3 y §4; H-01, H-04). Sin reglas aquí: la retención la
 * practica el SERVIDOR al registrar la factura de una empresa agente. La pantalla solo deja decir
 * las dos cosas que la persona sabe y el servidor no: que la compra está EXCLUIDA (art. 3, catálogo
 * del servidor, con motivo) o que va al 100 % (art. 5, con su supuesto).
 */
export type EleccionRetencion =
  | { tipo: "normal" }
  | { tipo: "total"; motivo: string }
  | { tipo: "excluida"; codigo: string; motivo: string };

const SUPUESTOS_100 = [
  { value: "iva_no_discriminado", label: "El IVA no viene discriminado en la factura" },
  { value: "factura_sin_requisitos", label: "La factura no cumple los requisitos" },
  { value: "indicado_por_portal", label: "El portal del SENIAT lo indica" },
  { value: "proveedor_sin_rif", label: "El proveedor no está inscrito en el RIF" },
  { value: "operaciones_art_2", label: "Metales o piedras preciosas (operaciones del art. 2)" },
];

/** Si la empresa es agente (especial). El servidor lo decide por la fecha; esto solo enseña el campo. */
export function useEsAgente(): boolean {
  const { empresa } = useSesion();
  return empresa.taxpayer_type_code === "especial";
}

/** El fragmento del cuerpo de la factura para la elección (vacío si es lo normal). */
export function cuerpoRetencionIva(e: EleccionRetencion): Record<string, unknown> {
  if (e.tipo === "total") return { iva_retention_full_reason: e.motivo };
  if (e.tipo === "excluida") {
    return { retention_exclusion: { code: e.codigo, reason: e.motivo.trim() } };
  }
  return {};
}

/** Lista para enviar: la exclusión necesita código y un motivo de al menos 10 caracteres. */
export function eleccionCompleta(e: EleccionRetencion): boolean {
  if (e.tipo === "total") return e.motivo !== "";
  if (e.tipo === "excluida") return e.codigo !== "" && e.motivo.trim().length >= 10;
  return true;
}

export function RetencionIvaCampos({
  valor,
  onCambio,
}: {
  valor: EleccionRetencion;
  onCambio: (v: EleccionRetencion) => void;
}): React.JSX.Element | null {
  const { llamar } = useSesion();
  const agente = useEsAgente();
  const catalogo = useQuery({
    queryKey: ["retention-exclusions"],
    enabled: agente && valor.tipo === "excluida",
    queryFn: () =>
      llamar<{ items: { code: string; description: string; legal_article: string }[] }>(
        "/v1/retention-exclusions",
      ),
  });
  if (!agente) return null;
  return (
    <div className="space-y-2 rounded-md border p-3">
      <FormField
        label="Retención de IVA"
        hint="Eres agente de retención: el sistema retiene solo el 75 % del IVA. Cambia esto solo si la compra está excluida o va al 100 %."
      >
        {(a) => (
          <SimpleSelect
            id={a.id}
            value={valor.tipo}
            onValueChange={(v) =>
              onCambio(
                v === "total"
                  ? { tipo: "total", motivo: "" }
                  : v === "excluida"
                    ? { tipo: "excluida", codigo: "", motivo: "" }
                    : { tipo: "normal" },
              )
            }
            options={[
              { value: "normal", label: "Se retiene lo normal (lo dice la regla)" },
              { value: "total", label: "Se retiene el 100 % (art. 5)" },
              { value: "excluida", label: "La compra está excluida (art. 3)" },
            ]}
          />
        )}
      </FormField>
      {valor.tipo === "total" && (
        <FormField label="¿Por qué el 100 %?" required>
          {(a) => (
            <SimpleSelect
              id={a.id}
              value={valor.motivo === "" ? null : valor.motivo}
              onValueChange={(v) => onCambio({ tipo: "total", motivo: v })}
              options={SUPUESTOS_100}
            />
          )}
        </FormField>
      )}
      {valor.tipo === "excluida" && (
        <>
          <FormField label="Exclusión" required>
            {(a) => (
              <SimpleSelect
                id={a.id}
                value={valor.codigo === "" ? null : valor.codigo}
                onValueChange={(v) => onCambio({ ...valor, codigo: v })}
                options={(catalogo.data?.items ?? []).map((x) => ({
                  value: x.code,
                  label: `${x.description} (${x.legal_article})`,
                }))}
                placeholder={catalogo.isPending ? "Cargando…" : "Elige la exclusión…"}
              />
            )}
          </FormField>
          <FormField label="Motivo" required hint="Queda en la auditoría. Mínimo 10 caracteres.">
            {(a) => (
              <Input
                id={a.id}
                value={valor.motivo}
                onChange={(e) => onCambio({ ...valor, motivo: e.target.value })}
              />
            )}
          </FormField>
        </>
      )}
    </div>
  );
}

interface FilaComprobante {
  id: string;
  voucher_number: string;
  version_no: number;
  mode: string;
  issued_on: string;
  delivery_due_on: string;
  delivered_on: string | null;
  supplier_name: string;
  supplier_tax_id: string;
  status: "issued" | "annulled";
  total_retained: string;
  functional_currency: string;
}

/** Comprobantes de retención emitidos: lista, PDF, entrega, corrección y el modo por quincena. */
export function ComprobantesRetencion(): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  const puedeEmitir = puede("retention.receipt.issue");
  const puedeAjustar = puede("company.settings.manage");
  const [entregar, setEntregar] = useState<FilaComprobante | null>(null);
  const [corregir, setCorregir] = useState<FilaComprobante | null>(null);
  const lista = useQuery({
    queryKey: ["retention-vouchers", empresa.id],
    queryFn: () => llamar<{ items: FilaComprobante[] }>("/v1/retention-vouchers"),
  });
  const refrescar = (): void => {
    void qc.invalidateQueries({ queryKey: ["retention-vouchers", empresa.id] });
  };

  async function modo(m: string): Promise<void> {
    try {
      await llamar("/v1/retention-vouchers/settings", {
        method: "PUT",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id, mode: m }),
      });
      toast.success(
        "Listo",
        m === "per_fortnight"
          ? "Un comprobante por quincena y proveedor."
          : "Un comprobante por operación.",
      );
    } catch (e) {
      toast.error("No se pudo cambiar", errorDePersona(e));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Comprobantes de retención de IVA</CardTitle>
        <CardDescription>
          Se emiten solos al registrar la factura (PA SNAT/2025/000054 art. 16). Entrégalos a más
          tardar el día que dice «Entregar antes de».
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {puedeAjustar && (
          <div className="flex items-center gap-2 text-[0.9rem]">
            <span>Un comprobante por:</span>
            <Button variant="ghost" onClick={() => void modo("per_operation")}>
              operación
            </Button>
            <Button variant="ghost" onClick={() => void modo("per_fortnight")}>
              quincena y proveedor
            </Button>
          </div>
        )}
        <Table>
          <THead>
            <TR>
              <TH>Comprobante</TH>
              <TH>Proveedor</TH>
              <TH>Emitido</TH>
              <TH>Entregar antes de</TH>
              <TH>Entregado</TH>
              <TH>IVA retenido</TH>
              <TH>Estado</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {(lista.data?.items ?? []).map((v) => (
              <TR key={v.id}>
                <TD className="font-mono">
                  {v.voucher_number}
                  {v.version_no > 1 ? ` (v${v.version_no})` : ""}
                </TD>
                <TD>{v.supplier_name}</TD>
                <TD>{fechaLocal(v.issued_on)}</TD>
                <TD>{fechaLocal(v.delivery_due_on)}</TD>
                <TD>{v.delivered_on === null ? "—" : fechaLocal(v.delivered_on)}</TD>
                <TDNum>
                  {mostrarImporte({ amount: v.total_retained, currency: v.functional_currency })}
                </TDNum>
                <TD>
                  <Badge>{v.status === "annulled" ? "Anulado" : "Vigente"}</Badge>
                </TD>
                <TD className="space-x-1 whitespace-nowrap">
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void abrirPdf(`/v1/retention-vouchers/${v.id}/pdf`, empresa.id, (m) =>
                        toast.error("No se pudo abrir el PDF", m),
                      )
                    }
                  >
                    PDF
                  </Button>
                  {puedeEmitir && v.status === "issued" && v.delivered_on === null && (
                    <Button variant="ghost" onClick={() => setEntregar(v)}>
                      Anotar entrega
                    </Button>
                  )}
                  {puedeEmitir && v.status === "issued" && (
                    <Button variant="ghost" onClick={() => setCorregir(v)}>
                      Corregir
                    </Button>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
        {lista.data?.items.length === 0 && (
          <p className="text-[0.9rem] text-muted-foreground">Todavía no hay comprobantes.</p>
        )}
      </CardContent>
      {entregar !== null && (
        <AccionComprobante
          titulo={`Entrega del ${entregar.voucher_number}`}
          descripcion="El día que el proveedor recibió el comprobante. Se anota una vez."
          campo="fecha"
          onCerrar={() => setEntregar(null)}
          onEnviar={async (valor) => {
            await llamar(`/v1/retention-vouchers/${entregar.id}/delivery`, {
              method: "POST",
              headers: { "Idempotency-Key": crypto.randomUUID() },
              body: JSON.stringify({ company_id: empresa.id, delivered_on: valor }),
            });
            toast.success("Entrega anotada");
            refrescar();
          }}
        />
      )}
      {corregir !== null && (
        <AccionComprobante
          titulo={`Corregir el ${corregir.voucher_number}`}
          descripcion="Se emite una versión nueva con número nuevo, con los datos de hoy del proveedor; la actual queda anulada."
          campo="motivo"
          onCerrar={() => setCorregir(null)}
          onEnviar={async (valor) => {
            await llamar(`/v1/retention-vouchers/${corregir.id}/corrections`, {
              method: "POST",
              headers: { "Idempotency-Key": crypto.randomUUID() },
              body: JSON.stringify({ company_id: empresa.id, reason: valor.trim() }),
            });
            toast.success("Comprobante corregido");
            refrescar();
          }}
        />
      )}
    </Card>
  );
}

function AccionComprobante({
  titulo,
  descripcion,
  campo,
  onCerrar,
  onEnviar,
}: {
  titulo: string;
  descripcion: string;
  campo: "fecha" | "motivo";
  onCerrar: () => void;
  onEnviar: (valor: string) => Promise<void>;
}): React.JSX.Element {
  const toast = useToast();
  const [valor, setValor] = useState(campo === "fecha" ? hoyLocal() : "");
  const [ocupado, setOcupado] = useState(false);
  const listo = campo === "fecha" ? valor !== "" : valor.trim().length >= 10;
  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-md">
        <DialogTitle>{titulo}</DialogTitle>
        <DialogDescription>{descripcion}</DialogDescription>
        <div className="pt-2">
          {campo === "fecha" ? (
            <FormField label="Fecha de entrega" required>
              {(a) => <DatePicker id={a.id} value={valor} onChange={setValor} />}
            </FormField>
          ) : (
            <FormField label="Motivo" required hint="Mínimo 10 caracteres. Queda en la auditoría.">
              {(a) => <Input id={a.id} value={valor} onChange={(e) => setValor(e.target.value)} />}
            </FormField>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={!listo || ocupado}
            onClick={() => {
              setOcupado(true);
              onEnviar(valor)
                .then(onCerrar)
                .catch((e: unknown) => toast.error("No se pudo", errorDePersona(e)))
                .finally(() => setOcupado(false));
            }}
          >
            {ocupado ? "Guardando…" : "Guardar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
