/**
 * @ladino/inventory — costeo (promedio ponderado móvil) y kardex. Paquete PURO (ADR-0034).
 *
 * Solo importa `@ladino/core` y `@ladino/money`. Sin I/O, sin reloj: la posición entra como
 * argumento y el movimiento valorado sale como valor. Quien persiste es `packages/domain`.
 */
export {
  COST_ROUNDING_POLICY,
  COSTING_METHODS,
  adjust,
  emptyPosition,
  hasMeaningfulAverage,
  issue,
  issueCost,
  parseQuantity,
  positionOf,
  receive,
  replay,
  type Costed,
  type CostedMove,
  type CostingMethod,
  type InventoryError,
  type InventoryErrorCode,
  type MoveInput,
  type StockPosition,
} from "./costing.js";
export { explodeRecipe, totalCost, type ExplodedLine, type RecipeLine } from "./recipes.js";
