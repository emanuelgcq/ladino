import { createBrowserRouter } from "react-router";
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

/**
 * React Router en data mode. FASE B COMPLETA: las doce superficies usan el
 * sistema de diseño; no queda ninguna pantalla heredada montada.
 */
export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "ventas", element: <Ventas /> },
      { path: "ventas/nueva", element: <NuevaFactura /> },
      { path: "ventas/:id", element: <DetalleFactura /> },
      { path: "cuentas", element: <Cuentas /> },
      { path: "clientes", element: <Clientes /> },
      { path: "productos", element: <Productos /> },
      { path: "precios", element: <Precios /> },
      { path: "inventario", element: <Inventario /> },
      { path: "compras", element: <Compras /> },
      { path: "contabilidad", element: <Contabilidad /> },
      { path: "libros", element: <Libros /> },
      { path: "reportes", element: <Reportes /> },
      { path: "configuracion", element: <Configuracion /> },
      { path: "configuracion/fiscal", element: <ChecklistFiscal /> },
      { path: "dev/components", element: <DemoComponentes /> },
    ],
  },
]);
