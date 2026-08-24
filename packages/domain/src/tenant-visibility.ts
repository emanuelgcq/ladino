import type { Sql, TransactionSql } from "@ladino/db";

/**
 * ¿Este usuario puede VER este tenant? Un tenant es visible para quien tiene
 * membership activo en él, y para nadie más.
 *
 * ES LA ÚNICA COPIA de este predicado, a propósito: lo usan el caso de uso
 * (create-company, para la regla 404/403) y el middleware de idempotencia
 * (para no reservar claves en tenants ajenos — H-2 de la auditoría de S0.5:
 * sin esta comprobación, cualquier autenticado escribía filas en la partición
 * lógica de otro cliente, y el par 409/404 de la clave delataba qué tenants
 * existen). Dos copias de un predicado RBAC divergen (ADR-0027 §3-bis).
 *
 * Devuelve lo mismo para «no existe» y para «existe y no es tuyo». Es la
 * regla 404/403: distinguirlos confirmaría existencia.
 */
export async function tenantVisible(
  // Dentro de una transacción (caso de uso) o fuera de ella (middleware, antes
  // de T1): el predicado es el mismo y no le importa desde dónde se llama.
  sql: Sql | TransactionSql,
  userId: string,
  tenantId: string,
): Promise<boolean> {
  const [r] = await sql<{ v: boolean }[]>`
    select exists (
      select 1 from public.memberships
       where tenant_id = ${tenantId}
         and user_id = ${userId}
         and status = 'active'
    ) as v`;
  return r?.v === true;
}
