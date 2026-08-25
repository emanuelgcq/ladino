// @ladino/db — único punto de entrada a Postgres.
//
// La regla 13 de `.dependency-cruiser.cjs` impide que cualquier otro módulo
// importe `postgres` directamente. Si necesitas la base, pasa por aquí.
// Los TIPOS del cliente también se re-exportan desde aquí: un import de tipos
// a 'postgres' crea la misma arista en el grafo que uno de valores
// (tsPreCompilationDeps), y dispararía la regla 13 igual.
export type { Sql, TransactionSql, JSONValue } from "postgres";

export {
  withTransaction,
  createClient,
  SYSTEM_ACTOR_ID,
  type Actor,
  type UnitOfWork,
} from "./transaction.js";
export { assertServiceRole, PrivilegedRoleError } from "./assert-service-role.js";
