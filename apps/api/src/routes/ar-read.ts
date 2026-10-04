import type { TransactionSql } from "@ladino/db";
import { DominioError } from "../middleware/errors.js";

/**
 * Cuentas por cobrar: la RLS ya limita a las empresas del usuario, pero
 * «puede ver la empresa» no es «puede ver lo que se le debe a la empresa».
 * `ar.read` es un permiso propio y se comprueba aquí, en servidor. Lo comparten las rutas de
 * ventas (antigüedad, estado de cuenta) y la de clientes con `with_debt=1` (P-04).
 */
export async function exigeArRead(
  tx: TransactionSql,
  actor: { kind: string; userId?: string },
  companyId: string,
): Promise<void> {
  if (actor.kind !== "user" || actor.userId === undefined) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: "Consultar cuentas por cobrar exige un usuario real.",
    });
  }
  const [permiso] = await tx<{ ok: boolean }[]>`
    select platform.ladino_user_has_permission(${actor.userId}, 'ar.read', ${companyId}) as ok`;
  if (!permiso?.ok) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: "Consultar cuentas por cobrar exige el permiso ar.read.",
    });
  }
}

/**
 * La misma pregunta, sin lanzar: ¿tiene el actor este permiso de lectura de deuda en la empresa?
 * La usa el resumen del negocio, que se sirve con `treasury.read` y manda en `null` el total que
 * el rol no puede ver (N-07/P-04: «no tienes acceso» no es «0.00»).
 */
export async function puedeLeerDeuda(
  tx: TransactionSql,
  actor: { kind: string; userId?: string },
  companyId: string,
  permiso: "ar.read" | "ap.read",
): Promise<boolean> {
  if (actor.kind !== "user" || actor.userId === undefined) return false;
  const [p] = await tx<{ ok: boolean }[]>`
    select platform.ladino_user_has_permission(${actor.userId}, ${permiso}, ${companyId}) as ok`;
  return p?.ok === true;
}
