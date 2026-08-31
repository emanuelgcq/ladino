import { Popover as BasePopover } from "@base-ui-components/react/popover";
import { cn } from "./cn.js";

export const Popover = BasePopover.Root;
export const PopoverTrigger = BasePopover.Trigger;

export function PopoverContent({
  className,
  children,
  side = "bottom",
  align = "start",
  ...props
}: React.ComponentProps<typeof BasePopover.Popup> & {
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
}): React.JSX.Element {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner side={side} align={align} sideOffset={6} className="z-50">
        <BasePopover.Popup
          className={cn(
            "rounded-md border border-border bg-surface p-3 shadow-overlay outline-none",
            "transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
            className,
          )}
          {...props}
        >
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}
