import { useState } from "react";
import { Button } from "../../ui/button.js";
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
 */
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
  const puedeCambiar = puede("company.settings.manage");

  async function guardar(): Promise<void> {
    if (elegido === null) return;
    await llamar("/v1/companies/taxpayer-type", {
      method: "PUT",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ company_id: empresa.id, taxpayer_type_code: elegido }),
    });
    toast.success("Tipo de contribuyente guardado", NOMBRE_TIPO_CONTRIBUYENTE[elegido] ?? elegido);
    setElegido(null);
    onCambio();
  }

  const opcion = OPCIONES.find((o) => o.value === elegido);
  return (
    <div className="space-y-2">
      <p className="text-[0.9rem] font-medium">Tipo de contribuyente</p>
      {actual === null ? (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-[0.85rem] text-warning-soft-foreground">
          Falta. Sin esto no se pueden registrar compras: no se sabe si el IVA que pagas es crédito
          fiscal. Lo dice tu RIF; confírmalo con tu contador.
        </p>
      ) : (
        <p className="text-[0.9rem] text-muted-foreground">
          {NOMBRE_TIPO_CONTRIBUYENTE[actual] ?? actual}
        </p>
      )}
      {puedeCambiar && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Tipo de contribuyente">
          {OPCIONES.filter((o) => o.value !== actual).map((o) => (
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
            if (!v) setElegido(null);
          }}
          title={`La empresa es contribuyente ${opcion.titulo.toLowerCase()}`}
          confirmLabel="Guardar el tipo de contribuyente"
          onConfirm={guardar}
        >
          <p>{opcion.detalle}</p>
          <p className="mt-2 text-muted-foreground">
            Aplica a las compras y retenciones que registres desde ahora; lo ya registrado no
            cambia. Queda en la auditoría con tu usuario y la fecha.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
