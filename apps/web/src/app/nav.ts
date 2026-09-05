import {
  Banknote,
  BookOpenCheck,
  Boxes,
  Building,
  Calculator,
  FileCheck2,
  FlaskConical,
  Home,
  Package,
  Receipt,
  Rocket,
  Settings,
  ShoppingCart,
  Store,
  Tags,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

/**
 * DOS MUNDOS, UNA APP (Fase C).
 *
 * El grupo de arriba, SIN nombre, ES la aplicación: las pantallas que hablan
 * el idioma de quien atiende el mostrador. Debajo, plegado y con nombre,
 * «ADMINISTRACIÓN»: las superficies técnicas de la Fase B movidas INTACTAS a
 * /admin/*, más «Facturación fiscal». El segundo mundo solo aparece para
 * quien tiene permisos de contabilidad/fiscal/configuración — y la
 * visibilidad es cortesía de UX: el que decide es siempre el servidor.
 */
export interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /**
   * ADR-0048: el permiso que abre la entrada — con un array basta CUALQUIERA.
   * Sin declarar = visible para todo miembro (solo lecturas de catálogo).
   * La lista la resolvió el servidor; esconder aquí es cortesía, no control.
   */
  readonly permiso?: string | readonly string[];
  /** Solo visible si el módulo avanzado está activo o el usuario pidió verlo todo. */
  readonly advanced?: "compras" | "contabilidad" | "libros";
  /** Solo en desarrollo (página de demo de componentes). */
  readonly devOnly?: boolean;
}

export interface NavGroup {
  readonly label: string | null;
  readonly items: NavItem[];
}

/**
 * El mundo de la PERSONA: el grupo sin nombre que es la app.
 *
 * Los permisos siguen el mapa de ADR-0048: el mostrador entero se abre con
 * `sales.invoice.issue` (quien vende ve el catálogo, la existencia y los
 * clientes — VER es de miembro; los botones de acción se esconden aparte,
 * pantalla a pantalla); Inicio es «lo que gané» y por eso pide el dinero
 * agregado; Compras/Mi dinero se abren por lo que cada rol puede HACER ahí.
 */
export const NAV_NEGOCIO: NavItem[] = [
  { to: "/inicio", label: "Inicio", icon: Home, permiso: "treasury.read" },
  { to: "/vender", label: "Vender", icon: Store, permiso: "sales.invoice.issue" },
  { to: "/productos", label: "Productos", icon: Package, permiso: "sales.invoice.issue" },
  { to: "/inventario", label: "Inventario", icon: Boxes, permiso: "sales.invoice.issue" },
  { to: "/clientes", label: "Clientes", icon: Users, permiso: "sales.invoice.issue" },
  {
    to: "/compras",
    label: "Compras y gastos",
    icon: ShoppingCart,
    permiso: ["expense.read", "purchase.invoice.register"],
  },
  {
    to: "/dinero",
    label: "Mi dinero",
    icon: Wallet,
    permiso: ["treasury.read", "cash.close"],
  },
];

/** El primer día: visible mientras la puesta a punto no esté completa. */
export const NAV_EMPEZAR: NavItem = {
  to: "/empezar",
  label: "Empezar",
  icon: Rocket,
  permiso: "fiscal.regime.manage",
};

/** El mundo TÉCNICO, bajo /admin/*: la Fase B intacta + Facturación fiscal. */
export const NAV_ADMIN: NavGroup[] = [
  {
    label: "Operación",
    items: [
      {
        to: "/admin/ventas",
        label: "Ventas",
        icon: Receipt,
        permiso: ["sales.invoice.annul", "accounting.read"],
      },
      {
        to: "/admin/cuentas",
        label: "Cuentas por cobrar",
        icon: Banknote,
        permiso: ["sales.invoice.annul", "accounting.read"],
      },
      {
        to: "/admin/clientes",
        label: "Clientes",
        icon: Users,
        permiso: ["customer.tax_id.manage", "accounting.read"],
      },
    ],
  },
  {
    label: "Catálogo e inventario",
    items: [
      {
        to: "/admin/productos",
        label: "Productos",
        icon: Package,
        permiso: ["product.variant.manage", "product.tax_category.set"],
      },
      {
        to: "/admin/precios",
        label: "Listas de precios",
        icon: Tags,
        permiso: ["price_list.manage", "accounting.read"],
      },
      {
        to: "/admin/inventario",
        label: "Inventario",
        icon: Boxes,
        permiso: ["inventory.threshold.manage", "accounting.read"],
      },
    ],
  },
  {
    label: "Contable y fiscal",
    items: [
      {
        to: "/admin/compras",
        label: "Compras",
        icon: ShoppingCart,
        advanced: "compras",
        permiso: ["purchase.order.manage", "ap.read"],
      },
      {
        to: "/admin/contabilidad",
        label: "Contabilidad",
        icon: Calculator,
        advanced: "contabilidad",
        permiso: "accounting.entry.create",
      },
      {
        to: "/admin/libros",
        label: "Libros fiscales",
        icon: BookOpenCheck,
        advanced: "libros",
        permiso: "fiscal_book.read",
      },
      {
        to: "/admin/facturacion-fiscal",
        label: "Facturación fiscal",
        icon: FileCheck2,
        permiso: ["fiscal.range.manage", "fiscal.audit.read"],
      },
    ],
  },
  {
    label: "Sistema",
    items: [
      { to: "/admin/reportes", label: "Reportes", icon: Building, permiso: "report.export" },
      {
        to: "/admin/configuracion",
        label: "Configuración",
        icon: Settings,
        permiso: "company.settings.manage",
      },
      { to: "/dev/components", label: "Componentes (dev)", icon: FlaskConical, devOnly: true },
    ],
  },
];

/**
 * A dónde aterriza cada rol al entrar («/»): el dueño y el administrador a
 * Inicio; quien vende, al mostrador; el contador, a su contabilidad; y quien
 * no encaje en nada, a Vender — la pantalla más inofensiva.
 */
export function rutaInicial(puede: (p: string | readonly string[]) => boolean): string {
  if (puede("treasury.read")) return "/inicio";
  if (puede("sales.invoice.issue")) return "/vender";
  if (puede("accounting.entry.create")) return "/admin/contabilidad";
  if (puede("report.export")) return "/admin/reportes";
  return "/vender";
}

/** Ruta → miga. Lo consumen breadcrumbs y el título del documento. */
export const CRUMBS: Record<string, string> = {
  "/inicio": "Inicio",
  "/vender": "Vender",
  "/productos": "Productos",
  "/inventario": "Inventario",
  "/clientes": "Clientes",
  "/compras": "Compras y gastos",
  "/dinero": "Mi dinero",
  "/empezar": "Empezar",
  "/admin": "Administración",
  "/admin/ventas": "Ventas",
  "/admin/ventas/nueva": "Nueva factura",
  "/admin/cuentas": "Cuentas por cobrar",
  "/admin/clientes": "Clientes",
  "/admin/productos": "Productos",
  "/admin/precios": "Listas de precios",
  "/admin/inventario": "Inventario",
  "/admin/compras": "Compras",
  "/admin/contabilidad": "Contabilidad",
  "/admin/libros": "Libros fiscales",
  "/admin/reportes": "Reportes",
  "/admin/configuracion": "Configuración",
  "/admin/facturacion-fiscal": "Facturación fiscal",
  "/dev/components": "Componentes",
};
