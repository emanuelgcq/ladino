import { createHash } from "node:crypto";
import type { Context, Next } from "hono";
import { withTransaction, SYSTEM_ACTOR_ID, type Actor, type Sql, type JSONValue } from "@ladino/db";

/**
 * Middleware de idempotencia — el protocolo de DOS transacciones de ADR-0018
 * (enmendado): T1 reserva la clave y commitea (`in_progress`) → corre el
 * handler → T2 la cierra (`completed`/`failed`) con la respuesta.
 *
 * Las dos fases son lo que hace OBSERVABLES los estados: con una sola
 * transacción, `in_progress` nunca se ve desde otra sesión (la fila sin commit
 * es invisible) y `failed` es inalcanzable (el rollback se la lleva). Fue el
 * hallazgo F-5 del revisor fiscal en S0.4.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EL LOOKUP FILTRA POR ACTOR. Es el contrato que el índice no puede imponer
 * solo, y el que más fácil se olvida: el índice único nunca fue la fuga, la
 * fuga es la lectura. Un lookup sin actor devuelve la reserva de OTRO usuario
 * y le entrega su respuesta con un 200. API_SPEC.md §Idempotencia.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DECISIONES DE S0.5 QUE ESTE FICHERO MATERIALIZA (estaban pendientes):
 *
 * · `request_hash` = SHA-256 de los BYTES CRUDOS del cuerpo. Sin
 *   canonicalización, a propósito: dos cuerpos semánticamente iguales con
 *   distinto formato dan un 409 espurio, que es RUIDOSO y se corrige en el
 *   cliente. Canonicalizar mal daría lo contrario: dos cuerpos distintos
 *   tratados como iguales, y eso es un replay indebido — silencioso. Entre los
 *   dos errores se elige el ruidoso, como en D5 con `endpoint`.
 * · Replay de una clave `completed`: se devuelve el STATUS y el CUERPO
 *   originales (se guardan ambos en `response`). Un replay de un 201 devuelve
 *   201: el cliente no distingue el replay del original, que es la definición
 *   de idempotencia.
 * · Clave `in_progress`: **409 `IDEMPOTENCY_IN_PROGRESS`** con `Retry-After`.
 *   No se espera en el servidor (retendría la conexión exactamente como el
 *   viaje a la imprenta que las dos fases evitan) y no se usa 425, que
 *   significa otra cosa (early data TLS).
 * · Clave `failed`: se admite el reintento — vuelve a `in_progress` y se
 *   reejecuta. Es la razón de que `failed` exista como estado.
 * · TTL operativo: 24 h. ADR-0018 fija «mínimo 24 h» y deja la política
 *   pendiente; este es el mínimo documentado, no una política nueva.
 *
 * EL BORDE DEL PROTOCOLO, escrito para quien copie esta pieza en un módulo
 * nuevo — es la frontera exacta del at-least-once de ADR-0005:
 *
 * Si el proceso muere DESPUÉS de que el caso de uso commiteara y ANTES de T2,
 * la clave queda `in_progress` con el efecto YA HECHO. Dentro del TTL no pasa
 * nada malo: el reintento recibe 409 IN_PROGRESS y ningún efecto se duplica.
 * PASADO el TTL, la clave expira del lookup y el reintento REEJECUTA el
 * cuerpo:
 *
 *   · si la operación tiene una clave natural única (companies: el RIF por
 *     tenant), la reejecución muere en 23505 → DUPLICATE. Sin doble efecto,
 *     aunque el cliente reciba un error por algo que sí ocurrió.
 *   · si NO la tiene, la reejecución ES un doble efecto. Por eso TODA
 *     operación crítica necesita su clave natural única en el esquema, además
 *     de la idempotencia — la idempotencia acota la ventana, la clave natural
 *     la cierra. Es la misma pareja que ADR-0005 exige del lado del consumidor.
 */
export interface IdempotencyConfig {
  readonly sql: Sql;
  readonly ttlHours?: number;
}

interface Reserva {
  readonly id: string;
  readonly status: "in_progress" | "completed" | "failed";
  readonly request_hash: Buffer;
  readonly response: { status: number; body: unknown } | null;
}

function hashCuerpo(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function actorId(actor: Actor): string {
  return actor.kind === "user" ? actor.userId : SYSTEM_ACTOR_ID;
}

export function idempotencyMiddleware(cfg: IdempotencyConfig) {
  const ttl = cfg.ttlHours ?? 24;

  return async (c: Context, next: Next): Promise<Response | void> => {
    const key = c.req.header("Idempotency-Key");
    if (!key) {
      // Este middleware solo se monta en rutas críticas, así que aquí la
      // ausencia es un error del cliente, no una ruta exenta.
      return c.json(
        { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Esta operación exige Idempotency-Key." },
        400,
      );
    }
    if (key.length > 255) {
      // La misma cota que el CHECK de la tabla: se corta aquí con un error que
      // dice qué pasa, no en el btree.
      return c.json(
        { code: "VALIDATION_FAILED", message: "Idempotency-Key admite hasta 255 caracteres." },
        422,
      );
    }

    const { actor } = c.get("ladino.auth");
    const ctx = c.get("ladino.ctx");
    const companyId = ctx.companyId;
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const cuerpo = hashCuerpo(bytes);
    const endpoint = `${c.req.method} ${c.req.path}`;

    // El alcance de la clave exige tenant (regla 5 de CLAUDE.md). En las
    // operaciones de alcance company viene del contexto; en las de NIVEL
    // TENANT —crear company— todavía no hay contexto de tenant y se toma del
    // CUERPO. Es estable frente a reintentos (mismo cuerpo → mismo tenant) y
    // la AUTORIZACIÓN sobre ese tenant no es asunto de este middleware: la
    // hace el caso de uso, que responderá 404/403 y dejará la clave `failed`.
    let tenantId = ctx.tenantId;
    if (tenantId === null) {
      try {
        const json = JSON.parse(new TextDecoder().decode(bytes)) as { tenant_id?: unknown };
        if (typeof json.tenant_id === "string") tenantId = json.tenant_id;
      } catch {
        /* cuerpo no-JSON: cae al error de abajo */
      }
    }
    if (tenantId === null) {
      return c.json(
        {
          code: "TENANT_SCOPE_REQUIRED",
          message: "No se pudo determinar el tenant de la operación.",
        },
        422,
      );
    }

    // ── T1: buscar la reserva (FILTRANDO POR ACTOR) o crearla ────────────────
    const t1 = await withTransaction(cfg.sql, actor, async ({ sql: tx }) => {
      const [existente] = await tx<Reserva[]>`
        select id, status, request_hash, response
          from public.idempotency_keys
         where tenant_id = ${tenantId}
           and company_id is not distinct from ${companyId}
           and actor_id = ${actorId(actor)}
           and key = ${key}
           and expires_at > now()`;

      if (!existente) {
        try {
          const [nueva] = await tx<{ id: string }[]>`
            insert into public.idempotency_keys
              (tenant_id, company_id, actor_id, key, endpoint, request_hash, expires_at)
            values (${tenantId}, ${companyId}, ${actorId(actor)}, ${key}, ${endpoint},
                    ${cuerpo}, now() + make_interval(hours => ${ttl}))
            returning id`;
          return { tipo: "reservada" as const, id: nueva!.id };
        } catch (e) {
          // Carrera: dos peticiones simultáneas con la misma clave. La segunda
          // pierde el índice único y se comporta como si hubiera visto
          // `in_progress` — porque eso es exactamente lo que es.
          if ((e as { code?: string }).code === "23505") return { tipo: "en_vuelo" as const };
          throw e;
        }
      }

      if (Buffer.compare(existente.request_hash, cuerpo) !== 0) {
        return { tipo: "reutilizada" as const };
      }
      if (existente.status === "in_progress") return { tipo: "en_vuelo" as const };
      if (existente.status === "completed") {
        return { tipo: "replay" as const, guardada: existente.response! };
      }
      // `failed`: el reintento es legítimo. Vuelve a in_progress (el CHECK
      // exige response NULL en ese estado) y se reejecuta.
      await tx`
        update public.idempotency_keys
           set status = 'in_progress', response = null, request_hash = ${cuerpo}
         where id = ${existente.id}`;
      return { tipo: "reservada" as const, id: existente.id };
    });

    switch (t1.tipo) {
      case "reutilizada":
        return c.json(
          {
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "Esta clave ya se usó con un cuerpo distinto.",
          },
          409,
        );
      case "en_vuelo":
        c.header("Retry-After", "2");
        return c.json(
          {
            code: "IDEMPOTENCY_IN_PROGRESS",
            message: "La operación original sigue en curso. Reintenta con la misma clave.",
          },
          409,
        );
      case "replay": {
        // El cliente no distingue el replay del original: mismo status, mismo
        // cuerpo. Eso ES la idempotencia.
        return c.json(t1.guardada.body as object, t1.guardada.status as 200);
      }
      case "reservada":
        break;
    }

    // ── el handler corre con la clave reservada ──────────────────────────────
    await next();

    // ── T2: cerrar la reserva con lo que respondió el handler ────────────────
    const res = c.res;
    // Tipado como JSONValue y no como unknown: viene de res.json(), así que ES
    // JSON por construcción, y el tipo de postgres.js para tx.json() lo exige.
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as JSONValue;
    const exito = res.status < 400;

    await withTransaction(cfg.sql, actor, async ({ sql: tx }) => {
      if (exito) {
        await tx`
          update public.idempotency_keys
             set status = 'completed',
                 response = ${tx.json({ status: res.status, body })}
           where id = ${t1.id}`;
      } else {
        // 4xx/5xx: la operación no produjo su efecto. `failed` deja la clave
        // reintentable, que es lo que un cliente con backoff espera.
        await tx`
          update public.idempotency_keys
             set status = 'failed',
                 response = ${tx.json({ status: res.status, body })}
           where id = ${t1.id}`;
      }
    });
  };
}
