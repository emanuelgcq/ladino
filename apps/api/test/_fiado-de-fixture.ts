import type { TransactionSql } from "@ladino/db";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * P-05 · EL VENCIMIENTO DE UN FIADO DE PRUEBA: una venta de la caja que deja saldo dice cuándo
 * se paga (`due_date`, obligatoria desde la migración 20261004210000). Es una ENTRADA del
 * fixture —el día de Caracas más unos días, nunca `toISOString()`—, no una cifra esperada. El
 * E2E que prueba la regla en sí es `e2e-el-fiado-vence.test.ts`.
 */
export function venceDeFixture(dias = 15): string {
  return diaCaracas(dias);
}

/**
 * El fixture DECLARA que su empresa de prueba fía (E-09, migración 20261004140000): desde que
 * fiar exige el permiso `sales.credit` y un límite de fiado por cliente, un E2E que deja una
 * venta de la caja sin cobrar del todo necesita las dos cosas, como las necesitaría una empresa
 * real.
 *
 *   · a cada rol de `roleIds` le da `sales.credit` (los roles de sistema ya lo traen);
 *   · a cada cliente de la empresa —menos el «Consumidor final» de sistema— le fija un límite
 *     holgado. Lo hace como owner de la base: el trigger deja su acta (`system`).
 *
 * Son ENTRADAS del fixture, no cifras esperadas: ninguna aserción cambia. Llamar DESPUÉS de crear
 * los clientes. El E2E que prueba la regla en sí es `e2e-fiar-con-permiso-y-limite.test.ts`.
 */
export async function fiadoDeFixture(
  tx: TransactionSql | ((...a: never[]) => unknown),
  companyId: string,
  roleIds: readonly string[] = [],
  limiteUsd = "1000000",
): Promise<void> {
  const sql = tx as TransactionSql;
  for (const roleId of roleIds) {
    await sql`
      insert into public.role_permissions (role_id, permission_key)
      values (${roleId}, 'sales.credit')
      on conflict (role_id, permission_key) do nothing`;
  }
  // Si el montaje ya declaró un actor (`ladino.actor_id`), el trigger del límite le exige
  // `customers.credit.set` (LAD79), que el rol de prueba no tiene: el límite se fija SIN actor
  // —como soporte— y el actor del montaje se repone después.
  const [previo] = await sql<{ actor: string | null }[]>`
    select current_setting('ladino.actor_id', true) as actor`;
  await sql`select set_config('ladino.actor_id', '', true)`;
  await sql`
    update public.customers set credit_limit_usd = ${limiteUsd}::numeric
     where company_id = ${companyId} and not is_system
       and credit_limit_usd <> ${limiteUsd}::numeric`;
  await sql`select set_config('ladino.actor_id', ${previo?.actor ?? ""}, true)`;
}
