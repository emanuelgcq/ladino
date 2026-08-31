import { Switch as BaseSwitch } from "@base-ui-components/react/switch";
import { cn } from "./cn.js";

export function Switch({
  className,
  ...props
}: React.ComponentProps<typeof BaseSwitch.Root>): React.JSX.Element {
  return (
    <BaseSwitch.Root
      className={cn(
        "relative h-5 w-9 rounded-full bg-border-strong p-0.5 transition-colors",
        "data-[checked]:bg-accent focus-visible:ring-2 focus-visible:ring-ring outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb
        className={cn(
          "block size-4 rounded-full bg-surface shadow-soft transition-transform",
          "data-[checked]:translate-x-4",
        )}
      />
    </BaseSwitch.Root>
  );
}
