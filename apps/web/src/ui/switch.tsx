import { Switch as BaseSwitch } from "@base-ui-components/react/switch";
import { cn } from "./cn.js";

export function Switch({
  className,
  ...props
}: React.ComponentProps<typeof BaseSwitch.Root>): React.JSX.Element {
  return (
    <BaseSwitch.Root
      className={cn(
        // El componente no declaraba `display`, y de ahí salían DOS averías con
        // la misma raíz: en una celda de tabla quedaba `inline` —una caja en
        // línea ignora `width`/`height`, así que el interruptor se pintaba como
        // dos rayitas verticales (IGTF)— y dentro de una fila flex se
        // blockificaba pero se comprimía de 32×18 a 17×17, un punto que no
        // parece un interruptor (Configuración, Productos, Dinero).
        // `inline-block` fija la caja y `shrink-0` impide que la aplasten.
        "relative inline-block h-5 w-9 shrink-0 rounded-full bg-border-strong p-0.5 align-middle",
        "transition-colors",
        "data-[checked]:bg-accent focus-visible:ring-2 focus-visible:ring-ring outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb
        className={cn(
          "block size-4 rounded-full bg-white shadow-soft transition-transform duration-200 ease-out",
          "data-[checked]:translate-x-4",
        )}
      />
    </BaseSwitch.Root>
  );
}
