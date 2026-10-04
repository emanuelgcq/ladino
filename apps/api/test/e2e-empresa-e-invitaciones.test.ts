import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * LA EMPRESA VIVE EN LA PESTAÑA; SEGUNDA EMPRESA E INVITACIÓN POR ENLACE (ADR-0077).
 * Hallazgos A-13/E-15 (segunda empresa), N-08/K-09 (invitación), N-03/N-06 (acceso perdido).
 *
 *   · el Titular crea OTRA empresa desde dentro: un tenant NUEVO, del que nace Titular y Dueño;
 *     la misma no se funda dos veces (clave natural: el nombre del negocio entre los suyos), y
 *     quien no es Titular de ninguna cuenta no la crea;
 *   · la invitación por enlace: el token se ve una sola vez, se acepta UNA vez, caduca, la ligada
 *     a un correo no la acepta otro, y no sirve para entrar a otro tenant;
 *   · quien pierde el acceso (desactivado o sin rol) recibe «tu acceso ya no está activo» con el
 *     nombre de quien administra, y su empresa responde ACCESS_REVOKED (404, con su frase), no el NOT_FOUND genérico;
 *     un extraño sigue recibiendo el 404 de siempre (no se revela que la empresa existe).
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const RUN = Date.now().toString(36);

const TITULAR = crypto.randomUUID();
/** Se registra sola y entra por la invitación. */
const INVITADA = crypto.randomUUID();
/** Intenta usar el enlace de otra persona. */
const INTRUSO = crypto.randomUUID();
/** Cajero al que luego desactivan. */
const CAJERO = crypto.randomUUID();
/** Cajero al que le quitan el único rol. */
const SIN_ROL = crypto.randomUUID();
/** Nunca fue miembro de nada. */
const EXTRANO = crypto.randomUUID();
const correo = (quien: string) => `${quien}-invitaciones-${RUN}@e2e.ladino`;
const NOMBRE_TITULAR = `Rosa Titular ${RUN}`;

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let A = "";
let TENANT_A = "";

const tokenDe = (sub: string) =>
  new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);

const SIN_IDEMPOTENCIA = new Set([
  "/v1/onboarding",
  "/v1/onboarding/another-company",
  "/v1/invitations/preview",
  "/v1/invitations/accept",
]);

async function pedir(
  metodo: string,
  path: string,
  sub: string,
  empresa: string,
  body?: unknown,
  llave?: string,
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await tokenDe(sub)}` };
  if (empresa !== "") headers["X-Company-Id"] = empresa;
  if (metodo !== "GET" && !SIN_IDEMPOTENCIA.has(path)) {
    headers["Idempotency-Key"] = llave ?? crypto.randomUUID();
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await app.request(path, {
    method: metodo,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (process.env["LADINO_E2E_DEBUG"] === "1" && r.status >= 400) {
    // eslint-disable-next-line no-console
    console.log(metodo, path, r.status, await r.clone().text());
  }
  return r;
}

async function invitar(body: Record<string, unknown>): Promise<{ id: string; token: string }> {
  const r = await pedir("POST", "/v1/invitations", TITULAR, A, { company_id: A, ...body });
  expect(r.status).toBe(201);
  return (await r.json()) as { id: string; token: string };
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  for (const [id, quien] of [
    [TITULAR, "titular"],
    [INVITADA, "invitada"],
    [INTRUSO, "intruso"],
    [CAJERO, "cajero"],
    [SIN_ROL, "sinrol"],
    [EXTRANO, "extrano"],
  ] as const) {
    await sql`insert into auth.users (id, email) values (${id}, ${correo(quien)})
              on conflict (id) do nothing`;
  }
  const f = await pedir("POST", "/v1/onboarding", TITULAR, "", {
    business_name: `Abastos Invitaciones ${RUN}`,
    owner_full_name: NOMBRE_TITULAR,
  });
  expect(f.status).toBe(201);
  const fundado = (await f.json()) as { company_id: string; tenant_id: string };
  A = fundado.company_id;
  TENANT_A = fundado.tenant_id;
}, 30_000);

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("A-13/E-15 · crear otra empresa desde dentro", () => {
  let OTRA = "";
  it("el Titular crea otra empresa: un tenant NUEVO, del que nace Titular y Dueño", async () => {
    const r = await pedir("POST", "/v1/onboarding/another-company", TITULAR, "", {
      business_name: `Ferretería Segunda ${RUN}`,
    });
    expect(r.status).toBe(201);
    const nueva = (await r.json()) as { tenant_id: string; company_id: string };
    expect(nueva.tenant_id).not.toBe(TENANT_A);
    OTRA = nueva.company_id;

    const lista = await pedir("GET", "/v1/companies", TITULAR, "");
    const ids = ((await lista.json()) as { id: string }[]).map((c) => c.id);
    expect(ids).toContain(A);
    expect(ids).toContain(OTRA);

    // Titular de la nueva: la asignación `owner` de nivel tenant, como el fundador.
    const [titular] = await sql<{ n: number }[]>`
      select count(*)::int as n
        from public.memberships m
        join public.user_role_assignments u on u.membership_id = m.id and u.company_id is null
        join public.roles r on r.id = u.role_id and r.key = 'owner' and r.tenant_id is null
       where m.tenant_id = ${nueva.tenant_id} and m.user_id = ${TITULAR} and m.status = 'active'`;
    expect(titular!.n).toBe(1);

    // Y opera: sus permisos en la nueva son los del Dueño.
    const p = await pedir("GET", "/v1/me/permissions", TITULAR, OTRA);
    expect(((await p.json()) as { permissions: string[] }).permissions).toContain(
      "membership.manage",
    );
  }, 30_000);

  it("la misma no se funda dos veces: el nombre entre sus negocios es la clave natural", async () => {
    const r = await pedir("POST", "/v1/onboarding/another-company", TITULAR, "", {
      business_name: `  ferretería segunda ${RUN.toUpperCase()} `,
    });
    expect(r.status).toBe(409);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("DUPLICATE");
    expect(cuerpo.message).toContain("Ya tienes un negocio con ese nombre");
  });

  it("el registro de siempre sigue siendo uno por persona (LAD81 intacto)", async () => {
    const r = await pedir("POST", "/v1/onboarding", TITULAR, "", {
      business_name: `Tercero por la puerta vieja ${RUN}`,
    });
    expect(r.status).toBe(409);
  });

  it("quien no es Titular de ninguna cuenta no crea otra empresa: 403 con su frase", async () => {
    const r = await pedir("POST", "/v1/onboarding/another-company", EXTRANO, "", {
      business_name: `Fantasma ${RUN}`,
    });
    expect(r.status).toBe(403);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("PERMISSION_REQUIRED");
    expect(cuerpo.message).toContain("Titular");
  });
});

describe("N-08/K-09 · la invitación por enlace", () => {
  let TOKEN = "";
  it("el Titular invita: el token sale UNA vez y la base guarda solo su huella", async () => {
    const inv = await invitar({ role_key: "cashier" });
    expect(inv.token).toMatch(/^[0-9a-f]{64}$/);
    TOKEN = inv.token;
    const [fila] = await sql<{ token_hash: string; tenant_id: string }[]>`
      select token_hash, tenant_id from public.member_invitations where id = ${inv.id}`;
    expect(fila!.tenant_id).toBe(TENANT_A);
    expect(fila!.token_hash).not.toContain(TOKEN);
    const [audit] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where aggregate_id = ${inv.id} and event_type = 'member.invited'`;
    expect(audit!.n).toBe(1);
  });

  it("quien se registra con la invitación ve «Te invitaron a <empresa>»", async () => {
    const r = await pedir("POST", "/v1/invitations/preview", INVITADA, "", { token: TOKEN });
    expect(r.status).toBe(200);
    const v = (await r.json()) as {
      status: string;
      company_name: string;
      role_key: string;
      inviter_name: string | null;
    };
    expect(v.status).toBe("pending");
    expect(v.company_name).toBe(`Abastos Invitaciones ${RUN}`);
    expect(v.role_key).toBe("cashier");
    expect(v.inviter_name).toBe(NOMBRE_TITULAR);
  });

  it("se acepta UNA vez: entra a la empresa con su rol, y el segundo uso muere", async () => {
    const r = await pedir("POST", "/v1/invitations/accept", INVITADA, "", { token: TOKEN });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { company_id: string }).company_id).toBe(A);
    const lista = await pedir("GET", "/v1/companies", INVITADA, "");
    expect(((await lista.json()) as { id: string }[]).map((c) => c.id)).toEqual([A]);
    const p = await pedir("GET", "/v1/me/permissions", INVITADA, A);
    expect(((await p.json()) as { permissions: string[] }).permissions).toContain(
      "sales.invoice.issue",
    );

    // La misma persona, de nuevo: es su invitación, ya está dentro — 200 sin efecto doble.
    const otraVez = await pedir("POST", "/v1/invitations/accept", INVITADA, "", { token: TOKEN });
    expect(otraVez.status).toBe(200);
    const [asig] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.user_role_assignments u
        join public.memberships m on m.id = u.membership_id
       where m.user_id = ${INVITADA} and u.company_id = ${A}`;
    expect(asig!.n).toBe(1);

    // Otra persona con el mismo enlace: ya se usó.
    const ajena = await pedir("POST", "/v1/invitations/accept", INTRUSO, "", { token: TOKEN });
    expect(ajena.status).toBe(409);
    const cuerpo = (await ajena.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("INVITATION_UNAVAILABLE");
    expect(cuerpo.message).toContain("ya se usó");
    const [audit] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where tenant_id = ${TENANT_A} and event_type = 'member.invitation_accepted'
         and payload->>'user_id' = ${INVITADA}`;
    expect(audit!.n).toBe(1);
  });

  it("caduca: vencida, ni se previsualiza como pendiente ni se acepta", async () => {
    const inv = await invitar({ role_key: "cashier" });
    // Vencerla exige saltarse el guardián de la fila (las fechas son inmutables): réplica local.
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update public.member_invitations
                  set created_at = now() - interval '9 days', expires_at = now() - interval '2 days'
                where id = ${inv.id}`;
    });
    const v = await pedir("POST", "/v1/invitations/preview", INTRUSO, "", { token: inv.token });
    expect(((await v.json()) as { status: string }).status).toBe("expired");
    const r = await pedir("POST", "/v1/invitations/accept", INTRUSO, "", { token: inv.token });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { message: string }).message).toContain("venció");
  });

  it("la ligada a un correo no la acepta otra cuenta", async () => {
    const inv = await invitar({ role_key: "accountant", email: correo("cajero") });
    const r = await pedir("POST", "/v1/invitations/accept", INTRUSO, "", { token: inv.token });
    expect(r.status).toBe(403);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("INVITATION_FOR_OTHER_EMAIL");
    expect(cuerpo.message).toContain("otro correo");
    // E7: y la vista previa no le dice a qué negocio ni de parte de quién: solo el estado.
    const v = await pedir("POST", "/v1/invitations/preview", INTRUSO, "", { token: inv.token });
    expect(v.status).toBe(200);
    expect(await v.json()).toEqual({
      status: "other_email",
      company_name: null,
      business_name: null,
      role_key: null,
      inviter_name: null,
      expires_at: null,
    });
    // Al destinatario sí.
    const suya = await pedir("POST", "/v1/invitations/preview", CAJERO, "", { token: inv.token });
    expect(((await suya.json()) as { status: string; company_name: string }).company_name).toBe(
      `Abastos Invitaciones ${RUN}`,
    );
  });

  it("no sirve en otro tenant: quien no gestiona A no invita a A, ni con su token entra a otra", async () => {
    const r = await pedir("POST", "/v1/invitations", EXTRANO, A, {
      company_id: A,
      role_key: "owner",
    });
    expect(r.status).toBe(404);
    // El cajero de A (sin membership.manage) tampoco invita.
    const sinPermiso = await pedir("POST", "/v1/invitations", INVITADA, A, {
      company_id: A,
      role_key: "owner",
    });
    expect(sinPermiso.status).toBe(403);
    // Lo que la invitada aceptó la llevó SOLO a A: ningún otro tenant la ve.
    const [tenants] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.memberships where user_id = ${INVITADA}`;
    expect(tenants!.n).toBe(1);
    // Un token inventado no revela nada.
    const falso = await pedir("POST", "/v1/invitations/preview", INTRUSO, "", {
      token: "0".repeat(64),
    });
    expect(falso.status).toBe(404);
  });
});

describe("revisión ADR-0077 · el token, el Dueño invitado y la carrera", () => {
  it("H2: el token no queda en idempotency_keys, y el replay responde sin token y lo dice", async () => {
    const llave = crypto.randomUUID();
    const cuerpo = { company_id: A, role_key: "cashier" };
    const r = await pedir("POST", "/v1/invitations", TITULAR, A, cuerpo, llave);
    expect(r.status).toBe(201);
    const inv = (await r.json()) as { id: string; token: string };
    expect(inv.token).toMatch(/^[0-9a-f]{64}$/);
    const [guardadas] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.idempotency_keys
       where response::text like '%' || ${inv.token} || '%'`;
    expect(guardadas!.n).toBe(0);
    const otraVez = await pedir("POST", "/v1/invitations", TITULAR, A, cuerpo, llave);
    expect(otraVez.status).toBe(201);
    const replay = (await otraVez.json()) as { id: string; token: string | null; notice?: string };
    expect(replay.id).toBe(inv.id);
    expect(replay.token).toBeNull();
    expect(replay.notice).toContain("ya se mostró");
  });

  it("H7: una invitación de Dueño exige correo (422)", async () => {
    const r = await pedir("POST", "/v1/invitations", TITULAR, A, {
      company_id: A,
      role_key: "owner",
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain("correo");
  });

  it("H8: dos invitaciones del mismo negocio aceptadas a la vez por la misma persona: sin 500", async () => {
    const NUEVA = crypto.randomUUID();
    await sql`insert into auth.users (id, email) values (${NUEVA}, ${correo("carrera")})`;
    const uno = await invitar({ role_key: "cashier" });
    const dos = await invitar({ role_key: "accountant" });
    const [a, b] = await Promise.all([
      pedir("POST", "/v1/invitations/accept", NUEVA, "", { token: uno.token }),
      pedir("POST", "/v1/invitations/accept", NUEVA, "", { token: dos.token }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const [m] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.memberships where user_id = ${NUEVA}`;
    expect(m!.n).toBe(1);
    // E3: y queda con las DOS asignaciones en A, no con la de quien ganó la carrera.
    const roles = await sql<{ key: string }[]>`
      select r.key from public.user_role_assignments u
        join public.memberships mm on mm.id = u.membership_id
        join public.roles r on r.id = u.role_id
       where mm.user_id = ${NUEVA} and u.company_id = ${A}
       order by r.key`;
    expect(roles.map((x) => x.key)).toEqual(["accountant", "cashier"]);
  });
});

describe("N-03/N-06 · quien pierde el acceso", () => {
  it("el desactivado y el sin rol ven «tu acceso ya no está activo» con quien administra", async () => {
    for (const [quien, rol] of [
      ["cajero", "cashier"],
      ["sinrol", "cashier"],
    ] as const) {
      const r = await pedir("POST", "/v1/members", TITULAR, A, {
        company_id: A,
        email: correo(quien),
        role_key: rol,
      });
      expect(r.status).toBe(201);
    }
    const lista = (await (await pedir("GET", "/v1/members", TITULAR, A)).json()) as {
      members: { membership_id: string; user_id: string; assignments: { id: string }[] }[];
    };
    const cajero = lista.members.find((m) => m.user_id === CAJERO)!;
    const sinRol = lista.members.find((m) => m.user_id === SIN_ROL)!;
    expect(
      (
        await pedir("PUT", `/v1/members/${cajero.membership_id}/status`, TITULAR, A, {
          company_id: A,
          status: "inactive",
        })
      ).status,
    ).toBe(200);
    expect(
      (await pedir("DELETE", `/v1/members/assignments/${sinRol.assignments[0]!.id}`, TITULAR, A))
        .status,
    ).toBe(200);

    for (const quien of [CAJERO, SIN_ROL]) {
      const r = await pedir("GET", "/v1/me/access", quien, "");
      expect(r.status).toBe(200);
      const acceso = (await r.json()) as {
        lost_access: { business_name: string; admin_name: string | null }[];
      };
      expect(acceso.lost_access).toEqual([
        { business_name: `Abastos Invitaciones ${RUN}`, admin_name: NOMBRE_TITULAR },
      ]);
    }
    // Quien nunca fue miembro: nada perdido (y el registro le toca a él).
    const nada = await pedir("GET", "/v1/me/access", EXTRANO, "");
    expect(((await nada.json()) as { lost_access: unknown[] }).lost_access).toEqual([]);
  });

  it("N-06: con la caja abierta, su empresa responde ACCESS_REVOKED con la frase del dueño", async () => {
    const r = await pedir("GET", "/v1/me/permissions", CAJERO, A);
    // 404 como siempre (el catálogo: 404 antes que 403), con su propio code y su frase.
    expect(r.status).toBe(404);
    const cuerpo = (await r.json()) as { code: string; person_message: string };
    expect(cuerpo.code).toBe("ACCESS_REVOKED");
    expect(cuerpo.person_message).toBe(
      "Tu acceso a esta empresa ya no está activo. Habla con quien administra el negocio.",
    );
    // H1: una invitación NO reactiva al desactivado: LAD89 con su frase, y sigue desactivado.
    const inv = await invitar({ role_key: "cashier" });
    const intento = await pedir("POST", "/v1/invitations/accept", CAJERO, "", { token: inv.token });
    expect(intento.status).toBe(409);
    expect(((await intento.json()) as { message: string }).message).toContain(
      "Tu acceso a este negocio está desactivado",
    );
    const [estado] = await sql<{ status: string }[]>`
      select status from public.memberships where tenant_id = ${TENANT_A} and user_id = ${CAJERO}`;
    expect(estado!.status).toBe("inactive");
    // El extraño sigue sin saber que A existe: el 404 de siempre.
    const ajeno = await pedir("GET", "/v1/me/permissions", EXTRANO, A);
    expect(ajeno.status).toBe(404);
    expect(((await ajeno.json()) as { code: string }).code).toBe("NOT_FOUND");
  });
});

describe("E7 · quien no es el destinatario no ve los datos en ningún estado", () => {
  it("una invitación ligada a un correo, ya VENCIDA: al intruso solo other_email; al destinatario, que venció", async () => {
    const inv = await invitar({ role_key: "accountant", email: correo("invitada") });
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update public.member_invitations
                  set created_at = now() - interval '9 days', expires_at = now() - interval '2 days'
                where id = ${inv.id}`;
    });
    const ajena = await pedir("POST", "/v1/invitations/preview", INTRUSO, "", { token: inv.token });
    expect(await ajena.json()).toEqual({
      status: "other_email",
      company_name: null,
      business_name: null,
      role_key: null,
      inviter_name: null,
      expires_at: null,
    });
    const suya = await pedir("POST", "/v1/invitations/preview", INVITADA, "", { token: inv.token });
    const v = (await suya.json()) as { status: string; company_name: string | null };
    expect(v.status).toBe("expired");
    expect(v.company_name).toBe(`Abastos Invitaciones ${RUN}`);
  });
});

describe("E1 · el acta dice de qué empresa era la asignación, no desde cuál se quitó", () => {
  /** Trabaja solo en B. */
  const P = crypto.randomUUID();
  let B = "";

  it("el Titular, con la cabecera de A, le quita a P su rol en B: A sigue sin existir para P", async () => {
    await sql`insert into auth.users (id, email) values (${P}, ${correo("solo-en-b")})`;
    const b = await pedir("POST", "/v1/companies", TITULAR, A, {
      tenant_id: TENANT_A,
      legal_name: `Empresa B invitaciones ${RUN}, C.A.`,
      tax_id: `J-77${RUN.slice(-6)
        .replace(/[^0-9]/g, "7")
        .padStart(6, "7")}-3`,
    });
    expect(b.status).toBe(201);
    B = ((await b.json()) as { id: string }).id;
    const alta = await pedir("POST", "/v1/members", TITULAR, B, {
      company_id: B,
      email: correo("solo-en-b"),
      role_key: "cashier",
    });
    expect(alta.status).toBe(201);
    const asignacion = ((await alta.json()) as { assignments: { id: string }[] }).assignments[0]!;

    // La cabecera es A; la asignación, de B. El Titular gobierna la cuenta entera: puede.
    const quitar = await pedir("DELETE", `/v1/members/assignments/${asignacion.id}`, TITULAR, A);
    expect(quitar.status).toBe(200);

    // P pide A, donde NUNCA trabajó: el mismo 404 que una empresa que no existe.
    const pideA = await pedir("GET", "/v1/me/permissions", P, A);
    const inexistente = await pedir("GET", "/v1/me/permissions", P, crypto.randomUUID());
    expect(pideA.status).toBe(404);
    const sinId = async (r: Response) => {
      const { request_id: _omitido, ...resto } = (await r.json()) as Record<string, unknown>;
      return resto;
    };
    const cuerpoA = await sinId(pideA);
    expect(cuerpoA).toEqual(await sinId(inexistente));
    expect(cuerpoA["code"]).toBe("NOT_FOUND");

    // P pide B, donde SÍ perdió el rol: se le dice.
    const pideB = await pedir("GET", "/v1/me/permissions", P, B);
    expect(pideB.status).toBe(404);
    expect(((await pideB.json()) as { code: string }).code).toBe("ACCESS_REVOKED");

    // El acta: anclada a B, con el alcance de la asignación en el payload.
    const [acta] = await sql<{ company_id: string; alcance: string | null }[]>`
      select a.company_id, a.payload->>'assignment_company_id' as alcance
        from public.audit_events a
        join public.memberships m on m.id = a.aggregate_id
       where m.user_id = ${P} and a.event_type = 'member.role_revoked'`;
    expect(acta).toEqual({ company_id: B, alcance: B });
  }, 30_000);

  it("rama null por el productor real: quitado un rol de NIVEL TENANT, las empresas de entonces dicen ACCESS_REVOKED y la creada después, NOT_FOUND", async () => {
    // Las asignaciones de nivel tenant solo nacen en el registro: se siembra una para G.
    const G = crypto.randomUUID();
    await sql`insert into auth.users (id, email) values (${G}, ${correo("gerente")})`;
    const [m] = await sql<{ id: string }[]>`
      insert into public.memberships (tenant_id, user_id) values (${TENANT_A}, ${G}) returning id`;
    const [asig] = await sql<{ id: string }[]>`
      insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
      select ${TENANT_A}, ${m!.id}, r.id, null from public.roles r
       where r.key = 'accountant' and r.tenant_id is null
      returning id`;
    expect((await pedir("GET", "/v1/me/permissions", G, B)).status).toBe(200);

    const quitar = await pedir("DELETE", `/v1/members/assignments/${asig!.id}`, TITULAR, A);
    expect(quitar.status).toBe(200);
    const [acta] = await sql<{ company_id: string; tiene: boolean; alcance: string | null }[]>`
      select company_id, payload ? 'assignment_company_id' as tiene,
             payload->>'assignment_company_id' as alcance
        from public.audit_events
       where aggregate_id = ${m!.id} and event_type = 'member.role_revoked'`;
    expect(acta).toEqual({ company_id: A, tiene: true, alcance: null });

    // B no es la empresa de la cabecera, y existía: el rol de nivel tenant la alcanzaba.
    const enB = await pedir("GET", "/v1/me/permissions", G, B);
    expect(((await enB.json()) as { code: string }).code).toBe("ACCESS_REVOKED");

    // Una empresa creada DESPUÉS: nunca tuvo acceso a ella. El 404 de una que no existe.
    const c = await pedir("POST", "/v1/companies", TITULAR, A, {
      tenant_id: TENANT_A,
      legal_name: `Empresa C posterior ${RUN}, C.A.`,
      tax_id: `J-88${RUN.slice(-6)
        .replace(/[^0-9]/g, "8")
        .padStart(6, "8")}-4`,
    });
    expect(c.status).toBe(201);
    const C = ((await c.json()) as { id: string }).id;
    const sinId = async (r: Response) => {
      const { request_id: _omitido, ...resto } = (await r.json()) as Record<string, unknown>;
      return resto;
    };
    const enC = await sinId(await pedir("GET", "/v1/me/permissions", G, C));
    expect(enC).toEqual(
      await sinId(await pedir("GET", "/v1/me/permissions", G, crypto.randomUUID())),
    );
    expect(enC["code"]).toBe("NOT_FOUND");
  }, 30_000);

  it("el sin-rol de la misma empresa: ACCESS_REVOKED en la suya", async () => {
    const r = await pedir("GET", "/v1/me/permissions", SIN_ROL, A);
    expect(r.status).toBe(404);
    expect(((await r.json()) as { code: string }).code).toBe("ACCESS_REVOKED");
    // Y en B, donde nunca trabajó, el 404 de siempre.
    const enB = await pedir("GET", "/v1/me/permissions", SIN_ROL, B);
    expect(((await enB.json()) as { code: string }).code).toBe("NOT_FOUND");
  });
});
