import type { Context } from "hono";

/**
 * Mapeo SQLSTATE → respuesta HTTP. La tabla completa, con la razón de cada
 * fila, está en `docs/04_PLATFORM/ERROR_CATALOG.md`.
 *
 * LA REGLA QUE GOBIERNA LOS DOS CASOS AMBIGUOS:
 *
 *   404 cuando la fila NO ES VISIBLE para el usuario.
 *   403 cuando ES visible pero falta el permiso.
 *   En duda, 404.
 *
 * Porque responder 403 sobre un recurso que el usuario no puede ver CONFIRMA
 * QUE EXISTE. Un atacante que prueba identificadores distingue «no existe» de
 * «existe y no es tuyo», y con eso enumera los recursos de otro tenant sin leer
 * un solo dato. Es fuga de información aunque no lo sea de datos.
 *
 * El coste está aceptado: un usuario legítimo al que le falte un permiso verá a
 * veces un «no existe» confuso. Se paga, porque el error en la otra dirección
 * no se puede deshacer — una vez confirmada la existencia, ya está confirmada.
 */
const POR_SQLSTATE: Record<string, { code: string; status: number }> = {
  // --- SQLSTATE propios de Ladino (funciones de `platform`)
  LAD06: { code: "APPEND_ONLY_VIOLATION", status: 409 },
  LAD25: { code: "RBAC_INCOHERENT", status: 409 },
  LAD26: { code: "RBAC_INCOHERENT", status: 409 },
  LAD27: { code: "RBAC_INCOHERENT", status: 409 },
  LAD28: { code: "ISOLATION_ANCHOR_IMMUTABLE", status: 409 },
  // El recurso ES visible (el usuario ve su company); lo que falta es el
  // permiso concreto. Aquí 403 no revela nada que no supiera ya.
  LAD29: { code: "PERMISSION_REQUIRED", status: 403 },
  LAD30: { code: "OCCURRED_AT_IN_FUTURE", status: 422 },
  LAD31: { code: "IDEMPOTENCY_ACTOR_IMMUTABLE", status: 409 },
  // Migraciones 16-17: el tipo de producto congelado tras draft (D-8) y el
  // append-only de precios (ADR-0032). Ambos son «lo que pides es imposible
  // por diseño», no un dato malformado: 409, como LAD06.
  LAD33: { code: "PRODUCT_KIND_IMMUTABLE", status: 409 },
  LAD35: { code: "PRICE_APPEND_ONLY", status: 409 },
  // M4 para clientes (migración 18): el cliente ES visible; falta el permiso
  // segregado del RIF. 403, como LAD29.
  LAD36: { code: "PERMISSION_REQUIRED", status: 403 },
  // Inventario (migración 19, ADR-0034). LAD38 es «lo que pides no se puede
  // hacer con este producto/almacén» — dato del cliente semánticamente inválido,
  // 422. LAD39 (negativo) y LAD40 (transferencia descuadrada) son estados
  // imposibles por diseño: 409, como LAD06. LAD41 es el oráculo del costeo: el
  // cálculo del cliente y el de la base discrepan, casi siempre porque la
  // posición cambió — 409 y reintentar.
  LAD38: { code: "VALIDATION_FAILED", status: 422 },
  LAD39: { code: "NEGATIVE_STOCK", status: 409 },
  LAD40: { code: "TRANSFER_UNBALANCED", status: 409 },
  LAD41: { code: "COSTING_MISMATCH", status: 409 },
  // Migración 20 (ADR-0035/0036). LAD43 y LAD44 son «lo que pides es imposible
  // por diseño» (un compuesto no tiene stock; una receta anidada no existe): 409.
  // LAD45 y LAD47 son datos mal formados del cliente: 422.
  // LAD46 es visible-pero-sin-permiso, como LAD29 y LAD36: 403.
  LAD43: { code: "COMPOSED_HAS_NO_STOCK", status: 409 },
  LAD44: { code: "RECIPE_INVALID", status: 409 },
  LAD45: { code: "UNIT_CONVERSION_MISSING", status: 422 },
  LAD46: { code: "PERMISSION_REQUIRED", status: 403 },
  LAD47: { code: "VARIANT_ATTRIBUTES_INVALID", status: 422 },
  // Migración 21 (ADR-0037/0038). Los levanta el ESQUEMA —el trigger de emisión
  // y `platform.resolve_tax`—, así que llegan aquí aunque el caso de uso no los
  // haya traducido. Es la red que hace que «sin regla no se emite» valga también
  // para el camino que nadie previó.
  LAD49: { code: "FISCAL_NUMBERING_INVALID", status: 409 },
  LAD50: { code: "TAX_RULE_MISSING", status: 409 },
  LAD51: { code: "EXCHANGE_RATE_MISSING", status: 409 },

  // --- estándar
  "23505": { code: "DUPLICATE", status: 409 },
  // Un CHECK que llega hasta la base significa que el esquema Zod NO lo
  // cubría. Es un 422 correcto Y una señal de que falta validación en el borde.
  "23514": { code: "VALIDATION_FAILED", status: 422 },
  // FK compuesta (tenant_id, company_id): el recurso es de OTRO tenant.
  // 404 por la regla de arriba: un 403 confirmaría que existe.
  "23503": { code: "NOT_FOUND", status: 404 },
  "23502": { code: "VALIDATION_FAILED", status: 422 },
  // Texto malformado para el tipo (un uuid que no lo es). Red de seguridad:
  // la validación de forma debe cazarlo ANTES en Zod o en el middleware; si
  // llega aquí es un 422 correcto y una señal de que faltó una comprobación.
  "22P02": { code: "VALIDATION_FAILED", status: 422 },
  "54000": { code: "PAYLOAD_TOO_LARGE", status: 413 },
  // EXCLUDE de vigencias de precio (ADR-0032). El caso de uso ya lo traduce
  // con mensaje propio; esta fila es la red para cualquier otro camino.
  "23P01": { code: "PRICE_OVERLAP", status: 409 },
};

/**
 * Errores de DOMINIO: el handler los LANZA y este middleware los mapea. Es lo
 * que mantiene el mapeo en un solo sitio — un handler que traduce sus propios
 * errores diverge del contrato en el tercer módulo.
 *
 * La tabla código→HTTP es la de ERROR_CATALOG.md. Un código de dominio que no
 * esté aquí cae a 500 A PROPÓSITO: es más ruidoso que inventarle un estado, y
 * el modo de fallo ruidoso es el que se elige (skill, regla general).
 */
const POR_CODIGO_DOMINIO: Record<string, number> = {
  NOT_FOUND: 404, // regla 404/403 — un solo código para «no existe» y «no es tuyo»
  PERMISSION_REQUIRED: 403, // visible pero sin permiso
  TENANT_SUSPENDED: 409,
  COMPANY_SUSPENDED: 409,
  DUPLICATE: 409,
  VALIDATION_FAILED: 422,
  PRICE_OVERLAP: 409, // ADR-0032: la vigencia pisa un período cerrado
  NEGATIVE_STOCK: 409, // ADR-0034: existencia negativa sin política o sin permiso
  TRANSFER_UNBALANCED: 409,
  COSTING_MISMATCH: 409,
  COMPOSED_HAS_NO_STOCK: 409,
  RECIPE_INVALID: 409,
  UNIT_CONVERSION_MISSING: 422,
  VARIANT_ATTRIBUTES_INVALID: 422,
  // Ventas (migración 21, ADR-0037/0038). Los tres son «lo que pides no se
  // puede hacer AHORA con lo que hay cargado», no un dato malformado: 409 y el
  // cliente arregla el estado (carga la regla, la tasa, el rango) y reintenta.
  // Un 422 diría que el cuerpo está mal, y no lo está.
  FISCAL_NUMBERING_INVALID: 409, // LAD49
  TAX_RULE_MISSING: 409, // LAD50
  EXCHANGE_RATE_MISSING: 409, // LAD51
  APPEND_ONLY_VIOLATION: 409, // LAD06 por la vía del caso de uso
};

export class DominioError extends Error {
  constructor(readonly domainError: { code: string; message: string; details?: unknown }) {
    super(domainError.message);
  }
}

export class ValidacionError extends Error {
  constructor(readonly issues: unknown) {
    super("Los datos enviados no son válidos.");
  }
}

interface ErrorPg {
  readonly code?: string;
  readonly message?: string;
}

function esErrorPg(e: unknown): e is ErrorPg {
  return typeof e === "object" && e !== null && "code" in e;
}

/**
 * `42501` (privilegio denegado) es el caso que NO se puede resolver con una
 * tabla, porque es indistinguible entre «no tienes permiso» y «la RLS no te
 * deja ver esa fila». Por la regla: **404**.
 *
 * Se separa de la tabla a propósito, para que quien lo cambie tenga que leer
 * este comentario.
 */
const PRIVILEGIO_DENEGADO = { code: "NOT_FOUND", status: 404 } as const;

export function mapearError(e: unknown): { code: string; status: number; message: string } {
  if (esErrorPg(e) && typeof e.code === "string") {
    if (e.code === "42501") {
      return { ...PRIVILEGIO_DENEGADO, message: "Recurso no encontrado." };
    }
    const m = POR_SQLSTATE[e.code];
    if (m) {
      // El `message` de la excepción de Postgres va en español y con `hint`
      // accionable, pero es detalle interno: exponerlo revelaría nombres de
      // tabla y de constraint. El mensaje al cliente lo pone la API.
      return { ...m, message: mensajePara(m.code) };
    }
  }
  return { code: "INTERNAL", status: 500, message: "Error interno." };
}

function mensajePara(code: string): string {
  switch (code) {
    case "APPEND_ONLY_VIOLATION":
      return "Este registro no se puede modificar. Corrige con un documento de reversión.";
    case "PERMISSION_REQUIRED":
      return "No tienes permiso para esta operación.";
    case "NOT_FOUND":
      return "Recurso no encontrado.";
    case "DUPLICATE":
      return "Ya existe un registro con esos datos.";
    case "VALIDATION_FAILED":
      return "Los datos enviados no son válidos.";
    case "OCCURRED_AT_IN_FUTURE":
      return "La fecha del hecho está por delante del reloj del servidor.";
    case "PAYLOAD_TOO_LARGE":
      return "El contenido enviado es demasiado grande.";
    case "PRODUCT_KIND_IMMUTABLE":
      return "El tipo (bien/servicio) no se cambia después de activar el producto. Crea otro.";
    case "PRICE_APPEND_ONLY":
      return "Un precio no se edita ni se borra: corrige con una vigencia nueva.";
    case "PRICE_OVERLAP":
      return "La vigencia se solapa con un período ya cerrado.";
    case "NEGATIVE_STOCK":
      return "La operación dejaría la existencia en negativo y no está permitido.";
    case "TRANSFER_UNBALANCED":
      return "Una transferencia necesita su salida y su entrada cuadradas.";
    case "COSTING_MISMATCH":
      return "El costeo no coincide con el de la base: la existencia cambió. Reintenta.";
    case "COMPOSED_HAS_NO_STOCK":
      return "Un producto compuesto no tiene existencias propias: se consumen sus ingredientes.";
    case "RECIPE_INVALID":
      return "La receta no es válida: revisa que el producto sea compuesto y sus ingredientes no.";
    case "UNIT_CONVERSION_MISSING":
      return "Falta la conversión entre esas unidades. Cárgala: el sistema no la adivina.";
    case "VARIANT_ATTRIBUTES_INVALID":
      return "Los atributos de la variante no coinciden con los que declara su plantilla.";
    default:
      return "Error interno.";
  }
}

/**
 * El mapeo de errores va en `app.onError`, NO en un middleware con try/catch.
 *
 * No es preferencia: **en Hono, `next()` no propaga excepciones**. El framework
 * las captura en su compose y las entrega a `onError`; un middleware con
 * `try { await next() } catch` NUNCA ve el error, y la primera versión de este
 * fichero era exactamente eso — todos los caminos de error devolvían el 500
 * por defecto de Hono con el mapeo intacto y sin usar. Lo destapó el test E2E,
 * que ejercita el camino completo en vez de llamar al mapeo directamente.
 *
 * Consecuencia útil del diseño de Hono: cuando `onError` produce la respuesta,
 * los middlewares de fuera CONTINÚAN tras su `await next()` con `c.res` ya
 * puesto — así el T2 de idempotencia ve el status de error y marca la clave
 * `failed` (reintentable) también cuando el caso de uso lanzó.
 */
export function onErrorResponder(e: Error, c: Context): Response {
  const requestId = c.get("ladino.ctx")?.requestId ?? null;

  if (e instanceof ValidacionError) {
    return c.json(
      { code: "VALIDATION_FAILED", message: e.message, details: e.issues, request_id: requestId },
      422,
    );
  }
  if (e instanceof DominioError) {
    const status = POR_CODIGO_DOMINIO[e.domainError.code] ?? 500;
    return c.json(
      {
        code: e.domainError.code,
        message: e.domainError.message,
        ...(e.domainError.details !== undefined ? { details: e.domainError.details } : {}),
        request_id: requestId,
      },
      status as 400,
    );
  }

  const { code, status, message } = mapearError(e);
  return c.json({ code, message, request_id: requestId }, status as 400);
}
