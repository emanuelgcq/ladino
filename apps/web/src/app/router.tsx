import { createBrowserRouter, Link, Navigate, useRouteError } from "react-router";
import { AppShell } from "./shell.js";
import { useSesion } from "./session.js";
import { rutaInicial, RUTA_SIN_ACCESO } from "./nav.js";
import { Configuracion } from "../pages/Configuracion.js";
import { Clientes } from "../pages/clientes/Clientes.js";
import { Productos } from "../pages/catalogo/Productos.js";
import { Precios } from "../pages/catalogo/Precios.js";
import { Inventario } from "../pages/inventario/Inventario.js";
import { Compras } from "../pages/compras/Compras.js";
import { Contabilidad } from "../pages/contabilidad/Contabilidad.js";
import { Libros } from "../pages/libros/Libros.js";
import { Declaraciones } from "../pages/libros/Declaraciones.js";
import { Igtf } from "../pages/libros/Igtf.js";
import { Reportes } from "../pages/reportes/Reportes.js";
import { Dashboard } from "../pages/Dashboard.js";
import { Ventas } from "../pages/ventas/Ventas.js";
import { NuevaFactura } from "../pages/ventas/NuevaFactura.js";
import { DetalleFactura } from "../pages/ventas/DetalleFactura.js";
import { Cuentas } from "../pages/ventas/Cuentas.js";
import { ChecklistFiscal } from "../pages/setup/ChecklistFiscal.js";
import { Dinero } from "../pages/negocio/Dinero.js";
import { ProductosNegocio } from "../pages/negocio/Productos.js";
import { Vender } from "../pages/negocio/Vender.js";
import { InventarioNegocio } from "../pages/negocio/Inventario.js";
import { ClientesNegocio } from "../pages/negocio/Clientes.js";
import { ComprasNegocio } from "../pages/negocio/Compras.js";
import { Inicio } from "../pages/negocio/Inicio.js";
import { Empezar } from "../pages/negocio/Empezar.js";

/**
 * DOS MUNDOS, UNA APP (Fase C).
 *
 * Arriba del árbol, las pantallas de la PERSONA: /inicio, /vender, /productos,
 * /inventario, /clientes, /compras, /dinero, /empezar. Debajo, INTACTA, la
 * Fase B bajo /admin/* — el mundo del contador y de quien configura, con
 * «Facturación fiscal» como casa del checklist técnico.
 *
 * Con /empezar, las ocho pantallas de la persona están construidas: ya no
 * queda ninguna provisional.
 */
/** ADR-0048: cada rol aterriza en SU pantalla — el cajero no entra por «lo que gané». */
function AterrizajePorRol(): React.JSX.Element {
  const { puede } = useSesion();
  // El registro premium deja aquí su destino (una sola vez): el router nace
  // ANTES de que exista la sesión —con la URL «/» congelada— y un
  // replaceState previo al montaje se pierde. El recién fundado aterriza en
  // /empezar sin pantalla intermedia; todos los demás, por su rol.
  const destino = sessionStorage.getItem("ladino.aterrizar");
  if (destino !== null) {
    sessionStorage.removeItem("ladino.aterrizar");
    return <Navigate to={destino} replace />;
  }
  return <Navigate to={rutaInicial(puede)} replace />;
}

/** Un rol que no abre ninguna entrada: se dice, en vez de una pantalla en blanco. */
function SinAcceso(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-md p-8 text-center">
      <h1 className="text-lg font-semibold">Tu usuario todavía no tiene una pantalla asignada</h1>
      <p className="mt-2 text-muted-foreground">
        Pídele a quien administra el negocio que te dé un rol con acceso. Tu sesión está bien; lo
        que falta es el permiso.
      </p>
    </div>
  );
}

/** URL desconocida: de vuelta a la pantalla del rol, con voz de persona. */
function NoEncontrado(): React.JSX.Element {
  const { puede } = useSesion();
  return (
    <div className="mx-auto max-w-md p-8 text-center">
      <h1 className="text-lg font-semibold">Esa dirección no existe en Ladino</h1>
      <p className="mt-2 text-muted-foreground">Quizá el enlace está viejo o se escribió mal.</p>
      <Link className="mt-4 inline-block underline" to={rutaInicial(puede)}>
        Ir a mi pantalla
      </Link>
    </div>
  );
}

/** Una excepción de render no debe enseñar la página cruda de React Router. */
function ErrorDePantalla(): React.JSX.Element {
  const error = useRouteError();
  const detalle =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error !== null && typeof error === "object" && "statusText" in error
          ? String(error.statusText)
          : "";
  return (
    <div className="mx-auto max-w-md p-8 text-center">
      <h1 className="text-lg font-semibold">Algo se rompió al pintar esta pantalla</h1>
      <p className="mt-2 text-muted-foreground">
        Vuelve a cargar la página; si sigue pasando, avísanos con este detalle:
      </p>
      <p className="mt-2 break-words font-mono text-[0.8rem] text-muted-foreground">{detalle}</p>
      <a className="mt-4 inline-block underline" href="/">
        Volver al inicio
      </a>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    errorElement: <ErrorDePantalla />,
    children: [
      { index: true, element: <AterrizajePorRol /> },
      { path: RUTA_SIN_ACCESO.slice(1), element: <SinAcceso /> },
      { path: "*", element: <NoEncontrado /> },
      // ── El mundo de la persona ─────────────────────────────────────────
      { path: "inicio", element: <Inicio /> },
      { path: "vender", element: <Vender /> },
      { path: "productos", element: <ProductosNegocio /> },
      { path: "inventario", element: <InventarioNegocio /> },
      { path: "clientes", element: <ClientesNegocio /> },
      { path: "compras", element: <ComprasNegocio /> },
      { path: "dinero", element: <Dinero /> },
      { path: "empezar", element: <Empezar /> },
      // ── Administración: la Fase B, intacta, bajo /admin/* ──────────────
      { path: "admin", element: <Dashboard /> },
      { path: "admin/ventas", element: <Ventas /> },
      { path: "admin/ventas/nueva", element: <NuevaFactura /> },
      { path: "admin/ventas/:id", element: <DetalleFactura /> },
      { path: "admin/cuentas", element: <Cuentas /> },
      { path: "admin/clientes", element: <Clientes /> },
      { path: "admin/productos", element: <Productos /> },
      { path: "admin/precios", element: <Precios /> },
      { path: "admin/inventario", element: <Inventario /> },
      { path: "admin/compras", element: <Compras /> },
      { path: "admin/contabilidad", element: <Contabilidad /> },
      { path: "admin/libros", element: <Libros /> },
      { path: "admin/declaraciones", element: <Declaraciones /> },
      { path: "admin/igtf", element: <Igtf /> },
      { path: "admin/reportes", element: <Reportes /> },
      { path: "admin/configuracion", element: <Configuracion /> },
      { path: "admin/facturacion-fiscal", element: <ChecklistFiscal /> },
    ],
  },
]);
