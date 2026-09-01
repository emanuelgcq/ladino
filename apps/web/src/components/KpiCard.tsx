import { LineChart, Line, ResponsiveContainer } from "recharts";
import { motion } from "motion/react";
import { TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";
import { cn } from "../ui/cn.js";
import { Card } from "../ui/card.js";
import { Skeleton } from "../ui/card.js";

/**
 * KpiCard — la cifra grande del dashboard.
 *
 * El `value` llega YA formateado (normalmente un <DualMoney variant="kpi">):
 * esta tarjeta no toca números. El delta es una DIRECCIÓN con etiqueta — quien
 * la calcula es el servidor o una comparación de strings decimales; aquí solo
 * se pinta. El sparkline usa los valores únicamente como geometría: cada cifra
 * visible sale del servidor tal cual.
 */
export interface KpiDelta {
  direction: "up" | "down" | "flat";
  label: string;
  /** ¿Subir es bueno? En cobros pendientes, no. Decide el color, no la flecha. */
  positiveIsGood?: boolean;
}

export function KpiCard({
  title,
  value,
  delta,
  icon: Icono,
  spark,
  footer,
  loading = false,
  className,
}: {
  title: string;
  value: React.ReactNode;
  delta?: KpiDelta | null;
  icon?: LucideIcon;
  /** Serie para el sparkline; `v` es SOLO geometría del trazo. */
  spark?: { v: number }[];
  footer?: React.ReactNode;
  loading?: boolean;
  className?: string;
}): React.JSX.Element {
  const bueno =
    delta == null || delta.direction === "flat"
      ? null
      : (delta.direction === "up") === (delta.positiveIsGood ?? true);

  return (
    <Card className={cn("relative overflow-hidden p-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[0.82rem] font-medium text-muted-foreground">{title}</p>
        {Icono !== undefined && <Icono className="size-4 text-faint-foreground" />}
      </div>
      {loading ? (
        <div className="mt-2 space-y-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-20" />
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          className="mt-1.5"
        >
          <div className="min-h-8">{value}</div>
          {delta != null && (
            <p
              className={cn(
                "mt-1 inline-flex items-center gap-1 text-[0.8rem] font-medium",
                bueno === null && "text-muted-foreground",
                bueno === true && "text-accent-soft-foreground",
                bueno === false && "text-warning-soft-foreground",
              )}
            >
              {delta.direction === "up" && <TrendingUp className="size-3.5" />}
              {delta.direction === "down" && <TrendingDown className="size-3.5" />}
              {delta.label}
            </p>
          )}
          {footer !== undefined && (
            <div className="mt-1 text-[0.8rem] text-muted-foreground">{footer}</div>
          )}
        </motion.div>
      )}
      {spark !== undefined && spark.length > 1 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 opacity-60">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={spark} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
              <Line
                type="monotone"
                dataKey="v"
                stroke="var(--accent)"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
