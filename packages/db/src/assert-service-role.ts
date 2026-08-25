import type { Sql } from "postgres";

/**
 * EL ARRANQUE SE NIEGA SI LA CONEXIÓN ES PRIVILEGIADA (ADR-0031).
 *
 * Conectar como `postgres.<ref>` FUNCIONA — y por eso es peligroso: con
 * `BYPASSRLS`, todas las policies de la migración 14 son decorativas y nadie
 * recibe señal alguna. Un servicio que arranca así no está mal configurado
 * «un poco»: está exactamente en el estado que F-15 describió. Así que no
 * arranca. Ausencia de mecanismo no es prohibición (CLAUDE.md §2): esta
 * función es el mecanismo.
 *
 * `pg_roles` es legible por cualquier rol (la contraseña va anulada), así que
 * la comprobación no necesita privilegios.
 */
export class PrivilegedRoleError extends Error {
  override readonly name = "PrivilegedRoleError";
}

export async function assertServiceRole(sql: Sql): Promise<void> {
  const [fila] = await sql<{ usuario: string; privilegiado: boolean }[]>`
    select current_user as usuario, (rolsuper or rolbypassrls) as privilegiado
      from pg_roles
     where rolname = current_user`;
  if (!fila) {
    throw new PrivilegedRoleError("no se pudo leer el rol de la conexión en pg_roles");
  }
  if (fila.privilegiado) {
    throw new PrivilegedRoleError(
      `la conexión es '${fila.usuario}', un rol con SUPERUSER/BYPASSRLS. Un servicio no ` +
        `arranca así: con BYPASSRLS toda la RLS de la migración 14 es decorativa (ADR-0031). ` +
        `DATABASE_URL debe usar ladino_api o ladino_worker.`,
    );
  }
}
