import { createRoot } from "react-dom/client";
import { App } from "./App.js";

// Punto de entrada del bundle de Vite. Router y TanStack Query llegan con las
// pantallas reales (el stack de CLAUDE.md §4); la vertical delgada no los
// necesita y no se instala infraestructura para una pantalla.
createRoot(document.getElementById("root")!).render(<App />);
