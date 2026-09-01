import {
  Ban,
  CheckCircle2,
  CircleDashed,
  CircleDollarSign,
  Clock,
  FileCheck,
  FileWarning,
  ListTodo,
  PackageCheck,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { Badge, type BadgeTone } from "../ui/badge.js";

/**
 * FiscalStatusBadge — el vocabulario de estados de documento, UNA vez.
 *
 * Cada estado del backend tiene color + icono FIJOS en todo el sistema: una
 * factura «emitida» se ve igual en el listado, en el detalle y en el dashboard.
 * Los estados son los que el backend ya tiene (documents.status,
 * supplier_invoices.status, la cola de ADR-0042) — aquí no se inventa ninguno,
 * solo se les da cara.
 */
export type EstadoFiscal =
  | "draft"
  | "confirmed"
  | "issued"
  | "posted"
  | "paid"
  | "annulled"
  | "cancelled"
  /** En la cola de contabilización pendiente (ADR-0042). */
  | "queued"
  /** Emitida y aún sin asiento NI cola — el hueco que coverage-gaps caza. */
  | "pending_accounting"
  /** No hay regla tributaria vigente (TAX_RULE_MISSING / LAD50). */
  | "no_rule";

const MAPA: Record<EstadoFiscal, { etiqueta: string; tone: BadgeTone; icono: LucideIcon }> = {
  draft: { etiqueta: "Borrador", tone: "neutral", icono: CircleDashed },
  confirmed: { etiqueta: "Confirmado", tone: "info", icono: PackageCheck },
  issued: { etiqueta: "Emitida", tone: "accent", icono: FileCheck },
  posted: { etiqueta: "Registrada", tone: "accent", icono: FileCheck },
  paid: { etiqueta: "Pagada", tone: "accent", icono: CircleDollarSign },
  annulled: { etiqueta: "Anulada", tone: "destructive", icono: Ban },
  cancelled: { etiqueta: "Cancelado", tone: "neutral", icono: XCircle },
  queued: { etiqueta: "En cola contable", tone: "warning", icono: ListTodo },
  pending_accounting: { etiqueta: "Pendiente de contabilizar", tone: "warning", icono: Clock },
  no_rule: { etiqueta: "Sin regla vigente", tone: "warning", icono: FileWarning },
};

export function FiscalStatusBadge({
  estado,
  className,
}: {
  estado: string;
  className?: string;
}): React.JSX.Element {
  const def = (MAPA as Record<string, (typeof MAPA)[EstadoFiscal] | undefined>)[estado];
  if (def === undefined) {
    // Un estado que el badge no conoce se ENSEÑA, no se disfraza del parecido.
    return (
      <Badge tone="outline" className={className}>
        <CheckCircle2 /> {estado}
      </Badge>
    );
  }
  const Icono = def.icono;
  return (
    <Badge tone={def.tone} className={className}>
      <Icono /> {def.etiqueta}
    </Badge>
  );
}
