import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  api,
  LlamadaApiError,
  type ExpiringLot,
  type LowStockItem,
  type Product,
  type RecipeLineView,
} from "./lib.js";
import { mostrarImporte } from "./money.js";

/**
 * Los tres paneles que la segunda vuelta de inventario hace posibles: qué hay
 * que reponer, qué está por vencer y qué lleva una receta.
 *
 * Ninguno calcula nada: `missing` lo devuelve `low_stock_products()`,
 * `days_left` lo devuelve `expiring_lots()` y el costo estimado lo devuelve
 * `recipe_cost()`. Si la pantalla los recalculara, habría dos respuestas para
 * la misma pregunta y un día diferirían.
 */
function mensajeDe(e: unknown): string {
  return e instanceof LlamadaApiError ? `${e.body.code}: ${e.body.message}` : String(e);
}

interface Props {
  session: Session;
  companyId: string;
}

export function InventoryAlerts({ session, companyId }: Props) {
  const [bajoStock, setBajoStock] = useState<LowStockItem[] | null>(null);
  const [porVencer, setPorVencer] = useState<ExpiringLot[] | null>(null);
  const [dias, setDias] = useState("30");
  const [error, setError] = useState("");

  const cargar = useCallback(async () => {
    setError("");
    try {
      const [bajo, vencen] = await Promise.all([
        api<{ items: LowStockItem[] }>(session, "/v1/inventory/low-stock", { companyId }),
        api<{ items: ExpiringLot[] }>(session, `/v1/inventory/expiring-lots?days=${dias}`, {
          companyId,
        }),
      ]);
      setBajoStock(bajo.items);
      setPorVencer(vencen.items);
    } catch (e) {
      setError(mensajeDe(e));
    }
  }, [session, companyId, dias]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  return (
    <section>
      <h3>Alertas de inventario</h3>
      {error && <p role="alert">{error}</p>}

      <fieldset>
        <legend>Por reponer ({bajoStock?.length ?? 0})</legend>
        {bajoStock === null ? (
          <p>cargando…</p>
        ) : bajoStock.length === 0 ? (
          <p>Nada por debajo del mínimo. (Solo aparecen los productos con umbral definido.)</p>
        ) : (
          <table border={1} cellPadding={4}>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Producto</th>
                <th>Existencia</th>
                <th>Mínimo</th>
                <th>Falta</th>
              </tr>
            </thead>
            <tbody>
              {bajoStock.map((i) => (
                <tr key={`${i.warehouse_id}-${i.product_id}`}>
                  <td>{i.product_sku}</td>
                  <td>{i.product_name}</td>
                  <td>{i.quantity}</td>
                  <td>{i.stock_min}</td>
                  <td>
                    <strong>{i.missing}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </fieldset>

      <fieldset>
        <legend>Por vencer ({porVencer?.length ?? 0})</legend>
        <p>
          <label>
            Próximos{" "}
            <input
              value={dias}
              onChange={(e) => setDias(e.target.value.replace(/\D/g, "") || "0")}
              size={4}
              aria-label="días"
            />{" "}
            días
          </label>
        </p>
        {porVencer === null ? (
          <p>cargando…</p>
        ) : porVencer.length === 0 ? (
          <p>Ningún lote con existencia vence en ese plazo.</p>
        ) : (
          <table border={1} cellPadding={4}>
            <thead>
              <tr>
                <th>Lote</th>
                <th>SKU</th>
                <th>Vence</th>
                <th>Días</th>
                <th>Existencia</th>
              </tr>
            </thead>
            <tbody>
              {porVencer.map((l) => (
                <tr key={`${l.lot_id}-${l.warehouse_id}`}>
                  <td>{l.lot_code}</td>
                  <td>{l.product_sku}</td>
                  <td>{l.expires_at}</td>
                  <td>
                    {l.days_left < 0 ? (
                      <strong>VENCIDO hace {String(-l.days_left)} días</strong>
                    ) : (
                      l.days_left
                    )}
                  </td>
                  <td>{l.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <small>
          Un lote vencido no se puede despachar sin el permiso de existencia vencida. Entrar sí se
          puede: el control es sobre lo que llega al cliente.
        </small>
      </fieldset>
    </section>
  );
}

/** Receta de un compuesto y su consumo. La cantidad convertida la trae el servidor. */
export function RecipePanel({
  session,
  companyId,
  producto,
  warehouseId,
  onConsumido,
}: Props & {
  producto: Product;
  warehouseId: string;
  onConsumido: (mensaje: string) => void;
}) {
  const [lineas, setLineas] = useState<RecipeLineView[] | null>(null);
  const [estimado, setEstimado] = useState<string | null>(null);
  const [moneda, setMoneda] = useState("VES");
  const [unidades, setUnidades] = useState("1");
  const [error, setError] = useState("");
  const [enviando, setEnviando] = useState(false);

  const cargar = useCallback(async () => {
    setError("");
    try {
      const r = await api<{
        lines: RecipeLineView[];
        estimated_unit_cost: string | null;
        currency: string;
      }>(session, `/v1/products/${producto.id}/recipe?warehouse_id=${warehouseId}`, { companyId });
      setLineas(r.lines);
      setEstimado(r.estimated_unit_cost);
      setMoneda(r.currency);
    } catch (e) {
      setError(mensajeDe(e));
    }
  }, [session, companyId, producto.id, warehouseId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const faltaConversion = (lineas ?? []).some((l) => l.quantity_in_product_unit === null);

  async function consumir() {
    if (
      !window.confirm(
        `¿Registrar el consumo de ${unidades} × ${producto.sku}?\n\n` +
          `Se genera UNA SALIDA POR INGREDIENTE, todas en el mismo instante y ligadas al mismo ` +
          `documento. El producto compuesto NO tiene existencias propias: no se descuenta él.\n\n` +
          `Ninguna se puede editar ni borrar después.`,
      )
    )
      return;
    setError("");
    setEnviando(true);
    try {
      const r = await api<{ total_cost: string; currency: string; moves: unknown[] }>(
        session,
        "/v1/inventory/recipe-consumptions",
        {
          method: "POST",
          companyId,
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            company_id: companyId,
            warehouse_id: warehouseId,
            product_id: producto.id,
            quantity: unidades,
          }),
        },
      );
      onConsumido(
        `Consumidas ${unidades} × ${producto.sku}: ${String(r.moves.length)} salidas por ` +
          `${mostrarImporte({ amount: r.total_cost, currency: r.currency })}`,
      );
    } catch (e) {
      setError(mensajeDe(e));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <fieldset>
      <legend>Receta de {producto.sku}</legend>
      {error && <p role="alert">{error}</p>}
      {lineas === null ? (
        <p>cargando…</p>
      ) : lineas.length === 0 ? (
        <p>Sin receta. Un compuesto sin receta no se puede consumir: no descontaría nada.</p>
      ) : (
        <>
          <table border={1} cellPadding={4}>
            <thead>
              <tr>
                <th>Ingrediente</th>
                <th>Por unidad</th>
                <th>En la unidad del producto</th>
              </tr>
            </thead>
            <tbody>
              {lineas.map((l) => (
                <tr key={l.child_product_id}>
                  <td>
                    {l.child_sku} · {l.child_name}
                  </td>
                  <td>
                    {l.quantity} {l.unit_code}
                  </td>
                  <td>
                    {l.quantity_in_product_unit === null ? (
                      <strong>
                        sin conversión de {l.unit_code} a {l.product_unit_code}
                      </strong>
                    ) : (
                      `${l.quantity_in_product_unit} ${l.product_unit_code}`
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Costo estimado por unidad:{" "}
            {estimado === null ? (
              <strong>no calculable — falta alguna conversión de unidad</strong>
            ) : (
              mostrarImporte({ amount: estimado, currency: moneda })
            )}
          </p>
          <p>
            <input
              value={unidades}
              onChange={(e) => setUnidades(e.target.value)}
              size={6}
              aria-label="unidades a consumir"
            />{" "}
            <button disabled={enviando || faltaConversion} onClick={() => void consumir()}>
              {enviando ? "registrando…" : "Consumir receta"}
            </button>
          </p>
          <small>
            El costo estimado usa los costos vigentes; el costo real de este consumo será la suma de
            lo que cuesten las salidas al ejecutarse.
          </small>
        </>
      )}
    </fieldset>
  );
}
