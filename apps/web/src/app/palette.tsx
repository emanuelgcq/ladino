import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Dialog as BaseDialog } from "@base-ui-components/react/dialog";
import { CornerDownLeft, Package, Sparkles, Users } from "lucide-react";
import { cn } from "../ui/cn.js";
import { useSesion } from "./session.js";
import { NAV, type NavItem } from "./nav.js";

/**
 * Command palette (Ctrl/Cmd+K). Hoy hace dos cosas: NAVEGAR (todas las rutas
 * del menú) y BUSCAR ENTIDADES (clientes y productos, contra la API con su
 * búsqueda de servidor). Y una tercera a propósito: el pie es el SLOT del
 * asistente IA — el espacio queda reservado y visible, la IA no está
 * implementada y no se finge que lo esté.
 */
interface Accion {
  readonly id: string;
  readonly tipo: "ruta" | "cliente" | "producto";
  readonly etiqueta: string;
  readonly detalle?: string;
  readonly icono: React.ReactNode;
  readonly to: string;
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}): React.JSX.Element {
  const { llamar } = useSesion();
  const navigate = useNavigate();
  const [texto, setTexto] = useState("");
  const [indice, setIndice] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const q = texto.trim();

  useEffect(() => {
    if (open) {
      setTexto("");
      setIndice(0);
    }
  }, [open]);

  const rutas = useMemo<Accion[]>(() => {
    const items: NavItem[] = NAV.flatMap((g) => g.items).filter(
      (i) => !i.devOnly || import.meta.env.DEV,
    );
    const filtradas =
      q === "" ? items : items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase()));
    return filtradas.map((i) => {
      const Icono = i.icon;
      return {
        id: `ruta:${i.to}`,
        tipo: "ruta",
        etiqueta: i.label,
        icono: <Icono className="size-4 text-muted-foreground" />,
        to: i.to,
      };
    });
  }, [q]);

  // Entidades: solo con 2+ caracteres, con debounce vía staleTime corto de la
  // caché y la clave por texto. La búsqueda es la del SERVIDOR.
  const entidades = useQuery({
    queryKey: ["paleta", q],
    enabled: open && q.length >= 2,
    staleTime: 10_000,
    queryFn: async () => {
      const [clientes, productos] = await Promise.all([
        llamar<{ items: { id: string; legal_name: string; tax_id: string | null }[] }>(
          `/v1/customers?search=${encodeURIComponent(q)}&per_page=5`,
        ),
        llamar<{ items: { id: string; name: string; sku: string }[] }>(
          `/v1/products?search=${encodeURIComponent(q)}&per_page=5`,
        ),
      ]);
      return { clientes: clientes.items, productos: productos.items };
    },
  });

  const acciones = useMemo<Accion[]>(() => {
    const deClientes: Accion[] = (entidades.data?.clientes ?? []).map((c) => ({
      id: `cliente:${c.id}`,
      tipo: "cliente",
      etiqueta: c.legal_name,
      ...(c.tax_id === null ? {} : { detalle: c.tax_id }),
      icono: <Users className="size-4 text-muted-foreground" />,
      to: `/cuentas?cliente=${c.id}`,
    }));
    const deProductos: Accion[] = (entidades.data?.productos ?? []).map((p) => ({
      id: `producto:${p.id}`,
      tipo: "producto",
      etiqueta: p.name,
      detalle: p.sku,
      icono: <Package className="size-4 text-muted-foreground" />,
      to: `/productos`,
    }));
    return [...rutas, ...deClientes, ...deProductos];
  }, [rutas, entidades.data]);

  useEffect(() => {
    setIndice((i) => Math.min(i, Math.max(acciones.length - 1, 0)));
  }, [acciones.length]);

  function ejecutar(a: Accion | undefined): void {
    if (!a) return;
    onOpenChange(false);
    void navigate(a.to);
  }

  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-40 bg-slate-950/40" />
        <BaseDialog.Popup
          className={cn(
            "fixed left-1/2 top-24 z-50 w-full max-w-lg -translate-x-1/2 overflow-hidden",
            "rounded-md border border-border bg-surface shadow-overlay outline-none",
            "transition-all data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
          )}
          initialFocus={inputRef}
        >
          <BaseDialog.Title className="sr-only">Buscar o ir a</BaseDialog.Title>
          <input
            ref={inputRef}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndice((i) => Math.min(i + 1, acciones.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndice((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                ejecutar(acciones[indice]);
              }
            }}
            placeholder="Buscar clientes, productos o ir a una pantalla…"
            className="h-11 w-full border-b border-border bg-transparent px-4 text-[0.95rem] outline-none placeholder:text-faint-foreground"
            role="combobox"
            aria-expanded="true"
            aria-controls="paleta-lista"
            aria-activedescendant={acciones[indice]?.id}
          />
          <ul id="paleta-lista" role="listbox" className="max-h-80 overflow-y-auto py-1">
            {acciones.length === 0 && (
              <li className="px-4 py-6 text-center text-[0.9rem] text-muted-foreground">
                Sin resultados{q.length < 2 ? " — escribe 2+ letras para buscar entidades" : ""}.
              </li>
            )}
            {acciones.map((a, i) => (
              <li
                key={a.id}
                id={a.id}
                role="option"
                aria-selected={i === indice}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 px-4 py-2 text-[0.9rem]",
                  i === indice && "bg-surface-muted",
                )}
                onMouseEnter={() => setIndice(i)}
                onClick={() => ejecutar(a)}
              >
                {a.icono}
                <span className="min-w-0 flex-1 truncate">{a.etiqueta}</span>
                {a.detalle !== undefined && (
                  <span className="shrink-0 text-[0.78rem] text-faint-foreground">{a.detalle}</span>
                )}
                {i === indice && <CornerDownLeft className="size-3.5 text-faint-foreground" />}
              </li>
            ))}
          </ul>
          {/* EL SLOT DEL ASISTENTE. Reservado a propósito: cuando exista, esta
              fila se vuelve la entrada «pregúntale a Ladino». No se implementa
              como IA hoy y no aparenta serlo. */}
          <div className="flex items-center gap-2 border-t border-border bg-surface-muted/60 px-4 py-2 text-[0.8rem] text-faint-foreground">
            <Sparkles className="size-3.5" />
            Asistente de Ladino — este espacio lo espera. Próximamente.
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
