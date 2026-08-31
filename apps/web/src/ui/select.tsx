import { Select as BaseSelect } from "@base-ui-components/react/select";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "./cn.js";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * Select del sistema para valores string. Cubre el 95 % de los casos de un
 * ERP (estados, monedas, series); lo que necesite búsqueda asíncrona no es un
 * select, es EntityPicker.
 */
export function SimpleSelect({
  value,
  onValueChange,
  options,
  placeholder = "Selecciona…",
  disabled,
  id,
  className,
  ariaLabel,
}: {
  value: string | null;
  onValueChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  ariaLabel?: string;
}): React.JSX.Element {
  return (
    <BaseSelect.Root<string>
      // «» es el estado sin selección: el placeholder lo pinta Value abajo.
      value={value ?? ""}
      onValueChange={(v) => {
        if (v !== null && v !== "") onValueChange(v);
      }}
      disabled={disabled ?? false}
    >
      <BaseSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          "flex h-8 w-full items-center justify-between gap-2 rounded-sm border",
          "border-border-strong bg-surface px-2.5 text-[0.92rem] text-foreground shadow-soft",
          "focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
          className,
        )}
      >
        <BaseSelect.Value>
          {(v: string | null) =>
            v === null || v === "" ? (
              <span className="text-faint-foreground">{placeholder}</span>
            ) : (
              (options.find((o) => o.value === v)?.label ?? v)
            )
          }
        </BaseSelect.Value>
        <BaseSelect.Icon>
          <ChevronsUpDown className="size-3.5 text-faint-foreground" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4} className="z-50">
          <BaseSelect.Popup
            className={cn(
              "max-h-72 min-w-[var(--anchor-width)] overflow-y-auto rounded-md border",
              "border-border bg-surface py-1 shadow-overlay outline-none",
              "transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
            )}
          >
            {options.map((o) => (
              <BaseSelect.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled ?? false}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-3 px-2.5 py-1.5",
                  "text-[0.9rem] text-foreground outline-none",
                  "data-[highlighted]:bg-surface-muted data-[disabled]:cursor-default data-[disabled]:opacity-50",
                )}
              >
                <BaseSelect.ItemText>{o.label}</BaseSelect.ItemText>
                <BaseSelect.ItemIndicator>
                  <Check className="size-3.5 text-accent" />
                </BaseSelect.ItemIndicator>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
