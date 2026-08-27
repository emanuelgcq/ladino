import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // `strictPort` se mantiene: si el puerto está ocupado queremos que FALLE, no
  // que vite escoja otro en silencio y la webapp aparezca donde nadie la busca.
  // El puerto se elige con LADINO_WEB_PORT para poder convivir con otro
  // proyecto en la máquina sin editar este fichero.
  server: { port: Number(process.env["LADINO_WEB_PORT"] ?? 5174), strictPort: true },
});
