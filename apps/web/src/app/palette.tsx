import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Dialog as BaseDialog } from "@base-ui-components/react/dialog";
import { CornerDownLeft, FileText, Package, Users, Zap } from "lucide-react";
import { formatearDocumento } from "@ladino/schemas";
import { cn } from "../ui/cn.js";
import { fechaLocal } from "../fechas.js";
import { useSesion } from "./session.js";
import { type NavItem } from "./nav.js";
import {
  accionesDePaleta,
  destinoDeDocumento,
  etiquetaDeDocumento,
  pantallasDePaleta,
  type DocumentoHallado,
} from "./paleta-acciones.js";

/**
 * Command palette (Ctrl/Cmd+K). Hace cuatro cosas (P-06, ADR-0081): IR a una pantalla del menú,
 * ofrecer ACCIONES que viven dentro de una pantalla («Cerrar caja», «Nuevo cliente»), BUSCAR
 * clientes y productos, y encontrar DOCUMENTOS por su número. Las búsquedas las hace el
 * SERVIDOR, acotadas a la empresa de la pestaña y a lo que el rol puede leer; qué se ofrece lo
 * decide `paleta-acciones.ts` con el mismo filtro del menú. No anuncia nada que no exista.
 */
type Grupo = "Acciones" | "Pantallas" | "Documentos" | "Clientes" | "Productos";

interface Fila {
  readonly id: string;
  readonly grupo: Grupo;
  readonly etiqueta: string;
  readonly detalle?: string;
  readonly icono: React.ReactNode;
  readonly to: string;
}

const CLASE_ICONO = "size-4 shrink-0 text-muted-foreground";

export function CommandPalette({
  open,
  onOpenChange,
  visible,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /**
   * El filtro del MENÚ, el mismo objeto (A8): permiso, módulo activo y modo de
   * venta. Antes la paleta filtraba solo por permiso y enseñaba Libros, Declarar
   * IVA o IGTF que el menú escondía.
   */
  visible: (item: NavItem) => boolean;
}): React.JSX.Element {
  const { llamar, puede, empresa } = useSesion();
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

  // ADR-0048: la paleta ofrece las mismas puertas que el menú — con el mismo
  // filtro del menú, no una copia que se desalinea. `visible` y `puede` no son
  // estables entre renders, así que esto se calcula en cada uno: son dos listas cortas.
  const acciones: Fila[] = accionesDePaleta(q, visible, puede).map((a) => ({
    id: `accion:${a.id}`,
    grupo: "Acciones",
    etiqueta: a.etiqueta,
    icono: <Zap className={CLASE_ICONO} />,
    to: a.to,
  }));
  const pantallas: Fila[] = pantallasDePaleta(q, visible).map((i) => {
    const Icono = i.icon;
    return {
      id: `ruta:${i.to}`,
      grupo: "Pantallas",
      etiqueta: i.label,
      icono: <Icono className={CLASE_ICONO} />,
      to: i.to,
    };
  });

  // Entidades: solo con 2+ caracteres, con debounce vía staleTime corto de la
  // caché y la clave por texto. La búsqueda es la del SERVIDOR.
  // La clave lleva la EMPRESA: cambiar de empresa y buscar «lo mismo» no
  // puede servir los clientes de la anterior desde la caché.
  const entidades = useQuery({
    queryKey: ["paleta", empresa.id, q],
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

  // Documentos por su número. Consulta APARTE: si la de clientes falla, esta no se pierde.
  // El servidor devuelve solo lo que el rol puede leer; aquí no se filtra por tipo ni se cuenta.
  const documentos = useQuery({
    queryKey: ["paleta-documentos", empresa.id, q],
    enabled: open && q.length >= 2,
    staleTime: 10_000,
    queryFn: () =>
      llamar<{ items: DocumentoHallado[] }>(`/v1/search/documents?q=${encodeURIComponent(q)}`),
  });

  const deDocumentos: Fila[] = (documentos.data?.items ?? []).flatMap((d) => {
    const to = destinoDeDocumento(d, visible);
    if (to === null) return [];
    return [
      {
        id: `documento:${d.type}:${d.id}`,
        grupo: "Documentos" as const,
        etiqueta: etiquetaDeDocumento(d),
        detalle: [d.party_name ?? "", fechaLocal(d.date)].filter((x) => x !== "").join(" · "),
        icono: <FileText className={CLASE_ICONO} />,
        to,
      },
    ];
  });

  const deEntidades = useMemo<Fila[]>(() => {
    // Cada entidad lleva a la pantalla que el ROL abre: el mostrador a
    // /clientes y /productos; quien no vende, a la versión de administración
    // (mismas puertas que el menú — ADR-0048).
    const mostrador = puede("sales.invoice.issue");
    const deClientes: Fila[] = (entidades.data?.clientes ?? []).map((c) => ({
      id: `cliente:${c.id}`,
      grupo: "Clientes",
      etiqueta: c.legal_name,
      // El documento vestido con la función compartida (P-02): antes, el crudo.
      ...(c.tax_id === null ? {} : { detalle: formatearDocumento(c.tax_id) }),
      icono: <Users className={CLASE_ICONO} />,
      to: mostrador ? "/clientes" : "/admin/clientes",
    }));
    const deProductos: Fila[] = (entidades.data?.productos ?? []).map((p) => ({
      id: `producto:${p.id}`,
      grupo: "Productos",
      etiqueta: p.name,
      detalle: p.sku,
      icono: <Package className={CLASE_ICONO} />,
      // El mostrador abre sus productos ya BUSCANDO el elegido (`?q=`); la
      // versión de administración no lee la búsqueda del query string.
      to: mostrador ? `/productos?q=${encodeURIComponent(p.name)}` : "/admin/productos",
    }));
    return [...deClientes, ...deProductos];
  }, [entidades.data, puede]);

  const filas: Fila[] = [...acciones, ...pantallas, ...deDocumentos, ...deEntidades];

  useEffect(() => {
    setIndice((i) => Math.min(i, Math.max(filas.length - 1, 0)));
  }, [filas.length]);

  // La fila elegida con las flechas se mantiene a la vista aunque la lista tenga barra.
  const idActivo = filas[indice]?.id;
  useEffect(() => {
    if (idActivo === undefined) return;
    document.getElementById(idActivo)?.scrollIntoView({ block: "nearest" });
  }, [idActivo]);

  function ejecutar(a: Fila | undefined): void {
    if (!a) return;
    onOpenChange(false);
    void navigate(a.to);
  }

  const buscando = q.length >= 2 && (entidades.isFetching || documentos.isFetching);

  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-40 bg-slate-950/40" />
        <BaseDialog.Popup
          className={cn(
            "fixed left-1/2 top-24 z-50 w-full max-w-lg -translate-x-1/2 overflow-hidden",
            "rounded-md border border-glass-border bg-glass shadow-overlay outline-none backdrop-blur-xl backdrop-saturate-150",
            "transition-all data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
          )}
          initialFocus={inputRef}
        >
          <BaseDialog.Title className="sr-only">Buscar o ir a</BaseDialog.Title>
          <input
            ref={inputRef}
            value={texto}
            onChange={(e) => {
              setTexto(e.target.value);
              setIndice(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndice((i) => Math.min(i + 1, filas.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndice((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                ejecutar(filas[indice]);
              }
              // Escape lo atiende el diálogo: cierra y devuelve el foco a donde estaba.
            }}
            placeholder="Cliente, producto, documento por su número o pantalla…"
            aria-label="Buscar un cliente, un producto, un documento por su número o una pantalla"
            className="h-11 w-full border-b-2 border-border bg-transparent px-4 text-[0.95rem] outline-none placeholder:text-faint-foreground focus-visible:border-accent"
            role="combobox"
            aria-expanded="true"
            aria-controls="paleta-lista"
            aria-autocomplete="list"
            aria-activedescendant={idActivo}
          />
          <ul
            id="paleta-lista"
            role="listbox"
            aria-label="Resultados"
            className="max-h-80 overflow-y-auto py-1"
          >
            {filas.length === 0 && (
              <li
                role="presentation"
                className="px-4 py-6 text-center text-[0.9rem] text-muted-foreground"
              >
                {buscando
                  ? "Buscando…"
                  : q.length < 2
                    ? "Sin resultados. Escribe al menos dos letras para buscar clientes, productos o documentos."
                    : "Sin resultados. Un documento se busca por su número: «A-12» o una parte."}
              </li>
            )}
            {filas.map((a, i) => (
              <li key={a.id} role="presentation">
                {(i === 0 || filas[i - 1]!.grupo !== a.grupo) && (
                  <p
                    aria-hidden="true"
                    className="px-4 pb-1 pt-2 text-[0.7rem] font-medium uppercase tracking-wider text-faint-foreground"
                  >
                    {a.grupo}
                  </p>
                )}
                <div
                  id={a.id}
                  role="option"
                  aria-selected={i === indice}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 px-4 py-2 text-[0.9rem]",
                    // El foco se ve: fondo Y borde, no solo un cambio de tono.
                    i === indice &&
                      "bg-surface-muted outline outline-2 -outline-offset-2 outline-accent",
                  )}
                  onMouseEnter={() => setIndice(i)}
                  onClick={() => ejecutar(a)}
                >
                  {a.icono}
                  <span className="min-w-0 flex-1 truncate">{a.etiqueta}</span>
                  {a.detalle !== undefined && a.detalle !== "" && (
                    <span className="max-w-[45%] shrink-0 truncate text-[0.78rem] text-faint-foreground">
                      {a.detalle}
                    </span>
                  )}
                  {i === indice && <CornerDownLeft className="size-3.5 text-faint-foreground" />}
                </div>
              </li>
            ))}
          </ul>
          <p className="flex items-center gap-3 border-t border-border bg-surface-muted/60 px-4 py-2 text-[0.78rem] text-faint-foreground">
            <span>↑ ↓ para moverte</span>
            <span>Enter para abrir</span>
            <span>Esc para cerrar</span>
          </p>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
