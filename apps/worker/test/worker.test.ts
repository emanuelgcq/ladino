import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, withTransaction } from "@ladino/db";
import type { SeniatTransmitter, EventoOutbox } from "@ladino/fiscal";
import {
  procesarLote,
  backoffSegundos,
  reaperOutbox,
  reaperIdempotencia,
  purgarIdempotencia,
} from "../src/index.js";

/**
 * Integración contra la base local. Lo que este fichero demuestra, en orden
 * de importancia:
 *
 *   1. ADR-0028 §verificación: el transmisor se SUSTITUYE sin tocar el dominio
 *      ni el consumo — aquí entra un transmisor FALSO que registra llamadas, y
 *      `procesarLote` no sabe la diferencia.
 *   2. El consumo es de dos fases y at-least-once: fallo → pending con
 *      backoff; intentos agotados → dead; éxito → published con fecha.
 *   3. Los dos reapers devuelven al estado reintentable lo que un proceso
 *      muerto dejó colgado.
 */

// `postgres` siembra y comprueba; el worker bajo prueba corre como
// `ladino_worker` (ADR-0031): dos tablas por GRANT y nada más. Un privilegio
// que falte se ve aquí, no en producción.
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_WORKER = "postgres://ladino_worker:ladino_worker@127.0.0.1:54322/postgres";
const TENANT = "abababab-abab-4bab-8bab-000000000001";
const USUARIO = "abababab-abab-4bab-8bab-00000000000a";

let sql: ReturnType<typeof createClient>;
let sqlWorker: ReturnType<typeof createClient>;

class FakeTransmitter implements SeniatTransmitter {
  readonly recibidos: EventoOutbox[] = [];
  constructor(
    private readonly fallar: boolean = false,
    /** Gancho para simular lo que pasa DURANTE la entrega (carreras, cuelgues). */
    private readonly durante?: (e: EventoOutbox) => Promise<void>,
  ) {}
  async transmit(e: EventoOutbox): Promise<void> {
    this.recibidos.push(e);
    if (this.durante) await this.durante(e);
    if (this.fallar) throw new Error("SENIAT simulado: no disponible");
  }
}

async function sembrarOutbox(n: number, extra: Record<string, unknown> = {}): Promise<string[]> {
  const ids: string[] = [];
  // Con actor de sistema, como haría un caso de uso: set_row_provenance() no
  // deja created_by en NULL en silencio.
  await withTransaction(sql, { kind: "system" }, async ({ sql: tx }) => {
    for (let i = 0; i < n; i++) {
      const [r] = await tx<{ id: string }[]>`
        insert into public.outbox
          (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version,
           payload, status, attempts, available_at)
        values (${TENANT}, null, 'company', ${crypto.randomUUID()}, 'company.created', 1,
                ${tx.json({ i })},
                ${(extra["status"] as string) ?? "pending"},
                ${(extra["attempts"] as number) ?? 0},
                ${tx.unsafe(`(${(extra["available_at"] as string) ?? "now()"})::timestamptz`)})
        returning id`;
      ids.push(r!.id);
    }
  });
  return ids;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlWorker = createClient(URL_WORKER);
  await sql`insert into auth.users (id) values (${USUARIO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${USUARIO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant worker')
             on conflict (id) do nothing`;
  });
  // El worker es GLOBAL por diseño: toma lo `pending` de todos los tenants, sin
  // filtro. La base local es compartida con los tests de la API, que dejan
  // eventos `company.created` pendientes — y este suite se los llevaría. Por
  // eso (a) se drena todo antes de empezar, y (b) cada aserción mira SU tenant y
  // los contadores globales se acotan por abajo, no por igualdad. La primera
  // versión asertaba `publicados: 3` y pasaba sola pero fallaba dentro de
  // `verify` con 8: cinco filas ajenas. Un test que depende del orden de los
  // suites no es un test.
  while ((await procesarLote(sqlWorker, new FakeTransmitter())).publicados > 0) {
    /* drenar */
  }
});

afterAll(async () => {
  await sql`delete from public.outbox where tenant_id = ${TENANT}`;
  await sql`delete from public.idempotency_keys where tenant_id = ${TENANT}`;
  await sql.end();
  await sqlWorker.end();
});

beforeEach(async () => {
  await sql`delete from public.outbox where tenant_id = ${TENANT}`;
  await sql`delete from public.idempotency_keys where tenant_id = ${TENANT}`;
});

describe("consumo del outbox", () => {
  it("ADR-0028: un transmisor FALSO sustituye al nulo sin tocar nada más, y recibe los eventos", async () => {
    const ids = await sembrarOutbox(3);
    const fake = new FakeTransmitter();

    const r = await procesarLote(sqlWorker, fake);

    expect(r.publicados).toBeGreaterThanOrEqual(3);
    expect(r).toMatchObject({ reintentos: 0, muertos: 0 });
    const mios = fake.recibidos.filter((e) => e.tenantId === TENANT);
    expect(mios.map((e) => e.id).sort()).toEqual([...ids].sort());
    expect(mios[0]?.eventType).toBe("company.created");
    const filas = await sql<{ status: string; published_at: string | null }[]>`
      select status, published_at from public.outbox where tenant_id = ${TENANT}`;
    expect(filas.every((f) => f.status === "published" && f.published_at !== null)).toBe(true);
  });

  it("fallo de entrega → pending con backoff hacia el futuro y last_error, NO published", async () => {
    await sembrarOutbox(1);
    const r = await procesarLote(sqlWorker, new FakeTransmitter(true));

    expect(r.publicados).toBe(0); // el transmisor falla para todos
    expect(r.reintentos).toBeGreaterThanOrEqual(1);
    const [f] = await sql<
      { status: string; attempts: number; last_error: string; futuro: boolean }[]
    >`
      select status, attempts, last_error, available_at > now() as futuro
        from public.outbox where tenant_id = ${TENANT}`;
    expect(f?.status).toBe("pending");
    expect(f?.attempts).toBe(1);
    expect(f?.last_error).toContain("SENIAT simulado");
    expect(f?.futuro).toBe(true); // el backoff lo empujó: no se reintenta en caliente
  });

  it("intentos agotados → dead, con el motivo", async () => {
    await sembrarOutbox(1, { attempts: 7 }); // el siguiente será el 8.º
    const r = await procesarLote(sqlWorker, new FakeTransmitter(true), { maxIntentos: 8 });

    expect(r.publicados).toBe(0);
    expect(r.muertos).toBeGreaterThanOrEqual(1);
    const [f] = await sql<{ status: string; last_error: string }[]>`
      select status, last_error from public.outbox where tenant_id = ${TENANT}`;
    expect(f?.status).toBe("dead");
    expect(f?.last_error).toContain("SENIAT simulado");
  });

  it("una fila con available_at en el futuro NO se toma: el backoff se respeta", async () => {
    await sembrarOutbox(1, { available_at: "now() + interval '1 hour'" });
    const fake = new FakeTransmitter();
    const r = await procesarLote(sqlWorker, fake);
    expect(r.muertos).toBe(0);
    expect(fake.recibidos.filter((e) => e.tenantId === TENANT)).toHaveLength(0);
    const [f] = await sql<{ status: string }[]>`
      select status from public.outbox where tenant_id = ${TENANT}`;
    expect(f?.status).toBe("pending");
  });

  it("backoff exponencial con jitter: crece, tiene techo, y varía", () => {
    expect(backoffSegundos(1, () => 0.5)).toBe(2);
    expect(backoffSegundos(5, () => 0.5)).toBe(32);
    expect(backoffSegundos(20, () => 0.5)).toBe(3600); // techo de 1 h
    expect(backoffSegundos(4, () => 0)).toBeLessThan(backoffSegundos(4, () => 1));
  });
});

describe("los dos reapers", () => {
  it("outbox: un in_flight huérfano vuelve a pending; uno con intentos agotados muere", async () => {
    // Huérfanos: in_flight tomados hace 20 min (available_at = «tomada en»).
    const [vivo] = await sembrarOutbox(1, {
      status: "in_flight",
      attempts: 2,
      available_at: "now() - interval '20 minutes'",
    });
    const [agotado] = await sembrarOutbox(1, {
      status: "in_flight",
      attempts: 8,
      available_at: "now() - interval '20 minutes'",
    });
    // Y uno RECIÉN tomado, que NO es huérfano y no debe tocarse.
    const [reciente] = await sembrarOutbox(1, { status: "in_flight", attempts: 1 });

    const r = await reaperOutbox(sqlWorker, { minutosHuerfana: 10, maxIntentos: 8 });
    expect(r).toEqual({ devueltas: 1, muertas: 1 });

    const estado = Object.fromEntries(
      (
        await sql<{ id: string; status: string }[]>`
          select id, status from public.outbox where tenant_id = ${TENANT}`
      ).map((f) => [f.id, f.status]),
    );
    expect(estado[vivo!]).toBe("pending");
    expect(estado[agotado!]).toBe("dead");
    expect(estado[reciente!]).toBe("in_flight"); // no era huérfano
  });

  it("idempotencia: un in_progress huérfano pasa a failed (reintentable); uno reciente no", async () => {
    // No se puede insertar con created_at antiguo (lo pone el trigger), así que
    // el «huérfano» se simula con un umbral de 0 minutos y el «reciente» con
    // un umbral de 15: la misma fila, dos lecturas del reloj.
    await withTransaction(sql, { kind: "user", userId: USUARIO }, async ({ sql: tx }) => {
      await tx`insert into public.idempotency_keys
        (tenant_id, company_id, actor_id, key, endpoint, request_hash, expires_at)
        values (${TENANT}, null, ${USUARIO}, 'K-REAPER', 'POST /x', ${Buffer.alloc(32)},
                now() + interval '1 hour')`;
    });

    const noToca = await reaperIdempotencia(sqlWorker, { minutosHuerfana: 15 });
    expect(noToca.liberadas).toBe(0);

    const libera = await reaperIdempotencia(sqlWorker, { minutosHuerfana: 0 });
    expect(libera.liberadas).toBe(1);
    const [f] = await sql<{ status: string; response: { body: { code: string } } }[]>`
      select status, response from public.idempotency_keys where key = 'K-REAPER'`;
    expect(f?.status).toBe("failed");
    expect(f?.response.body.code).toBe("IDEMPOTENCY_ORPHANED"); // fue el reaper, no el caso de uso
  });
});

describe("variantes rotas de la auditoría de S0.6a (F-9, F-12, F-13)", () => {
  it("F-9: un T2 tardío NO pisa la reserva de otro worker — el testigo `attempts` lo detecta", async () => {
    const [id] = await sembrarOutbox(1);
    // Durante la entrega del worker A: el reaper (umbral 0) la cree huérfana y
    // la devuelve; «pasa el tiempo» del backoff; el worker B la toma y la
    // publica. Cuando A vuelve con su T2, la fila ya no es suya.
    const fakeA = new FakeTransmitter(false, async () => {
      await reaperOutbox(sqlWorker, { minutosHuerfana: 0 });
      await sql`update public.outbox set available_at = now() where id = ${id}`;
      const b = await procesarLote(sqlWorker, new FakeTransmitter());
      expect(b.publicados).toBeGreaterThanOrEqual(1);
    });

    const a = await procesarLote(sqlWorker, fakeA);

    expect(a.reservasPerdidas).toBe(1); // A lo supo, y no lo contó como publicado
    expect(a.publicados).toBe(0);
    const [f] = await sql<{ status: string; attempts: number }[]>`
      select status, attempts from public.outbox where id = ${id}`;
    expect(f).toEqual({ status: "published", attempts: 2 }); // la de B, intacta
  });

  it("F-9: una entrega que se CUELGA no deja la fila in_flight: el plazo la devuelve a pending", async () => {
    await sembrarOutbox(1);
    const colgado = new FakeTransmitter(false, () => new Promise(() => {}));
    const r = await procesarLote(sqlWorker, colgado, { timeoutMs: 50 });
    expect(r.reintentos).toBeGreaterThanOrEqual(1);
    const [f] = await sql<{ status: string; last_error: string }[]>`
      select status, last_error from public.outbox where tenant_id = ${TENANT}`;
    expect(f?.status).toBe("pending");
    expect(f?.last_error).toContain("sin respuesta en 50 ms");
  });

  it("borde inferior del off-by-one: attempts 6 + maxIntentos 8 → pending, no dead", async () => {
    await sembrarOutbox(1, { attempts: 6 });
    await procesarLote(sqlWorker, new FakeTransmitter(true), { maxIntentos: 8 });
    const [f] = await sql<{ status: string; attempts: number }[]>`
      select status, attempts from public.outbox where tenant_id = ${TENANT}`;
    expect(f).toEqual({ status: "pending", attempts: 7 });
  });

  it("F-13: el reaper devuelve con BACKOFF, no en caliente", async () => {
    await sembrarOutbox(1, {
      status: "in_flight",
      attempts: 3,
      available_at: "now() - interval '20 minutes'",
    });
    await reaperOutbox(sqlWorker, { minutosHuerfana: 10 });
    const [f] = await sql<{ status: string; futuro: boolean; last_error: string }[]>`
      select status, available_at > now() as futuro, last_error
        from public.outbox where tenant_id = ${TENANT}`;
    expect(f?.status).toBe("pending");
    expect(f?.futuro).toBe(true);
    expect(f?.last_error).toContain("reaper");
  });

  it("F-12: la purga borra claves caducadas más allá de la retención y respeta las vigentes", async () => {
    await withTransaction(sql, { kind: "user", userId: USUARIO }, async ({ sql: tx }) => {
      await tx`insert into public.idempotency_keys
        (tenant_id, company_id, actor_id, key, endpoint, request_hash, expires_at, status, response)
        values (${TENANT}, null, ${USUARIO}, 'K-PURGA', 'POST /x', ${Buffer.alloc(32)},
                now() + interval '1 hour', 'completed', '{"status":201}'::jsonb)`;
    });
    // El CHECK expires_at > created_at impide fabricar una clave caducada, así
    // que el «paso del tiempo» se simula con una retención NEGATIVA: -1 día
    // borra lo que caduca antes de mañana. La consulta es la misma.
    const vigente = await purgarIdempotencia(sqlWorker, { diasRetencion: 7 });
    expect(vigente.borradas).toBe(0);
    const [antes] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.idempotency_keys where key = 'K-PURGA'`;
    expect(antes?.n).toBe(1);

    const purga = await purgarIdempotencia(sqlWorker, { diasRetencion: -1 });
    expect(purga.borradas).toBeGreaterThanOrEqual(1);
    const [despues] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.idempotency_keys where key = 'K-PURGA'`;
    expect(despues?.n).toBe(0);
  });
});
