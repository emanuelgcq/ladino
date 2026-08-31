import { Menu as BaseMenu } from "@base-ui-components/react/menu";
import { cn } from "./cn.js";

export const Menu = BaseMenu.Root;
export const MenuTrigger = BaseMenu.Trigger;

export function MenuSeparator(): React.JSX.Element {
  return <BaseMenu.Separator className="my-1 h-px bg-border" />;
}

export function MenuContent({
  className,
  children,
  align = "end",
  ...props
}: React.ComponentProps<typeof BaseMenu.Popup> & {
  align?: "start" | "center" | "end";
}): React.JSX.Element {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner align={align} sideOffset={6} className="z-50">
        <BaseMenu.Popup
          className={cn(
            "min-w-44 rounded-md border border-border bg-surface py-1 shadow-overlay outline-none",
            "transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
            className,
          )}
          {...props}
        >
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

export function MenuItem({
  className,
  ...props
}: React.ComponentProps<typeof BaseMenu.Item>): React.JSX.Element {
  return (
    <BaseMenu.Item
      className={cn(
        "flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[0.9rem] text-foreground",
        "outline-none data-[highlighted]:bg-surface-muted [&_svg]:size-4 [&_svg]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
