import { cn } from "../ui/cn.js";

/**
 * PageHeader — título de página con acciones. Las migas viven en el shell
 * (bajo el top bar); aquí va el H1 y los botones de la pantalla, con la
 * acción primaria SIEMPRE a la derecha y en esmeralda.
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string | undefined;
  actions?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn("mb-4 flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold leading-tight text-foreground">{title}</h1>
        {description !== undefined && (
          <p className="mt-0.5 max-w-2xl text-[0.88rem] text-muted-foreground">{description}</p>
        )}
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
