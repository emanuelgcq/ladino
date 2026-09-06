import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql } from "@ladino/db";
import {
  CreateCompanyRequest,
  OnboardBusinessRequest,
  SetCompanyFiscalAddressRequest,
  UpdateCompanyProfileRequest,
  SetCompanyTaxIdRequest,
  CorrectCompanyTaxIdRequest,
  SetMyProfileRequest,
} from "@ladino/schemas";
import {
  createCompany,
  onboardBusiness,
  setCompanyFiscalAddress,
  updateCompanyProfile,
  setCompanyTaxId,
  correctCompanyTaxId,
  setCompanyLogo,
  getMyProfile,
  setMyProfile,
} from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { CTX } from "../middleware/context.js";
import { subirObjeto, firmarUrls } from "../storage.js";
import type { StorageConfig } from "../config.js";

const BUCKET_LOGOS = "company-logos";

/**
 * PLANTILLA DE HANDLER. Esto es TODO lo que un handler hace (API_SPEC.md §La
 * capa es delgada): validar la forma con Zod, abrir la transacción por el
 * helper, delegar al caso de uso, y devolver el éxito. Los errores NO se
 * mapean aquí: se LANZAN, y el errorMapper —el middleware de cierre— los
 * convierte al contrato. Un handler que mapea sus propios errores es un
 * handler que diverge del contrato en el tercer módulo.
 *
 * Las rutas se registran SOBRE la app principal, no como sub-app montada con
 * `app.route()`. No es estilo: una sub-app de Hono gestiona sus errores con su
 * PROPIO onError, así que una excepción lanzada aquí dentro moriría en el 500
 * por defecto de la sub-app SIN pasar por el errorMapper del padre — todos los
 * caminos de error devolvían «Internal Server Error» con el mapeo intacto y
 * sin usar. Lo encontró el test E2E; quien copie esta plantilla, que copie
 * también esta forma.
 *
 * Lo que NO hay aquí, y quien copie no debe añadir: reglas de negocio
 * (packages/domain), transacciones a mano (withTransaction es el único
 * camino), GUC (lo fija el helper), idempotencia (T1/T2 del middleware,
 * montado en app.ts).
 */
export function companiesRoutes(
  app: Hono,
  sql: Sql,
  idempotencia: MiddlewareHandler,
  storage?: StorageConfig,
): void {
  // Lectura: las companies VISIBLES para el actor — la misma función de la
  // migración 15 que usa el middleware de scope, así que lo que este endpoint
  // lista y lo que X-Company-Id acepta no pueden divergir. Sin idempotencia
  // (es GET) y sin reglas de negocio: un select con la visibilidad como
  // predicado y la RLS de ladino_api como segunda capa.
  app.get("/v1/companies", async (c) => {
    const { actor, userId } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<({ logo_path: string | null } & Record<string, unknown>)[]>`
        select id, tenant_id, legal_name, trade_name, tax_id, fiscal_address,
               business_type, phone, whatsapp, city, state, logo_path, status,
               to_char(created_at at time zone 'utc',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
          from public.companies
         where id in (select platform.ladino_user_company_ids(${userId}))
         order by legal_name, id`,
    );
    // El logo viaja como URL FIRMADA de vigencia corta (patrón product-images);
    // la ruta del bucket nunca sale del servidor. Firmado en LOTE y fuera de
    // la transacción.
    const rutas = filas.map((f) => f.logo_path).filter((p): p is string => p !== null);
    const firmadas =
      storage === undefined || rutas.length === 0
        ? new Map<string, string>()
        : await firmarUrls(storage, BUCKET_LOGOS, rutas);
    return c.json(
      filas.map(({ logo_path, ...f }) => ({
        ...f,
        logo_url: logo_path === null ? null : (firmadas.get(logo_path) ?? null),
      })),
      200,
    );
  });

  /**
   * El domicilio fiscal del emisor (PA 00071 art. 13.5, migración 34). Los
   * documentos ya emitidos NO cambian: cada uno congeló el domicilio vigente
   * el día que nació. /empezar lo pide antes de elegir cómo facturar.
   */
  app.put("/v1/companies/fiscal-address", idempotencia, async (c) => {
    const ctx = c.get(CTX);
    if (ctx.companyId === null) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "Esta operación exige el header X-Company-Id.",
      });
    }
    const companyId = ctx.companyId;
    const parsed = SetCompanyFiscalAddressRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) =>
      setCompanyFiscalAddress(uow, companyId, parsed.data.fiscal_address),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  // La idempotencia se monta POR RUTA Y MÉTODO, no por path con app.use (H-6):
  // montada por path, un `DELETE /v1/companies` sin handler atravesaba T1,
  // reservaba la clave, recibía el 404 de Hono y T2 la marcaba failed —
  // escritura en la tabla por un método que no existe.
  app.post("/v1/companies", idempotencia, async (c) => {
    // Validar la FORMA. Los invariantes de negocio (tenant activo, RIF
    // duplicado) son del caso de uso: Zod no puede saberlos.
    const parsed = CreateCompanyRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidacionError(parsed.error.issues);
    }

    const { actor } = c.get("ladino.auth");
    const resultado = await withTransaction(sql, actor, (uow) => createCompany(uow, parsed.data));

    if (!resultado.ok) throw new DominioError(resultado.error);
    return c.json(resultado.value, 201);
  });

  /**
   * Las sucursales de la empresa (Fase C): visibles para cualquier miembro —
   * el middleware de scope ya validó membresía y visibilidad de la company, y
   * una sucursal es estructura, no dato sensible.
   */
  /**
   * ADR-0049: fundar el negocio. SIN X-Company-Id y SIN el middleware de
   * idempotencia — los dos exigen un tenant que esta ruta está CREANDO (la
   * clave del middleware necesita un tenant EXISTENTE y visible, defensa H-2).
   * La idempotencia aquí es estructural y desde la migración 43 A PRUEBA DE
   * CARRERAS: bootstrap_tenant serializa por usuario con un candado
   * consultivo e impone un-negocio-por-usuario (LAD81) — el doble clic
   * simultáneo espera, muere en DUPLICATE, y la web resuelve recargando la
   * sesión. Nunca se funda dos veces.
   */
  app.post("/v1/onboarding", async (c) => {
    const parsed = OnboardBusinessRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => onboardBusiness(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  /**
   * ADR-0048: los permisos del usuario en la empresa activa, DE UNA VEZ. La
   * webapp forma el menú y esconde botones con esta lista; cada operación
   * sigue autorizándose por su cuenta en el servidor — esconder es cortesía,
   * no control. La resolución es la MISMA de ladino_user_has_permission
   * (platform.ladino_user_permissions, migración 40): dos formas de preguntar
   * el mismo mecanismo, imposible que diverjan.
   */
  app.get("/v1/me/permissions", async (c) => {
    const ctx = c.get(CTX);
    if (ctx.companyId === null) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "Esta operación exige el header X-Company-Id.",
      });
    }
    const companyId = ctx.companyId;
    const { actor, userId } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<{ permiso: string }[]>`
        select platform.ladino_user_permissions(${userId}, ${companyId}) as permiso`,
    );
    return c.json({ permissions: filas.map((f) => f.permiso) }, 200);
  });

  /** «Mi empresa»: el perfil editable. El RIF tiene su puerta aparte (abajo). */
  app.patch("/v1/companies/profile", idempotencia, async (c) => {
    const ctx = c.get(CTX);
    if (ctx.companyId === null) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "Esta operación exige el header X-Company-Id.",
      });
    }
    const companyId = ctx.companyId;
    const parsed = UpdateCompanyProfileRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) =>
      updateCompanyProfile(uow, companyId, parsed.data),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  /**
   * El RIF, política de tres niveles (PARTE 4 del registro): este PUT cubre
   * los niveles 1 (sin documentos, o el PRIMER RIF que reemplaza a PEND-*);
   * con documentos responde 422 y el camino es la corrección de abajo.
   */
  app.put("/v1/companies/tax-id", idempotencia, async (c) => {
    const ctx = c.get(CTX);
    if (ctx.companyId === null) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "Esta operación exige el header X-Company-Id.",
      });
    }
    const companyId = ctx.companyId;
    const parsed = SetCompanyTaxIdRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) =>
      setCompanyTaxId(uow, companyId, parsed.data),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  /** Nivel 3: la corrección EXCEPCIONAL del dedazo — motivo obligatorio, acta. */
  app.post("/v1/companies/tax-id/correct", idempotencia, async (c) => {
    const ctx = c.get(CTX);
    if (ctx.companyId === null) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "Esta operación exige el header X-Company-Id.",
      });
    }
    const companyId = ctx.companyId;
    const parsed = CorrectCompanyTaxIdRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) =>
      correctCompanyTaxId(uow, companyId, parsed.data),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  /**
   * El logo del negocio — patrón product-images CALCADO: sharp en el handler,
   * bucket privado por tenant, la ruta en la tabla y URL firmada al servir.
   * Genera además `logo-pdf.png` porque pdfkit NO lee webp: 512px, aplanado a
   * blanco (la transparencia en el papel es blanco de todos modos). Sin
   * `Idempotency-Key` a propósito: resubir el mismo logo es idempotente por
   * naturaleza. El logo es PRESENTACIÓN: jamás toca el snapshot del emisor.
   */
  app.post("/v1/companies/logo", async (c) => {
    const ctx = c.get(CTX);
    if (ctx.companyId === null) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "Esta operación exige el header X-Company-Id.",
      });
    }
    const companyId = ctx.companyId;
    if (storage === undefined) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "Este servidor no tiene almacenamiento de imágenes configurado.",
      });
    }
    const cuerpo = await c.req.parseBody();
    const archivo = cuerpo["file"];
    if (!(archivo instanceof File)) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "Manda el logo en el campo `file` (multipart/form-data).",
      });
    }
    if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(archivo.type)) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "El logo tiene que ser JPG, PNG o WebP.",
      });
    }

    const original = Buffer.from(await archivo.arrayBuffer());
    const { default: sharp } = await import("sharp");
    let l256: Buffer, l64: Buffer, lPdf: Buffer;
    try {
      const base = sharp(original).rotate();
      l256 = await base
        .clone()
        .resize({ width: 256, height: 256, fit: "cover" })
        .webp({ quality: 80 })
        .toBuffer();
      l64 = await base
        .clone()
        .resize({ width: 64, height: 64, fit: "cover" })
        .webp({ quality: 74 })
        .toBuffer();
      lPdf = await base
        .clone()
        .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .png()
        .toBuffer();
    } catch {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "Esa imagen no se pudo leer. Prueba con otra.",
      });
    }

    const version = Date.now().toString(36);
    const rutaBase = `${companyId}/logo/${version}`;
    const ruta256 = `${rutaBase}/logo-256.webp`;
    await subirObjeto(storage, BUCKET_LOGOS, ruta256, l256, "image/webp");
    await subirObjeto(storage, BUCKET_LOGOS, `${rutaBase}/logo-64.webp`, l64, "image/webp");
    await subirObjeto(storage, BUCKET_LOGOS, `${rutaBase}/logo-pdf.png`, lPdf, "image/png");

    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => setCompanyLogo(uow, companyId, ruta256));
    if (!r.ok) throw new DominioError(r.error);

    const firmadas = await firmarUrls(storage, BUCKET_LOGOS, [ruta256]);
    return c.json({ logo_path: ruta256, logo_url: firmadas.get(ruta256) ?? null }, 201);
  });

  /** La ficha personal («Ahora tú»): cada quien lee y escribe la suya. */
  app.get("/v1/me/profile", async (c) => {
    const { actor, userId } = c.get("ladino.auth");
    const perfil = await withTransaction(sql, actor, ({ sql: tx }) => getMyProfile(tx, userId));
    return c.json(perfil, 200);
  });

  app.put("/v1/me/profile", idempotencia, async (c) => {
    const parsed = SetMyProfileRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => setMyProfile(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  app.get("/v1/branches", async (c) => {
    const ctx = c.get(CTX);
    if (ctx.companyId === null) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "Esta operación exige el header X-Company-Id.",
      });
    }
    const companyId = ctx.companyId;
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select id, code, name, status from public.branches
         where company_id = ${companyId}
         order by name`,
    );
    return c.json({ items: filas }, 200);
  });
}
