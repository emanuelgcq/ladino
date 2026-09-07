# ADR-0050 — La política del RIF en tres niveles, y el perfil del negocio

- **Estado:** aceptada (2026-09-06)
- **Contexto:** registro premium (orden del dueño, 2026-09-05/06) · migración 43
- **Módulos:** companies · registro · Mi empresa · fiscal-setup

## Contexto

El RIF es el identificador **permanente** del contribuyente (PA SNAT/2026/00080,
ratificado por la 00084: ya ni siquiera caduca). Cambiar el número de RIF no es
editar un dato: es hablar de **otro contribuyente**. Los datos asociados —razón
social, domicilio fiscal— sí cambian legítimamente, y el SENIAT obliga a
notificar esos cambios.

Hasta esta decisión, Ladino tenía el guard de esquema de la migración 20 (el
UPDATE de `tax_id` exige el permiso segregado `company.tax_id.manage` y el
trigger deja acta con el valor anterior), pero **ninguna política de producto**:
no existía endpoint para cambiar el RIF de una empresa, y `/v1/fiscal/regime`
asumía sin comprobar que no había documentos anteriores.

## Decisión

**Tres niveles, decididos por la existencia de documentos fiscales emitidos:**

1. **Sin documentos emitidos** — el RIF se pone o se cambia con confirmación
   simple (`PUT /v1/companies/tax-id`); razón social y dirección se editan
   libres. Poner el **primer** RIF (reemplazar el placeholder `PEND-*`) es este
   mismo nivel: es la transición del modo recibos a facturación, el caso feliz.
2. **Con documentos emitidos** — el RIF queda **bloqueado en la API** (422 con
   la voz de persona: «eso es una entidad nueva: crea otra empresa y mantén
   esta con su historia»), no solo escondido en la UI. Razón social y dirección
   siguen siendo editables, pero exigen **motivo obligatorio** que queda en
   acta (`company.profile_updated` con `reason`); los documentos ya emitidos no
   cambian — cada uno congeló su snapshot (migración 34).
3. **La corrección excepcional** (`POST /v1/companies/tax-id/correct`) — el
   dedazo descubierto tarde. Funciona **aunque haya documentos** (corregir un
   error de tipeo no es cambiar de contribuyente), exige motivo, deja su acta
   propia (`company.tax_id_corrected`) además de la del trigger, y la UI
   aconseja consultar al contador sobre la reemisión de lo ya facturado.

**Qué cuenta como «documento emitido»:** `platform.company_has_fiscal_documents`
(migración 43): facturas/notas de crédito/débito `issued|paid|annulled` ∪
facturas de proveedor `posted|paid` ∪ comprobantes de retención emitidos.
**Los recibos quedan excluidos a propósito**: no llevan RIF, y un recibo jamás
debe bloquear la transición `PEND-* → RIF real`. El mismo helper cierra el
hueco de `/v1/fiscal/regime`: con documentos, cambiar el régimen exige motivo
y deja acta.

**La regla dura del emisor** — «RIF real exige razón social y domicilio
fiscal» — se impone **en dominio** (onboarding, tax-id, perfil), no con un
CHECK de esquema. La alternativa se evaluó y se descartó con registro: un CHECK
rompería decenas de fixtures legítimos de pgTAP y e2e que crean companies con
RIF y sin domicilio desde S0, y el único camino de escritura real es la API. Si
algún día el esquema debe respaldarla, será una migración propia con la
limpieza de fixtures como parte del trabajo (la migración 43 lo documenta en su
cabecera).

**El perfil del negocio** (`trade_name`, `business_type`, `phone`, `whatsapp`,
`city`, `state`, `logo_path`) es dato de presentación: se edita libre con
`company.settings.manage` y acta simple `{from, to}` por campo. El **logo**
sigue el patrón product-images (bucket privado por tenant, ruta en la tabla,
URL firmada al servir, variante `logo-pdf.png` porque pdfkit no lee webp) y
**jamás entra al snapshot del emisor**: la ley congela nombre, RIF y domicilio;
el logo vive.

## Consecuencias

- El doble clic en «Crear mi negocio» no puede fundar dos tenants: la
  migración 43 añade un candado consultivo por usuario a `bootstrap_tenant`
  (el middleware de idempotencia no puede cubrir la ruta: su clave exige un
  tenant existente y visible — defensa H-2).
- `VALIDAR-SENIAT` vigente: la política cita PA 00080/00084 como fundamento del
  carácter permanente del RIF; si una norma posterior regula el procedimiento
  de corrección, el nivel 3 se revisa contra ella.
- Tests que la fijan: pgTAP 043 (las dos caras del helper, RLS del bucket) y
  `apps/api/test/e2e-company-profile.test.ts` (los tres niveles con actas, el
  régimen con motivo, el logo en el PDF).
