import { Tooltip as BaseTooltip } from "@base-ui-components/react/tooltip";
import { cn } from "./cn.js";

export const TooltipProvider = BaseTooltip.Provider;

/**
 * Tooltip del sistema. `content` admite nodos: DualMoney lo usa para la tasa
 * BCV con fuente y timestamp, que es más que una línea de texto.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  className,
}: {
  content: React.ReactNode;
  children: React.ReactElement<Record<string, unknown>>;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}): React.JSX.Element {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6}>
          <BaseTooltip.Popup
            className={cn(
              "z-50 max-w-xs rounded-sm border border-border bg-surface px-2.5 py-1.5",
              "text-[0.82rem] text-foreground shadow-overlay",
              "transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
              className,
            )}
          >
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
