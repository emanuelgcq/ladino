import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../ui/button.js";
import { Input } from "../../ui/input.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { useSesion } from "../../app/session.js";
import { useToast } from "../../ui/toast.js";

/**
 * EL TIPO DE CONTRIBUYENTE DE LA EMPRESA (QA de pantalla 2026-09-15, h. 62).
 *
 * Sin él, una empresa con RIF no podía registrar ni una compra: el servidor no sabe si el IVA
 * que paga es crédito fiscal o costo, y ninguna pantalla lo preguntaba (solo IGTF, y solo para
 * «especial»). Vive en la capa fiscal: una empresa sin RIF no lo ve nunca.
 *
 * Ladino no decide cuál es: lo declara el dueño, con su contador. Lo que dice cada opción es
 * cómo la TRATA Ladino hoy, no una cita de ley:
 *   · ordinario y especial recuperan el IVA de compra (purchases.ts) — VALIDAR-TRIBUTARIO P-17;
 *   · especial percibe IGTF: Ley IGTF art. 4.6 y PA SNAT/2022/000013 arts. 1-2 (IGTF_SPEC.md);
 *   · formal lleva el IVA de compra al costo — VALIDAR-TRIBUTARIO P-17 (sin artículo citado).
 *
 * ADR-0072 §1 (A-03, B-07): el tipo TIENE VIGENCIA. Cada cambio abre una vigencia nueva con acta
 * en una historia append-only; el especial pide la fecha de notificación de la providencia y rige
 * desde ella (o desde la que diga la providencia). «Formal» se OCULTA mientras la periodicidad de
 * la PA 1677 esté pendiente de fuente (P-38): el servidor lo acepta, la pantalla no lo ofrece.
 * Sin tipo vigente, una empresa con RIF no factura (TAXPAYER_TYPE_REQUIRED).
 */
/** P-38: «formal» no se ofrece hasta tener la fuente de su periodicidad. */
const OCULTOS = new Set(["formal"]);
const OPCIONES: readonly { value: string; titulo: string; detalle: string }[] = [
  {
    value: "ordinario",
    titulo: "Ordinario",
    detalle: "Cobras IVA, declaras cada mes y el IVA de tus compras es crédito fiscal.",
  },
  {
    value: "especial",
    titulo: "Especial",
    detalle:
      "El SENIAT te notificó que eres sujeto pasivo especial: además retienes IVA y percibes IGTF.",
  },
  {
    value: "formal",
    titulo: "Formal",
    detalle: "Contribuyente formal: el IVA de tus compras no es crédito fiscal, va al costo.",
  },
];

export const NOMBRE_TIPO_CONTRIBUYENTE: Record<string, string> = {
  ordinario: "Ordinario",
  especial: "Especial",
  formal: "Formal",
  no_contribuyente: "No contribuyente",
  no_sujeto: "No sujeto",
  no_domiciliado: "No domiciliado",
};

export function TipoDeContribuyente({
  actual,
  onCambio,
}: {
  /** El tipo declarado, o null si falta. */
  actual: string | null;
  onCambio: () => void;
}): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const toast = useToast();
  const [elegido, setElegido] = useState<string | null>(null);
  const [notificado, setNotificado] = useState("");
  const [desde, setDesde] = useState("");
  const [acta, setActa] = useState("");
  const puedeCambiar = puede("company.settings.manage");
  // La vigencia actual (desde cuándo rige): la sirve el servidor con su historia.
  const vigencia = useQuery({
    queryKey: ["tipo-contribuyente", empresa.id],
    queryFn: () =>
      llamar<{
        current: { effective_from: string | null; notified_on: string | null } | null;
      }>("/v1/companies/taxpayer-type"),
  });
  // Declaración RETROACTIVA (decidido por criterio, ADR-0072): antes de confirmar se enseña cuántos
  // documentos fiscales hay ya emitidos desde la fecha elegida. El conteo lo hace el servidor.
  const fechaElegida = desde !== "" ? desde : elegido === "especial" ? notificado : "";
  const emitidos = useQuery({
    queryKey: ["tipo-contribuyente-desde", empresa.id, fechaElegida],
    enabled: elegido !== null && fechaElegida !== "",
    queryFn: () =>
      llamar<{ documents_issued_since: number | null }>(
        `/v1/companies/taxpayer-type?effective_from=${fechaElegida}`,
      ),
  });
  const yaEmitidos = emitidos.data?.documents_issued_since ?? 0;

  function cerrar(): void {
    setElegido(null);
    setNotificado("");
    setDesde("");
    setActa("");
  }

  async function guardar(): Promise<void> {
    if (elegido === null) return;
    await llamar("/v1/companies/taxpayer-type", {
      method: "PUT",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        company_id: empresa.id,
        taxpayer_type_code: elegido,
        ...(elegido === "especial" && notificado !== "" ? { notified_on: notificado } : {}),
        ...(desde !== "" ? { effective_from: desde } : {}),
        reason: acta.trim(),
      }),
    });
    toast.success("Tipo de contribuyente guardado", NOMBRE_TIPO_CONTRIBUYENTE[elegido] ?? elegido);
    cerrar();
    void vigencia.refetch();
    onCambio();
  }

  const opcion = OPCIONES.find((o) => o.value === elegido);
  return (
    <div className="space-y-2">
      <p className="text-[0.9rem] font-medium">Tipo de contribuyente</p>
      {actual === null ? (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-[0.85rem] text-warning-soft-foreground">
          Falta. Sin esto no puedes facturar ni registrar compras. Lo dice tu RIF; confírmalo con tu
          contador.
        </p>
      ) : (
        <p className="text-[0.9rem] text-muted-foreground">
          {NOMBRE_TIPO_CONTRIBUYENTE[actual] ?? actual}
          {vigencia.data?.current?.effective_from != null &&
            ` · rige desde el ${vigencia.data.current.effective_from}`}
          {vigencia.data?.current?.notified_on != null &&
            ` · notificado el ${vigencia.data.current.notified_on}`}
        </p>
      )}
      {puedeCambiar && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Tipo de contribuyente">
          {OPCIONES.filter((o) => o.value !== actual && !OCULTOS.has(o.value)).map((o) => (
            <Button key={o.value} variant="secondary" size="sm" onClick={() => setElegido(o.value)}>
              {actual === null ? o.titulo : `Cambiar a ${o.titulo.toLowerCase()}`}
            </Button>
          ))}
        </div>
      )}
      {opcion !== undefined && (
        <ConfirmDialog
          open
          onOpenChange={(v) => {
            if (!v) cerrar();
          }}
          title={`La empresa es contribuyente ${opcion.titulo.toLowerCase()}`}
          confirmLabel="Guardar el tipo de contribuyente"
          confirmDisabled={
            acta.trim().length < 3 || (opcion.value === "especial" && notificado === "")
          }
          onConfirm={guardar}
        >
          <p>{opcion.detalle}</p>
          <div className="mt-3 space-y-2">
            {opcion.value === "especial" && (
              <label className="block text-[0.85rem]">
                Fecha en que el SENIAT te notificó la providencia
                <Input
                  type="date"
                  value={notificado}
                  onChange={(e) => setNotificado(e.target.value)}
                />
              </label>
            )}
            <label className="block text-[0.85rem]">
              {opcion.value === "especial"
                ? "Rige desde (déjalo vacío si rige desde la notificación)"
                : "Rige desde (vacío: desde el inicio de actividades si es la primera vez; si no, desde hoy)"}
              <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
            </label>
            <label className="block text-[0.85rem]">
              Por qué (queda en el acta)
              <Input
                value={acta}
                maxLength={500}
                placeholder={
                  opcion.value === "especial"
                    ? "Providencia de calificación N.º …"
                    : "Declaración del dueño con su contador"
                }
                onChange={(e) => setActa(e.target.value)}
              />
            </label>
          </div>
          {yaEmitidos > 0 && (
            <p className="mt-2 rounded-md bg-warning-soft px-3 py-2 text-[0.85rem] text-warning-soft-foreground">
              Desde el {fechaElegida} ya hay {yaEmitidos} documento(s) fiscal(es) emitido(s) con el
              tipo anterior. No se reemiten: consulta a tu asesor si hace falta corregirlos.
            </p>
          )}
          <p className="mt-2 text-muted-foreground">
            Abre una vigencia nueva: lo emitido antes de esa fecha conserva el tipo de entonces.
            Queda en la auditoría con tu usuario y la fecha.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
