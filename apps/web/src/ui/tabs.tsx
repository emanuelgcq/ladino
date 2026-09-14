import { Tabs as BaseTabs } from "@base-ui-components/react/tabs";
import { cn } from "./cn.js";

export const Tabs = BaseTabs.Root;
export const TabsPanel = BaseTabs.Panel;

export function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof BaseTabs.List>): React.JSX.Element {
  return (
    <BaseTabs.List
      className={cn(
        // En teléfono la fila de pestañas se DESPLAZA en vez de partirse en dos
        // líneas y salirse de la pantalla.
        "flex max-w-full items-center gap-1 overflow-x-auto rounded-md bg-surface-muted p-0.5 [scrollbar-width:none] sm:inline-flex",
        className,
      )}
      {...props}
    />
  );
}

export function TabsTab({
  className,
  ...props
}: React.ComponentProps<typeof BaseTabs.Tab>): React.JSX.Element {
  return (
    <BaseTabs.Tab
      className={cn(
        "shrink-0 whitespace-nowrap rounded-sm px-3 py-2 text-[0.88rem] font-medium text-muted-foreground sm:px-2.5 sm:py-1",
        "outline-none transition-[background-color,color,box-shadow] duration-150 ease-out hover:text-foreground",
        "data-[selected]:bg-surface data-[selected]:text-foreground data-[selected]:shadow-soft",
        "focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...props}
    />
  );
}
