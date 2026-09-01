import { createBrowserRouter } from "react-router";
import { AppShell } from "./shell.js";
import {
  LegacyClientes,
  LegacyCompras,
  LegacyContabilidad,
  LegacyInventario,
  LegacyLibros,
  LegacyPrecios,
  LegacyProductos,
  LegacyReportes,
} from "./legacy.js";
import { Configuracion } from "../pages/Configuracion.js";
import { Dashboard } from "../pages/Dashboard.js";
import { Ventas } from "../pages/ventas/Ventas.js";
import { NuevaFactura } from "../pages/ventas/NuevaFactura.js";
import { DetalleFactura } from "../pages/ventas/DetalleFactura.js";
import { Cuentas } from "../pages/ventas/Cuentas.js";
import { ChecklistFiscal } from "../pages/setup/ChecklistFiscal.js";
import { DemoComponentes } from "../pages/dev/DemoComponentes.js";

/**
 * React Router en data mode. La vertical PULIDA de Fase A (dashboard, ventas,
 * puesta a punto fiscal) usa pantallas nuevas; el resto monta las heredadas
 * dentro del shell hasta que Fase B las alcance.
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
      { path: "clientes", element: <LegacyClientes /> },
      { path: "productos", element: <LegacyProductos /> },
      { path: "precios", element: <LegacyPrecios /> },
      { path: "inventario", element: <LegacyInventario /> },
      { path: "compras", element: <LegacyCompras /> },
      { path: "contabilidad", element: <LegacyContabilidad /> },
      { path: "libros", element: <LegacyLibros /> },
      { path: "reportes", element: <LegacyReportes /> },
      { path: "configuracion", element: <Configuracion /> },
      { path: "configuracion/fiscal", element: <ChecklistFiscal /> },
      { path: "dev/components", element: <DemoComponentes /> },
    ],
  },
]);
