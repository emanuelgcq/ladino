import { Inbox, type LucideIcon } from "lucide-react";
import { cn } from "../ui/cn.js";

/**
 * EmptyState — nunca una pantalla en blanco. Dice qué no hay, por qué suele
 * no haberlo y qué hacer a continuación, con la acción a un clic.
 */
export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icono = Inbox,
  title,
  description,
  action,
  className,
}: EmptyStateProps): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-md border border-border bg-surface px-6 py-10 text-center",
        className,
      )}
    >
      <span className="flex size-10 items-center justify-center rounded-full bg-surface-muted">
        <Icono className="size-5 text-faint-foreground" />
      </span>
      <p className="mt-3 text-[0.95rem] font-medium text-foreground">{title}</p>
      {description !== undefined && (
        <p className="mt-1 max-w-sm text-[0.85rem] text-muted-foreground">{description}</p>
      )}
      {action !== undefined && <div className="mt-4">{action}</div>}
    </div>
  );
}
