import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "./ui/tooltip.js";
import { ToasterProvider } from "./ui/toast.js";
import { SessionProvider } from "./app/session.js";
import { router } from "./app/router.js";
import { initTema } from "./theme.js";

// Fuentes autoalojadas (nunca un CDN): Inter para UI, JetBrains Mono para números.
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "./styles/theme.css";

// El tema se aplica ANTES del primer render para que no haya flash claro→oscuro.
initTema();

/**
 * Estado de servidor con TanStack Query (apps/web/CLAUDE.md): sin duplicar la
 * caché en un store global. 30 s de frescura por defecto — un ERP relee al
 * navegar, no martillea la API.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <ToasterProvider>
        <SessionProvider>
          <RouterProvider router={router} />
        </SessionProvider>
      </ToasterProvider>
    </TooltipProvider>
  </QueryClientProvider>,
);
