import postgres from "postgres";
import type { Sql } from "postgres";

/**
 * EL ÚNICO `import` DE `postgres` DE TODO EL REPOSITORIO.
 *
 * Está aislado en su propio módulo a propósito: así la regla
 * `db-client-only-in-db-package` de `.dependency-cruiser.cjs` tiene exactamente
 * una arista que permitir, y cualquier otra es una violación.
 *
 * Sin este archivo la regla sería INERTE — no habría ninguna arista `postgres`
 * en el grafo, la regla no coincidiría con nada y daría verde para siempre. Es
 * el mismo fallo que ADR-0021 documenta como caso 1 del patrón «ausencia de
 * fallo leída como éxito»: un gate de fronteras que no resuelve nada y por eso
 * no encuentra nada. Comprobado en los dos sentidos: con esta arista presente,
 * añadir un `import postgres` en otro paquete pone la regla en rojo.
 */
export function createClient(connectionString: string): Sql {
  return postgres(connectionString, {
    // Obligatorio con pooling en modo transacción. Ver el comentario de
    // `createClient` en `./transaction.ts`.
    prepare: false,

    // Sin conversiones automáticas de tipos. El dinero viaja como string
    // (`numeric(24,8)` -> texto) y cualquier transformación implícita a
    // `number` sería una vía de entrada de coma flotante en importes, que es
    // la regla 7 de CLAUDE.md.
    types: {},
  });
}
