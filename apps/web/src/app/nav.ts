import {
  Banknote,
  BookOpenCheck,
  Boxes,
  Building,
  Calculator,
  FlaskConical,
  Home,
  Package,
  Receipt,
  Settings,
  ShoppingCart,
  Tags,
  Users,
  type LucideIcon,
} from "lucide-react";

/**
 * El menú con DIVULGACIÓN PROGRESIVA — el principio bodega→cadena en la UI.
 *
 * El menú base es lo que una bodega de una persona necesita. Los módulos
 * `advanced` aparecen solo si la empresa TIENE datos o configuración en ellos
 * (lo decide useModulosActivos con consultas reales, no un flag de plan), o si
 * el usuario activó «mostrar todos los módulos» en Configuración. La misma app
 * para los dos; lo que cambia es cuánto enseña.
 */
export interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Solo visible si el módulo está activo o el usuario pidió verlo todo. */
  readonly advanced?: "compras" | "contabilidad" | "libros";
  /** Solo en desarrollo (página de demo de componentes). */
  readonly devOnly?: boolean;
}

export interface NavGroup {
  readonly label: string | null;
  readonly items: NavItem[];
}

export const NAV: NavGroup[] = [
  { label: null, items: [{ to: "/", label: "Inicio", icon: Home }] },
  {
    label: "Operación",
    items: [
      { to: "/ventas", label: "Ventas", icon: Receipt },
      { to: "/cuentas", label: "Cuentas por cobrar", icon: Banknote },
      { to: "/clientes", label: "Clientes", icon: Users },
    ],
  },
  {
    label: "Catálogo e inventario",
    items: [
      { to: "/productos", label: "Productos", icon: Package },
      { to: "/precios", label: "Listas de precios", icon: Tags },
      { to: "/inventario", label: "Inventario", icon: Boxes },
    ],
  },
  {
    label: "Avanzado",
    items: [
      { to: "/compras", label: "Compras", icon: ShoppingCart, advanced: "compras" },
      { to: "/contabilidad", label: "Contabilidad", icon: Calculator, advanced: "contabilidad" },
      { to: "/libros", label: "Libros fiscales", icon: BookOpenCheck, advanced: "libros" },
    ],
  },
  {
    label: "Sistema",
    items: [
      { to: "/reportes", label: "Reportes", icon: Building },
      { to: "/configuracion", label: "Configuración", icon: Settings },
      { to: "/dev/components", label: "Componentes (dev)", icon: FlaskConical, devOnly: true },
    ],
  },
];

/** Ruta → miga. Lo consumen breadcrumbs y el título del documento. */
export const CRUMBS: Record<string, string> = {
  "/": "Inicio",
  "/ventas": "Ventas",
  "/ventas/nueva": "Nueva factura",
  "/cuentas": "Cuentas por cobrar",
  "/clientes": "Clientes",
  "/productos": "Productos",
  "/precios": "Listas de precios",
  "/inventario": "Inventario",
  "/compras": "Compras",
  "/contabilidad": "Contabilidad",
  "/libros": "Libros fiscales",
  "/reportes": "Reportes",
  "/configuracion": "Configuración",
  "/configuracion/fiscal": "Puesta a punto fiscal",
  "/dev/components": "Componentes",
};
