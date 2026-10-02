import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useSesion } from "../app/session.js";
import { errorDePersona, LlamadaApiError } from "../lib.js";
import { mostrarCantidad, mostrarImporte } from "../money.js";
import { Button } from "../ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../ui/dialog.js";
import { useToast } from "../ui/toast.js";
import { descargarPlantillaCsv, PLANTILLA_PRODUCTOS } from "./importar.js";

/**
 * IMPORTAR PRODUCTOS en tres pasos (ADR-0074; C-01, C-04 y C-05 del recorrido 2026-09-24):
 *
 *   1. la persona DECLARA el formato de los números (por omisión, el venezolano) y elige el
 *      archivo — nada se interpreta por su cuenta;
 *   2. VISTA PREVIA: las diez primeras filas como se van a guardar, con sus avisos, y todas las
 *      rechazadas con su número y su motivo, ANTES del botón de confirmar;
 *   3. confirmar crea un TRABAJO que el worker procesa; esta pantalla solo consulta su progreso y
 *      enseña el informe (creados, actualizados, rechazados con el motivo). Volver a subir el
 *      mismo archivo devuelve el mismo trabajo: no duplica.
 *
 * Cero aritmética aquí: los importes llegan como texto y solo se formatean.
 */

type Formato = "comma_decimal" | "dot_decimal";
interface Dinero {
  amount: string;
  currency: string;
}
interface FilaPrevia {
  row: number;
  status: "ready" | "rejected";
  message?: string;
  warnings: string[];
  name?: string;
  sku?: string;
  is_service?: boolean;
  price?: Dinero;
  initial_stock?: { quantity: string; unit_cost: Dinero } | null;
  reference_cost?: Dinero | null;
  /** El código ya existe: solo cambia el precio (y el costo de referencia). */
  updates_existing?: boolean;
}
interface Previa {
  number_format: Formato;
  file_name: string;
  total: number;
  ready: number;
  rejected: number;
  rows: FilaPrevia[];
  rejected_rows: FilaPrevia[];
  /** Todas las filas con aviso, también las que no caben en las diez primeras (H5). */
  warned_rows: FilaPrevia[];
  /** El formato que el archivo parece usar, si no coincide con el declarado (H6). */
  suspected_format: Formato | null;
}
interface FilaInforme {
  row: number;
  status: "created" | "updated" | "rejected";
  message?: string;
  warnings: string[];
  name?: string;
  sku?: string;
}
interface Trabajo {
  id: string;
  status: "pending" | "running" | "done" | "failed";
  total_rows: number;
  processed_rows: number;
  created_count: number;
  updated_count: number;
  rejected_count: number;
  report: FilaInforme[];
  last_error: string | null;
  reused: boolean;
}

const NOTA =
  "Obligatorias: «Nombre» y «Precio». Separador «;» o «,» (se detecta solo). «Es servicio»: sí/no. " +
  "Con «Existencia» hace falta «Costo», por unidad y en dólares (o en Bs si «Moneda costo» lo " +
  "dice). Si el «Código» ya existe, la fila solo actualiza el precio de ese producto (hace falta el permiso de precios): no cambia ni la existencia ni el nombre. Máximo 500 filas.";

function formularioDe(archivo: File, formato: Formato): FormData {
  const form = new FormData();
  form.append("file", archivo);
  form.append("number_format", formato);
  return form;
}

function Avisos({ avisos }: { avisos: string[] }): React.JSX.Element | null {
  if (avisos.length === 0) return null;
  return (
    <ul className="mt-0.5 space-y-0.5 text-[0.8rem] text-warning-soft-foreground">
      {avisos.map((a) => (
        <li key={a}>Aviso: {a}</li>
      ))}
    </ul>
  );
}

export function ImportarProductos({
  onCerrar,
  onListo,
}: {
  onCerrar: () => void;
  onListo: () => void;
}): React.JSX.Element {
  const { llamar } = useSesion();
  const toast = useToast();
  const [formato, setFormato] = useState<Formato>("comma_decimal");
  const [archivo, setArchivo] = useState<File | null>(null);
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [trabajoId, setTrabajoId] = useState<string | null>(null);
  const [avisado, setAvisado] = useState(false);
  const llave = useRef<string>(crypto.randomUUID());

  const verPrevia = useMutation({
    mutationFn: () =>
      llamar<Previa>("/v1/products/import/preview", {
        method: "POST",
        body: formularioDe(archivo!, formato),
      }),
    onSuccess: setPrevia,
    onError: (e) => toast.error("No se pudo leer el archivo", errorDePersona(e)),
  });

  const confirmar = useMutation({
    mutationFn: () =>
      llamar<Trabajo>("/v1/products/import/jobs", {
        method: "POST",
        headers: { "Idempotency-Key": llave.current },
        body: formularioDe(archivo!, formato),
      }),
    onSuccess: (t) => setTrabajoId(t.id),
    onError: (e) => {
      // Un 4xx es una respuesta: el próximo intento lleva llave nueva. Un fallo de red no lo es:
      // el reintento conserva la llave y no crea nada de más.
      if (e instanceof LlamadaApiError && e.status >= 400 && e.status < 500) {
        llave.current = crypto.randomUUID();
      }
      toast.error("No se pudo empezar la importación", errorDePersona(e));
    },
  });

  const trabajo = useQuery({
    queryKey: ["importacion-productos", trabajoId],
    enabled: trabajoId !== null,
    queryFn: () => llamar<Trabajo>(`/v1/products/import/jobs/${trabajoId}`),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "done" || s === "failed" ? false : 1500;
    },
  });
  const t = trabajo.data ?? null;
  const terminado = t !== null && (t.status === "done" || t.status === "failed");
  const huboCambios = t !== null && t.created_count + t.updated_count > 0;
  useEffect(() => {
    // El catálogo se recarga UNA vez, al terminar, si algo entró.
    if (terminado && huboCambios && !avisado) {
      setAvisado(true);
      onListo();
    }
  }, [terminado, huboCambios, avisado, onListo]);

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>Importar productos</DialogTitle>
        <DialogDescription>
          Descarga la plantilla, llénala en Excel o en cualquier editor, y súbela. Antes de
          confirmar verás cómo se van a guardar las filas.
        </DialogDescription>

        {trabajoId !== null ? (
          <>
            <div className="space-y-2 pt-2 text-[0.9rem]">
              {t === null ? (
                <p className="text-muted-foreground">Preparando la importación…</p>
              ) : (
                <>
                  {t.reused && (
                    <p className="text-muted-foreground">
                      Este archivo ya se había subido: te mostramos esa misma importación, sin
                      duplicar nada.
                    </p>
                  )}
                  <p>
                    {terminado ? "Terminó: " : "Importando en segundo plano: "}
                    <span className="font-semibold">
                      {t.processed_rows} de {t.total_rows}
                    </span>{" "}
                    filas. Puedes cerrar esta ventana; la importación sigue.
                  </p>
                  <progress
                    className="h-2 w-full"
                    max={t.total_rows}
                    value={t.processed_rows}
                    aria-label="Progreso de la importación"
                  />
                  <p>
                    Creados <span className="font-semibold">{t.created_count}</span> · actualizados{" "}
                    <span className="font-semibold">{t.updated_count}</span> · rechazados{" "}
                    <span className="font-semibold">{t.rejected_count}</span>
                  </p>
                  {t.status === "failed" && (
                    <p className="text-destructive">
                      La importación se detuvo tras varios intentos:{" "}
                      {t.last_error ?? "error desconocido"}. Lo que ya entró quedó guardado. Puedes
                      volver a subir el mismo archivo: se crea una importación nueva, y las filas
                      con código no se duplican (el código hace de llave). Las filas SIN código que
                      ya entraron se crearían otra vez: quítalas del archivo antes de subirlo.
                    </p>
                  )}
                  {t.report.some((f) => f.status === "rejected" || f.warnings.length > 0) && (
                    <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-[0.85rem]">
                      {t.report
                        .filter((f) => f.status === "rejected" || f.warnings.length > 0)
                        .map((f) => (
                          <li key={f.row}>
                            <span className="font-mono text-muted-foreground">Fila {f.row}:</span>{" "}
                            {f.name !== undefined && (
                              <span className="font-medium">{f.name} — </span>
                            )}
                            {f.status === "rejected"
                              ? f.message
                              : f.status === "created"
                                ? "creado"
                                : "actualizado"}
                            <Avisos avisos={f.warnings} />
                          </li>
                        ))}
                    </ul>
                  )}
                </>
              )}
            </div>
            <DialogFooter>
              <Button variant="primary" onClick={onCerrar}>
                {terminado ? "Listo" : "Cerrar"}
              </Button>
            </DialogFooter>
          </>
        ) : previa === null ? (
          <>
            <div className="space-y-3 pt-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  descargarPlantillaCsv(
                    PLANTILLA_PRODUCTOS.nombreArchivo,
                    PLANTILLA_PRODUCTOS.filas,
                  )
                }
              >
                <Download /> Descargar la plantilla CSV
              </Button>
              <fieldset className="space-y-1 text-[0.9rem]">
                <legend className="font-medium">¿Cómo están escritos los números?</legend>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="formato-numeros"
                    checked={formato === "comma_decimal"}
                    onChange={() => setFormato("comma_decimal")}
                  />
                  Coma decimal: 9,50 · 1.234,50 (el de Venezuela)
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="formato-numeros"
                    checked={formato === "dot_decimal"}
                    onChange={() => setFormato("dot_decimal")}
                  />
                  Punto decimal: 9.50 · 1,234.50
                </label>
              </fieldset>
              <p className="text-[0.8rem] text-muted-foreground">{NOTA}</p>
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
                disabled={archivo === null || verPrevia.isPending}
                onClick={() => verPrevia.mutate()}
              >
                {verPrevia.isPending ? "Leyendo…" : "Ver vista previa"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="space-y-2 pt-2 text-[0.9rem]">
              {previa.suspected_format !== null && (
                <p
                  role="alert"
                  className="rounded-md border border-warning/40 bg-warning-soft p-2 text-warning-soft-foreground"
                >
                  Tu archivo parece usar{" "}
                  {previa.suspected_format === "comma_decimal"
                    ? "coma decimal (9,50)"
                    : "punto decimal (9.50)"}
                  : revisa el formato de los números. Las celdas que así serían otro número salen
                  rechazadas como ambiguas.
                </p>
              )}
              <p>
                {previa.file_name}: <span className="font-semibold">{previa.ready}</span> fila
                {previa.ready === 1 ? "" : "s"} lista{previa.ready === 1 ? "" : "s"}
                {previa.rejected > 0 && (
                  <span className="text-warning-soft-foreground">
                    {" "}
                    y {previa.rejected} rechazada{previa.rejected === 1 ? "" : "s"}
                  </span>
                )}
                , leídas con{" "}
                {previa.number_format === "comma_decimal" ? "coma decimal" : "punto decimal"}. Así
                se van a guardar las primeras:
              </p>
              <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-[0.85rem]">
                {previa.rows.map((f) => (
                  <li key={f.row}>
                    <span className="font-mono text-muted-foreground">Fila {f.row}:</span>{" "}
                    {f.status === "rejected" ? (
                      <span className="text-destructive">
                        {f.name !== undefined && <span className="font-medium">{f.name} — </span>}
                        {f.message}
                      </span>
                    ) : (
                      <>
                        <span className="font-medium">{f.name}</span>
                        {f.sku !== undefined && <span> ({f.sku})</span>}
                        {f.price && <span> · {mostrarImporte(f.price)}</span>}
                        {f.is_service === true && <span> · servicio</span>}
                        {f.updates_existing === true && (
                          <span> · ya existe: solo cambia el precio</span>
                        )}
                        {f.initial_stock && f.updates_existing !== true && (
                          <span>
                            {" "}
                            · existencia {mostrarCantidad(f.initial_stock.quantity)} a{" "}
                            {mostrarImporte(f.initial_stock.unit_cost)} c/u
                          </span>
                        )}
                        {f.reference_cost && (
                          <span> · costo de referencia {mostrarImporte(f.reference_cost)}</span>
                        )}
                      </>
                    )}
                    <Avisos avisos={f.warnings} />
                  </li>
                ))}
              </ul>
              {previa.rejected_rows.some((r) => !previa.rows.some((f) => f.row === r.row)) && (
                <>
                  <p className="text-warning-soft-foreground">Más filas rechazadas:</p>
                  <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-[0.85rem]">
                    {previa.rejected_rows
                      .filter((r) => !previa.rows.some((f) => f.row === r.row))
                      .map((r) => (
                        <li key={r.row}>
                          <span className="font-mono text-muted-foreground">Fila {r.row}:</span>{" "}
                          {r.message}
                        </li>
                      ))}
                  </ul>
                </>
              )}
              {previa.warned_rows.some(
                (a) => a.status === "ready" && !previa.rows.some((f) => f.row === a.row),
              ) && (
                <>
                  <p className="text-warning-soft-foreground">Más filas con aviso:</p>
                  <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-[0.85rem]">
                    {previa.warned_rows
                      .filter(
                        (a) => a.status === "ready" && !previa.rows.some((f) => f.row === a.row),
                      )
                      .map((a) => (
                        <li key={a.row}>
                          <span className="font-mono text-muted-foreground">Fila {a.row}:</span>{" "}
                          {a.name !== undefined && <span className="font-medium">{a.name}</span>}
                          <Avisos avisos={a.warnings} />
                        </li>
                      ))}
                  </ul>
                </>
              )}
              {previa.rejected > 0 && (
                <p className="text-[0.8rem] text-muted-foreground">
                  Las rechazadas no entran. Corrígelas en el archivo y vuelve a subirlo, o confirma
                  y entran solo las listas.
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => {
                  llave.current = crypto.randomUUID();
                  setPrevia(null);
                }}
              >
                Cambiar archivo o formato
              </Button>
              <Button
                variant="primary"
                disabled={previa.ready === 0 || confirmar.isPending}
                onClick={() => confirmar.mutate()}
              >
                {confirmar.isPending
                  ? "Empezando…"
                  : `Confirmar: importar ${previa.ready} fila${previa.ready === 1 ? "" : "s"}`}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
