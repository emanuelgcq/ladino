import { createBrowserRouter, Navigate } from "react-router";
import { AppShell } from "./shell.js";
import { Configuracion } from "../pages/Configuracion.js";
import { Clientes } from "../pages/clientes/Clientes.js";
import { Productos } from "../pages/catalogo/Productos.js";
import { Precios } from "../pages/catalogo/Precios.js";
import { Inventario } from "../pages/inventario/Inventario.js";
import { Compras } from "../pages/compras/Compras.js";
import { Contabilidad } from "../pages/contabilidad/Contabilidad.js";
import { Libros } from "../pages/libros/Libros.js";
import { Reportes } from "../pages/reportes/Reportes.js";
import { Dashboard } from "../pages/Dashboard.js";
import { Ventas } from "../pages/ventas/Ventas.js";
import { NuevaFactura } from "../pages/ventas/NuevaFactura.js";
import { DetalleFactura } from "../pages/ventas/DetalleFactura.js";
import { Cuentas } from "../pages/ventas/Cuentas.js";
import { ChecklistFiscal } from "../pages/setup/ChecklistFiscal.js";
import { DemoComponentes } from "../pages/dev/DemoComponentes.js";
import { Dinero } from "../pages/negocio/Dinero.js";
import { ProductosNegocio } from "../pages/negocio/Productos.js";
import { Vender } from "../pages/negocio/Vender.js";
import { InventarioNegocio } from "../pages/negocio/Inventario.js";
import { PantallaEnCamino } from "../pages/negocio/comunes.js";

/**
 * DOS MUNDOS, UNA APP (Fase C).
 *
 * Arriba del árbol, las pantallas de la PERSONA: /inicio, /vender, /productos,
 * /inventario, /clientes, /compras, /dinero, /empezar. Debajo, INTACTA, la
 * Fase B bajo /admin/* — el mundo del contador y de quien configura, con
 * «Facturación fiscal» como casa del checklist técnico.
 *
 * Las PantallaEnCamino son provisionales y desaparecen pantalla a pantalla
 * dentro de esta misma fase.
 */
export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/inicio" replace /> },
      // ── El mundo de la persona ─────────────────────────────────────────
      { path: "inicio", element: <PantallaEnCamino titulo="Inicio" /> },
      { path: "vender", element: <Vender /> },
      { path: "productos", element: <ProductosNegocio /> },
      { path: "inventario", element: <InventarioNegocio /> },
      { path: "clientes", element: <PantallaEnCamino titulo="Clientes" /> },
      { path: "compras", element: <PantallaEnCamino titulo="Compras y gastos" /> },
      { path: "dinero", element: <Dinero /> },
      { path: "empezar", element: <PantallaEnCamino titulo="Empezar" /> },
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
      { path: "admin/reportes", element: <Reportes /> },
      { path: "admin/configuracion", element: <Configuracion /> },
      { path: "admin/facturacion-fiscal", element: <ChecklistFiscal /> },
      { path: "dev/components", element: <DemoComponentes /> },
    ],
  },
]);
