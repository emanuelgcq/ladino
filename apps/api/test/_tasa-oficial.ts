import type { createClient } from "@ladino/db";

/**
 * Siembra una tasa OFICIAL del BCV (company_id nulo) como la guardaría el refresco automático.
 *
 * Desde la migración 66 solo existe la tasa del BCV (ADR-0064 §1): ninguna empresa teclea la
 * suya, y la API rechaza la carga manual. Los E2E que necesitan una tasa concreta la siembran
 * así, con una FUENTE propia del fichero, y la borran al terminar con `borrarTasasOficiales`:
 * la tabla es global y la de un fichero no debe regir en el siguiente.
 *
 * A igual día manda la guardada más tarde (`rate_for`), así que sembrar después de otra del
 * mismo día la sustituye para el resto del fichero.
 */
export async function sembrarTasaOficial(
  sql: ReturnType<typeof createClient>,
  tasa: { rate: string; rate_date: string; source: string },
): Promise<void> {
  await sql`
    insert into public.exchange_rates
      (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
    values ('USD', 'VES', ${tasa.rate}::numeric, ${tasa.source}, ${tasa.rate_date}::date, now())`;
}

/** Borra las tasas oficiales que un fichero sembró, por el prefijo de su fuente. */
export async function borrarTasasOficiales(
  sql: ReturnType<typeof createClient>,
  prefijoFuente: string,
): Promise<void> {
  await sql`
    delete from public.exchange_rates
     where company_id is null and source like ${`${prefijoFuente}%`}`;
}
