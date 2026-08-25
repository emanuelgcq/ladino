import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

// Necesario para que los z.object de parámetros (headers) generen metadatos.
extendZodWithOpenApi(z);
import { CreateCompanyRequest, CompanyResponse, ErrorResponse } from "@ladino/schemas";

/**
 * El documento OpenAPI se GENERA desde los Zod de @ladino/schemas (ADR-0004,
 * ADR-0015): los esquemas son la fuente única, y `openapi.json` en la raíz es
 * su proyección commiteada. `pnpm openapi:check` falla si divergen — es un
 * diff contra el fichero commiteado, no una validación semántica.
 *
 * Los importes monetarios, cuando lleguen, se documentan como objeto
 * `{amount, currency}` con `amount` string `format: decimal` — nunca number
 * (regla 7, API_SPEC.md §Dinero). Aquí todavía no hay ninguno.
 */
export function buildOpenApiDocument(): object {
  const registry = new OpenAPIRegistry();

  const createCompany = registry.register("CreateCompanyRequest", CreateCompanyRequest);
  const company = registry.register("CompanyResponse", CompanyResponse);
  const error = registry.register("ErrorResponse", ErrorResponse);

  const errorRef = (description: string) => ({
    description,
    content: { "application/json": { schema: error } },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/companies",
    summary: "Listar las empresas visibles para el usuario",
    description:
      "Devuelve las companies que `platform.ladino_user_company_ids()` resuelve para el " +
      "actor — el MISMO predicado que valida `X-Company-Id`, así que esta lista y ese " +
      "header no pueden divergir. Array plano, sin paginación por ahora.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Las companies visibles (puede ser un array vacío).",
        content: { "application/json": { schema: z.array(company) } },
      },
      401: errorRef("Token ausente, inválido o expirado."),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/companies",
    summary: "Crear una empresa",
    description:
      "Operación de nivel tenant. Exige `company.manage` en una asignación " +
      "tenant-wide, `Idempotency-Key`, y un usuario real (no el actor de sistema). " +
      "El RIF no se valida en formato: VALIDAR-SENIAT pendiente.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: z.object({
        "Idempotency-Key": z.string().max(255),
      }),
      body: { content: { "application/json": { schema: createCompany } } },
    },
    responses: {
      201: {
        description: "Empresa creada. Un replay con la misma clave devuelve esta misma respuesta.",
        content: { "application/json": { schema: company } },
      },
      400: errorRef("Falta Idempotency-Key en una operación crítica."),
      401: errorRef("Token ausente, inválido o expirado (TOKEN_EXPIRED se distingue)."),
      403: errorRef("Tenant visible pero sin company.manage (PERMISSION_REQUIRED)."),
      404: errorRef(
        "Tenant inexistente O no visible para el usuario — indistinguibles a propósito.",
      ),
      409: errorRef("RIF duplicado, tenant suspendido, clave reutilizada o en vuelo."),
      422: errorRef("Forma inválida (VALIDATION_FAILED) o clave fuera de cota."),
    },
  });

  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.3",
    info: {
      title: "Ladino API",
      version: "0.1.0",
      description:
        "API administrativa, contable y fiscal. Errores: docs/04_PLATFORM/ERROR_CATALOG.md.",
    },
    servers: [{ url: "/" }],
  });
}
