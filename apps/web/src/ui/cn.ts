import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Composición de clases con resolución de conflictos Tailwind. El helper de todo el sistema. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
