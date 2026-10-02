import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createHash } from "node:crypto";
import { createClient, withTransaction } from "@ladino/db";
import {
  procesarFilaDeTrabajo,
  procesarTrabajoImportacion,
  SIN_PERMISO_DE_PRECIO,
} from "@ladino/domain";
import { buildApp } from "../src/app.js";

/**
 * La importación como TRABAJO (ADR-0074; hallazgos C-01, C-04 y C-05 del recorrido 2026-09-24),
 * de extremo a extremo por el camino de producción: JWT → scope → handler → dominio → Postgres
 * como `ladino_api`. El procesamiento del trabajo lo hace el worker; aquí se invoca el MISMO
 * paso del dominio que el worker llama, con la conexión de la API.
 *
 * Lo que solo produce el camino que se dice probar:
 *   · C-01: «0.500» con formato de coma decimal se RECHAZA con la palabra «ambiguo» y su fila —
 *     el camino viejo lo guardaba como 500 y contaba la fila como buena;
 *   · C-05: la existencia de un servicio sale como AVISO en la vista previa (antes: nada);
 *   · C-04: el mismo archivo devuelve EL MISMO trabajo (mismo id, `reused: true`), y reprocesar
 *     no crea un segundo producto.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";

const TENANT = "e2ee2e01-0000-4000-8000-000000000001";
const COMPANY = "e2ee2e01-0000-4000-8000-000000000002";
const GESTOR = "e2ee2e01-0000-4000-8000-00000000000a";
/** product.manage + price_list.manage: quien puede CAMBIAR el precio de un código existente (H2). */
const PRECIOS = "e2ee2e01-0000-4000-8000-00000000000b";
const RUN = Date.now().toString(36);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;

async function tokenDe(sub: string): Promise<string> {
  return new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);
}

interface OpcionesSubida {
  usuario?: string;
  /** Llave de idempotencia; por omisión una nueva en /jobs. `null`: sin llave. */
  key?: string | null;
  nombre?: string;
  tipo?: string;
}

/** El multipart A MANO, con el boundary que se pida: el mismo archivo con otro boundary (H4). */
function multipart(
  boundary: string,
  archivo: Uint8Array,
  nombre: string,
  tipo: string,
  numberFormat?: string,
): Uint8Array {
  const enc = new TextEncoder();
  const CRLF = "\r\n";
  const partes: Uint8Array[] = [
    enc.encode(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${nombre}"${CRLF}` +
        `Content-Type: ${tipo}${CRLF}${CRLF}`,
    ),
    archivo,
    enc.encode(CRLF),
  ];
  if (numberFormat !== undefined) {
    partes.push(
      enc.encode(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="number_format"${CRLF}${CRLF}` +
          `${numberFormat}${CRLF}`,
      ),
    );
  }
  partes.push(enc.encode(`--${boundary}--${CRLF}`));
  const total = partes.reduce((n, x) => n + x.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const x of partes) {
    out.set(x, i);
    i += x.length;
  }
  return out;
}

async function subir(
  ruta: string,
  contenido: string | Uint8Array,
  numberFormat?: "comma_decimal" | "dot_decimal",
  opciones: OpcionesSubida = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const bytes = typeof contenido === "string" ? new TextEncoder().encode(contenido) : contenido;
  const boundary = `----e2e${crypto.randomUUID().replace(/-/g, "")}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await tokenDe(opciones.usuario ?? GESTOR)}`,
    "X-Company-Id": COMPANY,
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
  };
  const key =
    opciones.key === undefined && ruta.endsWith("/jobs") ? crypto.randomUUID() : opciones.key;
  if (key) headers["Idempotency-Key"] = key;
  const r = await app.request(ruta, {
    method: "POST",
    headers,
    body: multipart(
      boundary,
      bytes,
      opciones.nombre ?? "productos.csv",
      opciones.tipo ?? "text/csv",
      numberFormat,
    ),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function leerTrabajo(id: string): Promise<Record<string, unknown>> {
  const r = await app.request(`/v1/products/import/jobs/${id}`, {
    headers: { Authorization: `Bearer ${await tokenDe(GESTOR)}`, "X-Company-Id": COMPANY },
  });
  expect(r.status).toBe(200);
  return (await r.json()) as Record<string, unknown>;
}

interface FilaPrevia {
  row: number;
  status: "ready" | "rejected";
  name?: string;
  message?: string;
  warnings: string[];
  price?: { amount: string; currency: string };
  initial_stock?: { quantity: string; unit_cost: { amount: string; currency: string } } | null;
  reference_cost?: { amount: string; currency: string } | null;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({
    sql: sqlApi,
    auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER },
  });
  await sql`insert into auth.users (id) values (${GESTOR}), (${PRECIOS}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${GESTOR}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e importación')
             on conflict (id) do nothing`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name)
             values (${COMPANY}, ${TENANT}, 'J-E2EIMPORT', 'Empresa e2e importación')
             on conflict (id) do nothing`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             ('e2ee2e01-0000-4000-8000-0000000000e1', null, 'e2e_import_gestor', 'Gestor', false),
             ('e2ee2e01-0000-4000-8000-0000000000e2', null, 'e2e_import_precios', 'Precios', false)
             on conflict (id) do nothing`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             ('e2ee2e01-0000-4000-8000-0000000000e1', 'product.manage'),
             ('e2ee2e01-0000-4000-8000-0000000000e2', 'product.manage'),
             ('e2ee2e01-0000-4000-8000-0000000000e2', 'price_list.manage')
             on conflict do nothing`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values ('e2ee2e01-0000-4000-8000-0000000000f1', ${TENANT}, ${COMPANY},
                     'E2E-IW1', 'Principal')
             on conflict (id) do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             ('e2ee2e01-0000-4000-8000-0000000000a1', ${TENANT}, ${GESTOR}),
             ('e2ee2e01-0000-4000-8000-0000000000b1', ${TENANT}, ${PRECIOS})
             on conflict (id) do nothing`;
    await tx`insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
             ('e2ee2e01-0000-4000-8000-0000000000a2', ${TENANT},
              'e2ee2e01-0000-4000-8000-0000000000a1', 'e2ee2e01-0000-4000-8000-0000000000e1', null),
             ('e2ee2e01-0000-4000-8000-0000000000b2', ${TENANT},
              'e2ee2e01-0000-4000-8000-0000000000b1', 'e2ee2e01-0000-4000-8000-0000000000e2', null)
             on conflict (id) do nothing`;
  });
});

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

describe(
  "importación de productos: formato declarado, vista previa y trabajo (ADR-0074)",
  { timeout: 60_000 },
  () => {
    it("C-01: «0,500» con coma decimal da 0,5; «0.500» con coma decimal se rechaza como ambiguo, con su fila", async () => {
      const csv =
        "Nombre;Precio;Código;Existencia;Costo\r\n" +
        `Arandela coma ${RUN};0,500;ARC-${RUN};1;0,125\r\n` +
        `Arandela punto ${RUN};0.500;ARP-${RUN};1;0.125\r\n`;
      const r = await subir("/v1/products/import/preview", csv);
      expect(r.status).toBe(200);
      expect(r.json["number_format"]).toBe("comma_decimal");
      const filas = r.json["rows"] as FilaPrevia[];
      const coma = filas.find((f) => f.row === 2)!;
      expect(coma.status).toBe("ready");
      expect(coma.price).toEqual({ amount: "0.5", currency: "USD" });
      expect(coma.initial_stock!.unit_cost.amount).toBe("0.125");
      const punto = filas.find((f) => f.row === 3)!;
      expect(punto.status).toBe("rejected");
      expect(punto.message).toContain("ambiguo");
      expect(punto.message).toContain("0.500");
      expect(r.json["rejected"]).toBe(1);
      expect((r.json["rejected_rows"] as FilaPrevia[]).map((f) => f.row)).toEqual([3]);

      // Con el formato de punto decimal, la MISMA celda «0.500» es 0,5 sin ambigüedad.
      const conPunto = await subir("/v1/products/import/preview", csv, "dot_decimal");
      const filasPunto = conPunto.json["rows"] as FilaPrevia[];
      expect(filasPunto.find((f) => f.row === 3)!.price).toEqual({
        amount: "0.5",
        currency: "USD",
      });
      expect(filasPunto.find((f) => f.row === 2)!.status).toBe("rejected");
    });

    it("C-01 también por el camino de siempre (/v1/products/import): «0.500» ya no entra como 500", async () => {
      const csv = "Nombre;Precio\r\n" + `Arandela vieja ${RUN};0.500\r\n`;
      const r = await subir("/v1/products/import", csv);
      expect(r.status).toBe(201);
      const filas = r.json["rows"] as { status: string; message?: string }[];
      expect(filas[0]!.status).toBe("error");
      expect(filas[0]!.message).toContain("ambiguo");
      const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.products
       where company_id = ${COMPANY} and name = ${`Arandela vieja ${RUN}`}`;
      expect(n!.n).toBe(0);
    });

    it("C-05: la existencia de un servicio y el costo sin existencia salen como AVISO en la vista previa", async () => {
      const csv =
        "Nombre;Precio;Código;Existencia;Costo;Es servicio\r\n" +
        `Transporte especial ${RUN};50,00;TRS-${RUN};10;;sí\r\n` +
        `Tornillo referencia ${RUN};1,00;TRF-${RUN};;0,40;no\r\n`;
      const r = await subir("/v1/products/import/preview", csv);
      expect(r.status).toBe(200);
      const filas = r.json["rows"] as FilaPrevia[];
      const servicio = filas.find((f) => f.row === 2)!;
      expect(servicio.status).toBe("ready");
      expect(servicio.initial_stock ?? null).toBeNull();
      expect(servicio.warnings.join(" ")).toContain("servicio");
      expect(servicio.warnings.join(" ")).toContain("existencia");
      const referencia = filas.find((f) => f.row === 3)!;
      expect(referencia.status).toBe("ready");
      expect(referencia.reference_cost).toEqual({ amount: "0.4", currency: "USD" });
      expect(referencia.warnings.join(" ")).toContain("costo de referencia");
    });

    it("C-04: el mismo archivo devuelve el MISMO trabajo, y procesarlo dos veces no duplica", async () => {
      // El costo en Bs: el trabajo no depende de que otro fichero haya sembrado una tasa BCV.
      const csv =
        "Nombre;Precio;Código;Existencia;Costo;Moneda costo\r\n" +
        `Clavo trabajo ${RUN};0,50;CLT-${RUN};10;20,00;Bs\r\n` +
        `Sin código trabajo ${RUN};2,00;;;;\r\n` +
        `Ilegible trabajo ${RUN};regalado;;;;\r\n`;
      const primero = await subir("/v1/products/import/jobs", csv);
      expect(primero.status).toBe(202);
      const id = primero.json["id"] as string;
      expect(primero.json["status"]).toBe("pending");
      expect(primero.json["total_rows"]).toBe(3);
      expect(primero.json["reused"]).toBe(false);

      const segundo = await subir("/v1/products/import/jobs", csv);
      expect(segundo.status).toBe(200);
      expect(segundo.json["id"]).toBe(id);
      expect(segundo.json["reused"]).toBe(true);

      // Una fila, y el proceso «muere»: el reintento sigue desde la fila siguiente.
      const parcial = await procesarTrabajoImportacion(sqlApi, id, GESTOR, { maxFilas: 1 });
      expect(parcial.procesadas).toBe(1);
      expect(parcial.terminado).toBe(false);
      const aMedias = await leerTrabajo(id);
      expect(aMedias["status"]).toBe("running");
      expect(aMedias["processed_rows"]).toBe(1);

      await procesarTrabajoImportacion(sqlApi, id, GESTOR);
      await procesarTrabajoImportacion(sqlApi, id, GESTOR); // y otra vez: nada que hacer

      const final = await leerTrabajo(id);
      expect(final["status"]).toBe("done");
      expect(final["processed_rows"]).toBe(3);
      expect(final["created_count"]).toBe(2);
      expect(final["updated_count"]).toBe(0);
      expect(final["rejected_count"]).toBe(1);
      const informe = final["report"] as { row: number; status: string; message?: string }[];
      expect(informe.map((f) => f.status)).toEqual(["created", "created", "rejected"]);
      expect(informe[2]!.row).toBe(4);
      expect(informe[2]!.message).toContain("precio");

      // Reimportar el mismo archivo: mismo trabajo, ningún producto de más.
      const tercero = await subir("/v1/products/import/jobs", csv);
      expect(tercero.json["id"]).toBe(id);
      const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.products
       where company_id = ${COMPANY}
         and name in (${`Clavo trabajo ${RUN}`}, ${`Sin código trabajo ${RUN}`})`;
      expect(n!.n).toBe(2);
      const [kardex] = await sql<{ q: string }[]>`
      select coalesce(sum(b.quantity), 0)::text as q
        from public.stock_balances b join public.products p on p.id = b.product_id
       where p.company_id = ${COMPANY} and p.sku = ${`CLT-${RUN}`}`;
      expect(kardex!.q).toBe("10.00000000");
    });

    it("H2: cambiar el precio de un código existente exige price_list.manage — sin él, fila rechazada y precio intacto", async () => {
      const csv = "Nombre;Precio;Código\r\n" + `Clavo trabajo ${RUN};0,60;CLT-${RUN}\r\n`;
      const r = await subir("/v1/products/import/jobs", csv);
      const id = r.json["id"] as string;
      await procesarTrabajoImportacion(sqlApi, id, GESTOR);
      const final = await leerTrabajo(id);
      const fila = (final["report"] as { status: string; message?: string }[])[0]!;
      expect(fila.status).toBe("rejected");
      expect(fila.message).toContain("Necesitas el permiso para cambiar precios");
      const [precio] = await sql<{ amount: string }[]>`
      select i.amount::text as amount
        from public.price_list_items i join public.products p on p.id = i.product_id
       where p.company_id = ${COMPANY} and p.sku = ${`CLT-${RUN}`}
         and i.effective_from <= now() and (i.effective_to is null or i.effective_to > now())
       order by i.effective_from desc limit 1`;
      expect(precio!.amount).toBe("0.50000000");
    });

    it("C-04: el código es la llave — otro archivo con el mismo código ACTUALIZA, no duplica ni recarga existencia", async () => {
      const csv =
        "Nombre;Precio;Código;Existencia;Costo;Moneda costo\r\n" +
        `Clavo trabajo ${RUN};0,75;CLT-${RUN};10;20,00;Bs\r\n`;
      // H2: cambiar el precio de un código existente exige price_list.manage — lo hace PRECIOS.
      const r = await subir("/v1/products/import/jobs", csv, undefined, { usuario: PRECIOS });
      expect(r.status).toBe(202);
      const id = r.json["id"] as string;
      await procesarTrabajoImportacion(sqlApi, id, PRECIOS);
      const final = await leerTrabajo(id);
      expect(final["created_count"]).toBe(0);
      expect(final["updated_count"]).toBe(1);
      const fila = (final["report"] as { status: string; warnings: string[] }[])[0]!;
      expect(fila.status).toBe("updated");
      expect(fila.warnings.join(" ")).toContain("existencia");

      const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.products
       where company_id = ${COMPANY} and sku = ${`CLT-${RUN}`}`;
      expect(n!.n).toBe(1);
      const [kardex] = await sql<{ q: string }[]>`
      select coalesce(sum(b.quantity), 0)::text as q
        from public.stock_balances b join public.products p on p.id = b.product_id
       where p.company_id = ${COMPANY} and p.sku = ${`CLT-${RUN}`}`;
      expect(kardex!.q).toBe("10.00000000");
      const [precio] = await sql<{ amount: string }[]>`
      select i.amount::text as amount
        from public.price_list_items i join public.products p on p.id = i.product_id
       where p.company_id = ${COMPANY} and p.sku = ${`CLT-${RUN}`}
         and i.effective_from <= now() and (i.effective_to is null or i.effective_to > now())
       order by i.effective_from desc limit 1`;
      expect(precio!.amount).toBe("0.75000000");
    });
    // ── Revisión de la familia importación (H1–H11) ──────────────────────────

    it("H1: una fila de 201 caracteres entre dos buenas → rechazada con su motivo; el trabajo termina", async () => {
      const largo = "N".repeat(201);
      const csv =
        "Nombre;Precio\r\n" +
        `Buena uno ${RUN};1,00\r\n` +
        `${largo};1,00\r\n` +
        `Buena dos ${RUN};2,00\r\n`;
      const previa = await subir("/v1/products/import/preview", csv);
      const fila = (previa.json["rows"] as FilaPrevia[]).find((f) => f.row === 3)!;
      expect(fila.status).toBe("rejected");
      expect(fila.message).toContain("200");
      const r = await subir("/v1/products/import/jobs", csv);
      const id = r.json["id"] as string;
      await procesarTrabajoImportacion(sqlApi, id, GESTOR);
      const final = await leerTrabajo(id);
      expect(final["status"]).toBe("done");
      expect(final["created_count"]).toBe(2);
      expect(final["rejected_count"]).toBe(1);
    });

    it("H1: si la BASE rechaza una fila (dato que pasó la interpretación), la fila se rechaza y el trabajo sigue", async () => {
      // Una fila escrita a mano en el trabajo, sin pasar por la validación de largos: la base la
      // rechaza con 23514 y el savepoint la deja como rechazada, no como caída del trabajo.
      const hash = createHash("sha256").update(`${RUN}-h1b`).digest("hex");
      const filas = [
        {
          row: 2,
          status: "ready",
          warnings: [],
          name: "M".repeat(201),
          is_service: false,
          price: { amount: "1", currency: "USD" },
          initial_stock: null,
          reference_cost: null,
        },
        {
          row: 3,
          status: "ready",
          warnings: [],
          name: `Tras la mala ${RUN}`,
          is_service: false,
          price: { amount: "1", currency: "USD" },
          initial_stock: null,
          reference_cost: null,
        },
      ];
      const id = await sql.begin(async (tx) => {
        await tx`select set_config('ladino.actor_id', ${GESTOR}, true)`;
        const [t] = await tx<{ id: string }[]>`
        insert into public.product_import_jobs
          (tenant_id, company_id, file_name, file_hash, number_format, row_count, rows)
        values (${TENANT}, ${COMPANY}, 'a-mano.csv', ${hash}, 'comma_decimal', 2,
                ${tx.json(filas as never)})
        returning id`;
        return t!.id;
      });
      await procesarTrabajoImportacion(sqlApi, id, GESTOR);
      const final = await leerTrabajo(id);
      expect(final["status"]).toBe("done");
      const informe = final["report"] as { status: string; message?: string }[];
      expect(informe.map((f) => f.status)).toEqual(["rejected", "created"]);
      expect(informe[0]!.message).toContain("no se pudo guardar");
    });

    it("H1-d: el archivo de un trabajo FAILED se puede volver a subir y crea un trabajo nuevo", async () => {
      const csv = "Nombre;Precio\r\n" + `Tras el fallo ${RUN};1,00\r\n`;
      const a = await subir("/v1/products/import/jobs", csv);
      expect(a.status).toBe(202);
      await sql`update public.product_import_jobs set status = 'failed', finished_at = now(),
                     last_error = 'simulado' where id = ${a.json["id"] as string}`;
      const b = await subir("/v1/products/import/jobs", csv);
      expect(b.status).toBe(202);
      expect(b.json["id"]).not.toBe(a.json["id"]);
    });

    it("H4: /jobs exige Idempotency-Key; misma llave + mismo archivo con otro boundary → la misma respuesta; otro archivo → 409", async () => {
      const csv = "Nombre;Precio\r\n" + `Idempotente ${RUN};1,00\r\n`;
      const sinLlave = await subir("/v1/products/import/jobs", csv, undefined, {
        key: null,
      });
      expect(sinLlave.status).toBe(400);
      expect(sinLlave.json["code"]).toBe("IDEMPOTENCY_KEY_REQUIRED");
      const key = crypto.randomUUID();
      // `subir` estrena boundary en cada llamada: el cuerpo crudo es distinto, el archivo no.
      const a = await subir("/v1/products/import/jobs", csv, undefined, { key });
      const b = await subir("/v1/products/import/jobs", csv, undefined, { key });
      expect(a.status).toBe(202);
      expect(b.status).toBe(202);
      expect(b.json["id"]).toBe(a.json["id"]);
      expect(b.json["reused"]).toBe(false); // el REPLAY de la respuesta guardada, no una relectura
      const otro = await subir(
        "/v1/products/import/jobs",
        "Nombre;Precio\r\n" + `Otro archivo ${RUN};1,00\r\n`,
        undefined,
        { key },
      );
      expect(otro.status).toBe(409);
      expect(otro.json["code"]).toBe("IDEMPOTENCY_KEY_REUSED");
      // Llave distinta con el mismo archivo: el único del esquema devuelve el mismo trabajo.
      const c = await subir("/v1/products/import/jobs", csv);
      expect(c.status).toBe(200);
      expect(c.json["reused"]).toBe(true);
      expect(c.json["id"]).toBe(a.json["id"]);
    });

    it("H5: la vista previa devuelve TODAS las filas con aviso — un servicio con existencia en la fila 12", async () => {
      const filas = Array.from({ length: 10 }, (_, i) => `Normal ${i} ${RUN};1,00;;no`);
      const csv =
        "Nombre;Precio;Existencia;Es servicio\r\n" +
        filas.join("\r\n") +
        `\r\nServicio doce ${RUN};5,00;3;sí\r\n`;
      const previa = await subir("/v1/products/import/preview", csv);
      expect((previa.json["rows"] as FilaPrevia[]).some((f) => f.row === 12)).toBe(false);
      const avisadas = previa.json["warned_rows"] as FilaPrevia[];
      expect(avisadas.map((f) => f.row)).toEqual([12]);
      expect(avisadas[0]!.warnings.join(" ")).toContain("servicio");
    });

    it("H6: con una celda de punto decimal en el archivo, «1.250» declarado con coma decimal se rechaza como ambiguo", async () => {
      const csv = "Nombre;Precio\r\n" + `Punto ${RUN};12.5\r\n` + `Miles ${RUN};1.250\r\n`;
      const previa = await subir("/v1/products/import/preview", csv);
      const filas = previa.json["rows"] as FilaPrevia[];
      expect(filas.find((f) => f.row === 2)!.status).toBe("ready");
      const miles = filas.find((f) => f.row === 3)!;
      expect(miles.status).toBe("rejected");
      expect(miles.message).toContain("ambiguo");
      expect(previa.json["suspected_format"]).toBe("dot_decimal");
    });

    it("H7: una celda con FÓRMULA de Excel se lee por su resultado, en el formato declarado", async () => {
      const { Workbook } = await import("exceljs");
      const libro = new Workbook();
      const hoja = libro.addWorksheet("Productos");
      hoja.addRow(["Nombre", "Precio", "Existencia", "Costo", "Moneda costo"]);
      hoja.addRow([`Fórmula ${RUN}`, 2, 1, { formula: "1/8", result: 0.125 }, "Bs"]);
      hoja.addRow([`Compartida ${RUN}`, 3, 1, { sharedFormula: "D2", result: 0.125 }, "Bs"]);
      const xlsx = new Uint8Array(await libro.xlsx.writeBuffer());
      const previa = await subir("/v1/products/import/preview", xlsx, undefined, {
        nombre: "formulas.xlsx",
        tipo: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const filas = previa.json["rows"] as FilaPrevia[];
      expect(filas[0]!.initial_stock!.unit_cost.amount).toBe("0.125");
      expect(filas[1]!.initial_stock!.unit_cost.amount).toBe("0.125");
    });

    it("H9: atomicidad — si la transacción muere antes del commit, ni producto ni avance", async () => {
      const csv = "Nombre;Precio\r\n" + `Atómico ${RUN};1,00\r\n`;
      const r = await subir("/v1/products/import/jobs", csv);
      const id = r.json["id"] as string;
      await expect(
        withTransaction(sqlApi, { kind: "user", userId: GESTOR }, async (uow) => {
          await uow.sql`set local role ladino_api`;
          const paso = await procesarFilaDeTrabajo(uow, id);
          expect(paso.ok).toBe(true);
          throw new Error("el proceso muere antes del commit");
        }),
      ).rejects.toThrow("muere antes del commit");
      const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.products where name = ${`Atómico ${RUN}`}`;
      expect(n!.n).toBe(0);
      const [t] = await sql<{ processed_rows: number }[]>`
      select processed_rows from public.product_import_jobs where id = ${id}`;
      expect(t!.processed_rows).toBe(0);
    });

    it("H11: el costo de referencia se GUARDA en el producto, por el trabajo y por el camino síncrono", async () => {
      const csv = "Nombre;Precio;Costo\r\n" + `Referencia trabajo ${RUN};1,00;0,40\r\n`;
      const r = await subir("/v1/products/import/jobs", csv);
      await procesarTrabajoImportacion(sqlApi, r.json["id"] as string, GESTOR);
      const sinc = await subir(
        "/v1/products/import",
        "Nombre;Precio;Costo;Moneda costo\r\n" + `Referencia síncrona ${RUN};1,00;15,00;Bs\r\n`,
      );
      expect(sinc.status).toBe(201);
      const filas = await sql<{ name: string; c: string | null; m: string | null }[]>`
      select name, reference_cost::text as c, reference_cost_currency as m from public.products
       where company_id = ${COMPANY}
         and name in (${`Referencia trabajo ${RUN}`}, ${`Referencia síncrona ${RUN}`})
       order by name desc`;
      expect(filas.map((f) => [f.c, f.m])).toEqual([
        ["0.40000000", "USD"],
        ["15.00000000", "VES"],
      ]);
    });
    // ── Re-revisión (A1, A3, A7) ─────────────────────────────────────────────

    it("A1: «el precio ya era ese» mira SOLO la lista de detal — un mayor igual no cuenta", async () => {
      const sku = `MAY-${RUN}`;
      const alta = await app.request("/v1/products/simple", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await tokenDe(PRECIOS)}`,
          "X-Company-Id": COMPANY,
          "Idempotency-Key": crypto.randomUUID(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          company_id: COMPANY,
          name: `Mayorista ${RUN}`,
          sku,
          price: { amount: "3.00", currency: "USD" },
          wholesale_price: { amount: "4.00", currency: "USD" },
        }),
      });
      expect(alta.status).toBe(201);
      const detal = async (): Promise<string> => {
        const [p] = await sql<{ amount: string }[]>`
          select i.amount::text as amount
            from public.price_list_items i
            join public.price_lists l on l.id = i.price_list_id
            join public.products p on p.id = i.product_id
           where p.company_id = ${COMPANY} and p.sku = ${sku} and l.name like 'detal%'
             and i.effective_from <= now() and (i.effective_to is null or i.effective_to > now())
           order by i.effective_from desc limit 1`;
        return p!.amount;
      };
      // GESTOR (sin price_list.manage): el detal es 3 y la fila dice 4 → cambia el precio → rechazo.
      const g = await subir(
        "/v1/products/import/jobs",
        "Nombre;Precio;Código\r\n" + `Mayorista ${RUN};4,00;${sku}\r\n`,
      );
      await procesarTrabajoImportacion(sqlApi, g.json["id"] as string, GESTOR);
      const fg = (
        (await leerTrabajo(g.json["id"] as string))["report"] as {
          status: string;
          message?: string;
        }[]
      )[0]!;
      expect(fg.status).toBe("rejected");
      expect(fg.message).toBe(SIN_PERMISO_DE_PRECIO);
      expect(await detal()).toBe("3.00000000");
      // PRECIOS: el detal pasa a 4.
      const p = await subir(
        "/v1/products/import/jobs",
        "Nombre;Precio;Código;Moneda\r\n" + `Mayorista ${RUN};4,00;${sku};USD\r\n`,
        undefined,
        { usuario: PRECIOS },
      );
      await procesarTrabajoImportacion(sqlApi, p.json["id"] as string, PRECIOS);
      const fp = (
        (await leerTrabajo(p.json["id"] as string))["report"] as {
          status: string;
        }[]
      )[0]!;
      expect(fp.status).toBe("updated");
      expect(await detal()).toBe("4.00000000");
    });

    it("A3: el resultado de una fórmula se lee como lo ve la persona en Excel (15 cifras)", async () => {
      const { Workbook } = await import("exceljs");
      const libro = new Workbook();
      const hoja = libro.addWorksheet("Productos");
      hoja.addRow(["Nombre", "Precio", "Existencia", "Costo", "Moneda costo"]);
      hoja.addRow([
        `IVA incluido ${RUN}`,
        30,
        1,
        { formula: "B2*1.16", result: 19.99 * 1.16 },
        "Bs",
      ]);
      hoja.addRow([`Ruido simple ${RUN}`, 30, 1, 0.1 + 0.2, "Bs"]);
      const xlsx = new Uint8Array(await libro.xlsx.writeBuffer());
      const previa = await subir("/v1/products/import/preview", xlsx, undefined, {
        nombre: "ruido.xlsx",
        tipo: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const filas = previa.json["rows"] as FilaPrevia[];
      expect(filas[0]!.status).toBe("ready");
      expect(filas[0]!.initial_stock!.unit_cost.amount).toBe("23.1884");
      expect(filas[1]!.initial_stock!.unit_cost.amount).toBe("0.3");
    });

    it("A7: crear el trabajo deja su audit_event con el hash, el formato y las filas", async () => {
      const r = await subir(
        "/v1/products/import/jobs",
        "Nombre;Precio\r\n" + `Auditado ${RUN};1,00\r\n`,
      );
      expect(r.status).toBe(202);
      const [ev] = await sql<{ payload: Record<string, unknown>; actor_id: string | null }[]>`
        select payload, created_by as actor_id from public.audit_events
         where aggregate_id = ${r.json["id"] as string}
           and event_type = 'product.import_job.created'`;
      expect(ev).toBeDefined();
      expect(ev!.payload["file_hash"]).toBe(r.json["file_hash"]);
      expect(ev!.payload["number_format"]).toBe("comma_decimal");
      expect(ev!.payload["row_count"]).toBe(1);
      // Y el reintento con el mismo archivo no audita un segundo trabajo que no existe.
      await subir("/v1/products/import/jobs", "Nombre;Precio\r\n" + `Auditado ${RUN};1,00\r\n`);
      const [n] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.audit_events
         where aggregate_id = ${r.json["id"] as string}
           and event_type = 'product.import_job.created'`;
      expect(n!.n).toBe(1);
    });
  },
);
