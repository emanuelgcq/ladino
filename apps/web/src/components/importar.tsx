import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useSesion } from "../app/session.js";
import { errorDePersona } from "../lib.js";
import { Button } from "../ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../ui/dialog.js";
import { useToast } from "../ui/toast.js";

/**
 * IMPORTACIÓN MASIVA con plantilla (orden del dueño, 2026-09-08): la persona
 * descarga el CSV con los títulos correctos y UNA fila de ejemplo, lo llena,
 * y lo sube. El servidor acepta .csv (separador «;» o «,», coma decimal
 * venezolana) y .xlsx, y responde fila por fila: las buenas entran, las malas
 * se explican con su número.
 */

/** Una celda CSV: comillas solo cuando hacen falta (RFC 4180). */
function celdaCsv(v: string): string {
  return /[";,\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Descarga la plantilla como CSV con separador «;» (el que Excel en español
 * abre en columnas de una) y BOM para que los acentos salgan bien.
 */
export function descargarPlantillaCsv(nombreArchivo: string, filas: string[][]): void {
  const texto = "﻿" + filas.map((f) => f.map(celdaCsv).join(";")).join("\r\n") + "\r\n";
  const blob = new Blob([texto], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombreArchivo;
  a.click();
  URL.revokeObjectURL(url);
}

interface ResultadoImportacion {
  total: number;
  created: number;
  failed: number;
  rows: { row: number; status: string; message?: string; name?: string }[];
}

export function ImportarArchivo({
  titulo,
  descripcion,
  notaFormato,
  endpoint,
  plantilla,
  onCerrar,
  onListo,
}: {
  titulo: string;
  descripcion: string;
  /** La letra chica del formato: separador, decimales, columnas obligatorias. */
  notaFormato: string;
  endpoint: string;
  plantilla: { nombreArchivo: string; filas: string[][] };
  onCerrar: () => void;
  onListo: () => void;
}): React.JSX.Element {
  const { llamar } = useSesion();
  const toast = useToast();
  const [archivo, setArchivo] = useState<File | null>(null);
  const [resultado, setResultado] = useState<ResultadoImportacion | null>(null);

  const subir = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("file", archivo!);
      return llamar<ResultadoImportacion>(endpoint, { method: "POST", body: form });
    },
    onSuccess: (r) => {
      setResultado(r);
      if (r.created > 0) onListo();
    },
    onError: (e) => toast.error("No se pudo leer el archivo", errorDePersona(e)),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-lg">
        <DialogTitle>{titulo}</DialogTitle>
        <DialogDescription>{descripcion}</DialogDescription>
        {resultado === null ? (
          <>
            <div className="space-y-3 pt-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => descargarPlantillaCsv(plantilla.nombreArchivo, plantilla.filas)}
              >
                <Download /> Descargar la plantilla CSV
              </Button>
              <p className="text-[0.8rem] text-muted-foreground">{notaFormato}</p>
              <input
                type="file"
                accept=".csv,.xlsx"
                aria-label="Archivo a importar (.csv o .xlsx)"
                onChange={(e) => setArchivo(e.target.files?.[0] ?? null)}
                className="w-full text-[0.9rem] file:mr-3 file:rounded-md file:border-0 file:bg-surface-muted file:px-3 file:py-1.5 file:text-[0.85rem]"
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={onCerrar}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                disabled={archivo === null || subir.isPending}
                onClick={() => subir.mutate()}
              >
                {subir.isPending ? "Importando…" : "Importar"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="space-y-2 pt-2">
              <p className="text-[0.95rem]">
                Entraron <span className="font-semibold">{resultado.created}</span> de{" "}
                {resultado.total}.
                {resultado.failed > 0 && (
                  <span className="text-warning-soft-foreground">
                    {" "}
                    {resultado.failed} fila{resultado.failed === 1 ? "" : "s"} con problemas:
                  </span>
                )}
              </p>
              {resultado.failed > 0 && (
                <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-[0.85rem]">
                  {resultado.rows
                    .filter((r) => r.status === "error")
                    .map((r) => (
                      <li key={r.row}>
                        <span className="font-mono text-muted-foreground">Fila {r.row}:</span>{" "}
                        {r.name !== undefined && <span className="font-medium">{r.name} — </span>}
                        {r.message}
                      </li>
                    ))}
                </ul>
              )}
            </div>
            <DialogFooter>
              <Button variant="primary" onClick={onCerrar}>
                Listo
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** La plantilla de PRODUCTOS: títulos + una fila de ejemplo. */
export const PLANTILLA_PRODUCTOS: { nombreArchivo: string; filas: string[][] } = {
  nombreArchivo: "plantilla-productos.csv",
  filas: [
    [
      "Nombre",
      "Precio",
      "Moneda",
      "Código",
      "Código de barras",
      "Categoría",
      "Existencia",
      "Costo",
      "Moneda costo",
      "Es servicio",
    ],
    [
      "Martillo de uña 16 oz",
      "9,50",
      "USD",
      "MAR-16",
      "7591234567890",
      "Herramientas",
      "40",
      "5,20",
      "USD",
      "no",
    ],
    ["Servicio de instalación", "20,00", "USD", "", "", "Servicios", "", "", "", "sí"],
  ],
};

/** La plantilla de CLIENTES: títulos + ejemplos de persona y de empresa. */
export const PLANTILLA_CLIENTES: { nombreArchivo: string; filas: string[][] } = {
  nombreArchivo: "plantilla-clientes.csv",
  filas: [
    ["RIF o cédula", "Nombre o razón social", "Teléfono", "Correo", "Dirección"],
    ["V12345678", "Pedro Rivas", "0414-1234567", "", ""],
    [
      "J-31456789-0",
      "Construcciones Páez C.A.",
      "0241-8543210",
      "pagos@paez.com.ve",
      "Zona industrial Sur, galpón 4, Valencia",
    ],
  ],
};

export const NOTA_FORMATO_PRODUCTOS =
  "Obligatorias: «Nombre» y «Precio». Números con coma decimal («9,50») o punto — las dos " +
  "valen. Separador «;» o «,» (se detecta solo). «Es servicio»: sí/no. Con «Existencia» hace " +
  "falta «Costo». Máximo 500 filas.";

export const NOTA_FORMATO_CLIENTES =
  "Obligatoria: «Nombre o razón social». El tipo se deduce del documento: V/E o vacío = " +
  "persona, J/G = empresa, P = extranjero. Separador «;» o «,» (se detecta solo). Máximo " +
  "500 filas.";
