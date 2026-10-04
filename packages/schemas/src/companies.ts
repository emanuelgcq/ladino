import { z } from "zod";

/**
 * Contratos de `POST /v1/companies` — la fuente única de la que sale el
 * OpenAPI (ADR-0004, ADR-0015). Lo que no está aquí no existe en el contrato.
 *
 * SOBRE `tax_id` (el RIF): el CONTRATO sigue sin regex — no vacío y cota de
 * longitud. Desde el 2026-09-28 (OPEN_QUESTIONS #9 cerrada por el dueño, A-08) la
 * estructura del RIF SÍ se valida, pero en el SERVIDOR, en el caso de uso
 * (packages/domain documento-identidad.ts), con la función compartida
 * `leerRif` de ./rif.ts: 422 con un mensaje legible, y el dígito verificador
 * que no cuadra se acepta y se registra. No va en Zod a propósito: el contrato
 * no cambia, y la decisión la toma el servidor, no el cliente que comparte este
 * esquema (CLAUDE.md §7).
 */
/** Los campos de PERFIL del negocio (registro premium, migración 43). */
const perfilCampos = {
  business_type: z.string().trim().min(2).max(40),
  phone: z.string().trim().min(3).max(40),
  whatsapp: z.string().trim().min(3).max(40),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
} as const;

export const CreateCompanyRequest = z
  .object({
    tenant_id: z.string().uuid(),
    legal_name: z.string().trim().min(1).max(200),
    trade_name: z.string().trim().min(1).max(200).optional(),
    tax_id: z.string().trim().min(1).max(30),
    fiscal_address: z.string().trim().min(5).max(500).optional(),
    business_type: perfilCampos.business_type.optional(),
    phone: perfilCampos.phone.optional(),
    whatsapp: perfilCampos.whatsapp.optional(),
    city: perfilCampos.city.optional(),
    state: perfilCampos.state.optional(),
  })
  .strict();

export type CreateCompanyRequest = z.infer<typeof CreateCompanyRequest>;

export const CompanyResponse = z
  .object({
    id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    legal_name: z.string(),
    trade_name: z.string().nullable(),
    tax_id: z.string(),
    /** Domicilio fiscal del emisor (PA 00071 art. 13.5). NULL hasta que lo cargue. */
    fiscal_address: z.string().nullable(),
    business_type: z.string().nullable(),
    phone: z.string().nullable(),
    whatsapp: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    /** URL FIRMADA del logo (vigencia corta) o null. La ruta vive en el servidor. */
    logo_url: z.string().nullable(),
    /**
     * Tipo de contribuyente de la EMPRESA (ordinario, especial, formal…). NULL hasta que el
     * dueño lo declara: sin él no se sabe si el IVA de una compra es crédito fiscal, y las
     * compras se rechazan (QA de pantalla 2026-09-15, h. 62).
     */
    taxpayer_type_code: z.string().nullable(),
    status: z.enum(["onboarding", "active", "suspended"]),
    created_at: z.string().datetime({ offset: true }),
    /**
     * ADR-0069 §3: inicio de actividades (YYYY-MM-DD), límite inferior de las fechas contables.
     * Opcional en el contrato: es un campo nuevo, y un cliente o un test anterior no lo trae.
     */
    activity_start_date: z.string().nullable().optional(),
  })
  .strict();

/**
 * Editar el PERFIL del negocio («Mi empresa»). El RIF NO se toca por aquí:
 * tiene su endpoint y su permiso (política de tres niveles). `reason` es
 * obligatorio EN DOMINIO cuando cambian razón social o domicilio con
 * documentos fiscales ya emitidos — queda en el acta.
 */
export const UpdateCompanyProfileRequest = z
  .object({
    legal_name: z.string().trim().min(1).max(200).optional(),
    trade_name: z.string().trim().min(1).max(200).nullable().optional(),
    fiscal_address: z.string().trim().min(5).max(500).optional(),
    business_type: perfilCampos.business_type.nullable().optional(),
    phone: perfilCampos.phone.nullable().optional(),
    whatsapp: perfilCampos.whatsapp.nullable().optional(),
    city: perfilCampos.city.nullable().optional(),
    state: perfilCampos.state.nullable().optional(),
    reason: z.string().trim().min(3).max(300).optional(),
    /**
     * ADR-0069 §3 (K-05): inicio de actividades. Ni futura ni posterior al primer asiento de la
     * empresa; el cambio queda en el acta `company.profile_updated`.
     */
    activity_start_date: z.string().date().optional(),
  })
  .strict();
export type UpdateCompanyProfileRequest = z.infer<typeof UpdateCompanyProfileRequest>;

/**
 * El RIF del negocio (política de tres niveles, PARTE 4 del registro):
 * poner el PRIMERO (reemplazar el placeholder PEND-*) o cambiarlo SIN
 * documentos emitidos — confirmación simple. Con documentos, 422: eso es
 * la corrección excepcional de abajo.
 */
export const SetCompanyTaxIdRequest = z
  .object({
    tax_id: z.string().trim().min(1).max(30),
    /**
     * A-05 (ADR-0050: «RIF real exige razón social y domicilio fiscal»): la razón social, como
     * aparece en el RIF. OBLIGATORIA al poner el PRIMER RIF —una empresa que nació sin RIF guarda
     * el nombre del negocio como razón social, y la factura la congela—; con RIF ya puesto no se
     * acepta aquí: se cambia en el perfil, con su acta.
     */
    legal_name: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type SetCompanyTaxIdRequest = z.infer<typeof SetCompanyTaxIdRequest>;

/** La corrección EXCEPCIONAL del RIF (dedazo tardío): motivo obligatorio, acta. */
export const CorrectCompanyTaxIdRequest = z
  .object({
    tax_id: z.string().trim().min(1).max(30),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();
export type CorrectCompanyTaxIdRequest = z.infer<typeof CorrectCompanyTaxIdRequest>;

/** La ficha de la persona que administra (users_profile, migración 43). */
export const MyProfileResponse = z
  .object({
    full_name: z.string().nullable(),
    national_id: z.string().nullable(),
  })
  .strict();
export type MyProfileResponse = z.infer<typeof MyProfileResponse>;

export const SetMyProfileRequest = z
  .object({
    full_name: z.string().trim().min(2).max(200),
    national_id: z.string().trim().min(3).max(30).nullable().optional(),
  })
  .strict();
export type SetMyProfileRequest = z.infer<typeof SetMyProfileRequest>;

/** Cargar o corregir el domicilio fiscal del emisor (migración 34). */
export const SetCompanyFiscalAddressRequest = z
  .object({ fiscal_address: z.string().trim().min(5).max(500) })
  .strict();
export type SetCompanyFiscalAddressRequest = z.infer<typeof SetCompanyFiscalAddressRequest>;

export type CompanyResponse = z.infer<typeof CompanyResponse>;

/**
 * GET /v1/companies — las companies VISIBLES para el actor
 * (`platform.ladino_user_company_ids()`, migración 15). Un array plano: sin
 * paginación mientras el caso real sean decenas de empresas por usuario; el
 * día que haga falta, se envuelve en `{items, next}` como cambio de contrato.
 */
export const ListCompaniesResponse = z.array(CompanyResponse);

/**
 * ADR-0048: los permisos del usuario en la empresa activa, para formar el menú.
 *
 * `roles` (A-04): las claves de los roles de SISTEMA con los que la persona actúa en esa empresa
 * (`owner`, `accountant`, `cashier`…). No autoriza nada —eso lo hacen los permisos—: existe porque
 * «Contabilidad y Libros aparecen cuando hay datos o cuando el rol es contador», y el dueño tiene
 * todos los permisos del contador, así que un permiso no los distingue.
 */
export const MePermissionsResponse = z
  .object({ permissions: z.array(z.string()), roles: z.array(z.string()) })
  .strict();
export type MePermissionsResponse = z.infer<typeof MePermissionsResponse>;

/**
 * ADR-0049: fundar el negocio en un acto — tenant, empresa, depósito, roles
 * del fundador y plan contable con plantillas. El RIF es opcional: sin él, la
 * empresa nace con placeholder PEND- y el modo recibos la deja vender ya.
 */
export const OnboardBusinessRequest = z
  .object({
    business_name: z.string().trim().min(2).max(200),
    tax_id: z.string().trim().min(1).max(30).nullable().optional(),
    /** Con RIF, la razón social y el domicilio fiscal son OBLIGATORIOS (regla
     *  dura de la migración 43, impuesta en dominio con 422). */
    legal_name: z.string().trim().min(1).max(200).optional(),
    fiscal_address: z.string().trim().min(5).max(500).optional(),
    business_type: perfilCampos.business_type.optional(),
    phone: perfilCampos.phone.optional(),
    whatsapp: perfilCampos.whatsapp.optional(),
    city: perfilCampos.city.optional(),
    state: perfilCampos.state.optional(),
    /** «Ahora tú»: la ficha del responsable (users_profile). */
    owner_full_name: z.string().trim().min(2).max(200).optional(),
    owner_national_id: z.string().trim().min(3).max(30).nullable().optional(),
    /**
     * ADR-0069 §3 (K-05): inicio de actividades, límite inferior de las fechas contables.
     * Opcional: por omisión, el día del alta en Caracas. No puede ser futura.
     */
    activity_start_date: z.string().date().optional(),
    /**
     * ADR-0072 §1 (A-03): con RIF, el registro pregunta el tipo de contribuyente. Opcional en el
     * contrato: sin él la empresa nace sin tipo y NO factura hasta declararlo (nunca «ordinario
     * por omisión»). El especial exige la fecha de notificación de la providencia.
     */
    taxpayer: z
      .object({
        taxpayer_type_code: z.enum(["ordinario", "especial"]),
        notified_on: z.string().date().optional(),
        effective_from: z.string().date().optional(),
      })
      .strict()
      .refine((v) => v.taxpayer_type_code !== "especial" || v.notified_on !== undefined, {
        message: "el contribuyente especial exige la fecha de notificación de la providencia",
        path: ["notified_on"],
      })
      // Alta ordinaria con notified_on: 422 legible, no un 23514 de la base.
      .refine((v) => v.taxpayer_type_code === "especial" || v.notified_on === undefined, {
        message: "la fecha de notificación es solo de la calificación como contribuyente especial",
        path: ["notified_on"],
      })
      .optional(),
  })
  .strict();
export type OnboardBusinessRequest = z.infer<typeof OnboardBusinessRequest>;

export const OnboardBusinessResponse = z
  .object({
    tenant_id: z.string().uuid(),
    company_id: z.string().uuid(),
    warehouse_id: z.string().uuid(),
  })
  .strict();
export type OnboardBusinessResponse = z.infer<typeof OnboardBusinessResponse>;

/** ADR-0049: miembros del negocio y sus roles. */
export const MemberAssignment = z
  .object({
    id: z.string().uuid(),
    role_key: z.string(),
    role_name: z.string(),
    /** null = asignación a nivel de todo el negocio (el fundador). */
    company_id: z.string().uuid().nullable(),
  })
  .strict();
export type MemberAssignment = z.infer<typeof MemberAssignment>;

export const MemberResponse = z
  .object({
    membership_id: z.string().uuid(),
    user_id: z.string().uuid(),
    email: z.string().nullable(),
    status: z.string(),
    assignments: z.array(MemberAssignment),
  })
  .strict();
export type MemberResponse = z.infer<typeof MemberResponse>;

export const ListMembersResponse = z.object({ members: z.array(MemberResponse) }).strict();
export type ListMembersResponse = z.infer<typeof ListMembersResponse>;

export const AddMemberRequest = z
  .object({
    company_id: z.string().uuid(),
    email: z.string().trim().email(),
    role_key: z.enum([
      "owner",
      "cashier",
      "store_manager",
      "back_office",
      "accountant",
      "warehouse_ops",
    ]),
  })
  .strict();
export type AddMemberRequest = z.infer<typeof AddMemberRequest>;

export const SetMemberStatusRequest = z
  .object({
    company_id: z.string().uuid(),
    status: z.enum(["active", "inactive"]),
  })
  .strict();
export type SetMemberStatusRequest = z.infer<typeof SetMemberStatusRequest>;
export type ListCompaniesResponse = z.infer<typeof ListCompaniesResponse>;

/**
 * LA INVITACIÓN POR ENLACE (ADR-0077 §3). El token sale UNA vez, en la respuesta que lo crea; la
 * base guarda solo su huella. El correo es opcional: si se da, solo esa cuenta acepta.
 */
const RolAsignable = z.enum([
  "owner",
  "cashier",
  "store_manager",
  "back_office",
  "accountant",
  "warehouse_ops",
]);
export const CreateInvitationRequest = z
  .object({
    company_id: z.string().uuid(),
    role_key: RolAsignable,
    email: z.string().trim().email().max(320).optional(),
  })
  .strict();
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequest>;

export const InvitationResponse = z
  .object({
    id: z.string().uuid(),
    company_id: z.string().uuid(),
    role_key: RolAsignable,
    email: z.string().nullable(),
    /**
     * 64 caracteres hex, en la respuesta que la crea. El replay de la misma Idempotency-Key la
     * devuelve con `null` y un `notice`: el token no se guarda en ninguna parte (H2).
     */
    token: z.string().nullable(),
    expires_at: z.string(),
    notice: z.string().optional(),
  })
  .strict();
export type InvitationResponse = z.infer<typeof InvitationResponse>;

export const InvitationTokenRequest = z
  .object({ token: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
export type InvitationTokenRequest = z.infer<typeof InvitationTokenRequest>;

export const InvitationPreviewResponse = z
  .object({
    status: z.enum(["pending", "used", "revoked", "expired", "other_email"]),
    // E7: con `other_email` (quien pregunta no es el destinatario) todo lo demás viaja en null.
    company_name: z.string().nullable(),
    business_name: z.string().nullable(),
    role_key: RolAsignable.nullable(),
    inviter_name: z.string().nullable(),
    expires_at: z.string().nullable(),
  })
  .strict();
export type InvitationPreviewResponse = z.infer<typeof InvitationPreviewResponse>;

export const AcceptInvitationResponse = z.object({ company_id: z.string().uuid() }).strict();
export type AcceptInvitationResponse = z.infer<typeof AcceptInvitationResponse>;

/** N-03: los negocios donde la persona tuvo acceso y hoy no, con quien los administra. */
export const MeAccessResponse = z
  .object({
    lost_access: z.array(
      z.object({ business_name: z.string(), admin_name: z.string().nullable() }).strict(),
    ),
  })
  .strict();
export type MeAccessResponse = z.infer<typeof MeAccessResponse>;

/** Cuerpo de error del contrato (`API_SPEC.md` §Errores). */
export const ErrorResponse = z.object({
  code: z.string(),
  message: z.string(),
  /**
   * La misma verdad en VOZ DE PERSONA (Fase C): dos frases como máximo, qué
   * pasó y qué hacer. Las pantallas de negocio enseñan esta; /admin puede
   * enseñar las dos.
   */
  person_message: z.string().optional(),
  details: z.unknown().optional(),
  request_id: z.string().nullable().optional(),
});

export type ErrorResponse = z.infer<typeof ErrorResponse>;
