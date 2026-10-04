# ADR-0077 — La empresa vive en la pestaña; segunda empresa e invitación por enlace

- **Estado:** ADR aplicado según la respuesta del dueño del 2026-09-28 (§2.11). Hallazgos: O-01, A-13, E-15, K-09, N-03, N-06 y N-08.
- **Fecha:** 2026-10-02.
- **Impacto fiscal:** NO (sí de aislamiento: rigor máximo).
- **Enmienda:** ADR-0068 §3 (roles por empresa y Titular de la cuenta), en el alta de la segunda empresa.

## Contexto
El recorrido encontró:
- una empresa activa global que otra pestaña cambia en silencio, de modo que se vende o se registra en la empresa equivocada (O-01);
- que no hay forma de crear una segunda empresa (A-13, E-15);
- invitaciones sin camino de llegada (N-08, K-09, N-03);
- quien pierde el acceso aterriza en «monta tu negocio» (N-06).

## Decisión
1. **Por pestaña:**
   - la empresa activa vive en `sessionStorage` (o en la URL), nunca en un global que otra pestaña cambia;
   - al recargar, la pestaña conserva su empresa;
   - el servidor ya exige `X-Company-Id` por petición: la pestaña lo manda desde su propio estado.
2. **Segunda empresa:**
   - desde el selector, «Crear otra empresa», dentro de la misma cuenta de la persona;
   - cada empresa es su propio tenant, y la persona nace Dueño de la nueva;
   - el Titular de la cuenta (ADR-0068) gobierna lo que es de la cuenta;
   - el texto de «Cambiar el RIF» se corrige: con documentos emitidos, el camino es la corrección con motivo, más el aviso del COT (A-10).
3. **Invitación:**
   - por enlace con token (y correo si hay proveedor configurado);
   - quien se registra con una invitación aterriza en «Te invitaron a <empresa>»;
   - quien pierde el rol o se desactiva aterriza en «Tu acceso a esta empresa ya no está activo», con el nombre de quien administra;
   - nunca en «monta tu negocio»;
   - el cajero desactivado con la caja abierta ve «Tu acceso a esta empresa ya no está activo. Habla con quien administra el negocio».

## Consecuencias
- **Positivas:**
  - ninguna operación cae en otra empresa por una pestaña ajena;
  - la persona con dos negocios los lleva desde una cuenta;
  - las invitaciones llegan.
- **Negativas:**
  - tablas o columnas nuevas para el token de invitación (expira, un solo uso, auditado);
  - el alta de la segunda empresa es un caso de uso nuevo.
- **Para revertir:** el estado por pestaña es del cliente. Las invitaciones son filas nuevas.

## Verificación
- E2E: dos pestañas con empresas distintas no se pisan; crear una segunda empresa da un tenant nuevo con Dueño; la invitación por token se consume una vez y aterriza bien; el usuario desactivado ve el mensaje.
- pgTAP de aislamiento del token.
- `pnpm recorrido O`, `A`, `E`, `K` y `N`.

## Nota de aplicación (ola 3, 2026-10-02)

**Piezas.**
- **Por pestaña (O-01).** `apps/web/src/app/empresa-pestana.ts`: la empresa de la pestaña va en
  `sessionStorage` (sobrevive al F5); el disco guarda solo la última elegida, que sirve de punto de
  partida a una pestaña NUEVA y nunca cambia la de una pestaña que ya tiene la suya. `session.tsx`
  manda `X-Company-Id` desde el estado de la pestaña, como antes. Unitario
  `apps/web/test/empresa-pestana.test.ts` (dos pestañas no se pisan).
- **Segunda empresa (A-13, E-15).** `POST /v1/onboarding/another-company` reutiliza
  `onboardBusiness` con `otraEmpresa`, sobre `platform.bootstrap_another_tenant` (migración
  20261003120000): tenant NUEVO, la persona nace Titular y Dueño. En la web, «Crear otra empresa»
  en el selector abre el mismo asistente del registro. `bootstrap_tenant` no cambia (LAD81 sigue
  protegiendo el doble clic del registro). El texto de «Cambiar el RIF» y el 422 con documentos
  dicen ahora el camino de la corrección con motivo y el aviso del art. 13.5 de la PA 00071; el
  aviso del COT art. 35 lo lleva el DIÁLOGO, no el 422 (textos del dueño, RESPUESTA §3 A-10).
- **Invitación (N-08, K-09).** `member_invitations` (huella sha256 del token, empresa, rol, correo
  opcional, vence a los 7 días, un solo uso, ancla, procedencia, sin DELETE, RLS) y
  `POST /v1/invitations`, `/v1/invitations/preview`, `/v1/invitations/accept`. Quien abre
  `?invitacion=<token>` (**sustituido en la revisión, H5:** el enlace lleva `#invitacion=<token>`,
  en el fragmento; la query solo se lee durante la transición) (también tras registrarse y confirmar el correo en otra pestaña: el token se
  guarda en el disco hasta aceptarlo o descartarlo) ve «Te invitaron a <empresa>». El registro sin
  invitación añade «¿Vienes a trabajar en el negocio de otra persona? … pídele el enlace».
- **Acceso perdido (N-03, N-06).** `GET /v1/me/access` y `platform.my_lost_access()`: sin empresas
  visibles y con membresía en algún negocio, la web dice «Tu acceso a esta empresa ya no está
  activo» con «<negocio>: habla con <Titular>, que administra el negocio», nunca «monta tu negocio».
  En plena sesión, el middleware de alcance responde `ACCESS_REVOKED` a quien tuvo acceso (migración
  20261003120100 lo acota: no a un miembro de otra empresa del tenant) y la pestaña entera enseña
  «Tu acceso a esta empresa ya no está activo. Habla con quien administra el negocio.».

**Decidido por criterio (§2.16).**
1. «Crear otra empresa» es del **Titular de alguna cuenta** (asignación `owner` de nivel tenant).
   Un Dueño invitado o un cajero no abren negocios desde dentro (403 legible). *Alternativa:* que
   cualquier persona con sesión pudiera abrir uno (es lo que permite el registro a quien no tiene
   ninguno). Regla 3: el empleado no funda negocios por error desde el selector de su patrón.
2. La **clave natural** de la segunda empresa es el nombre del negocio (sin mayúsculas ni espacios
   de más) o el RIF entre los negocios de la persona (LAD94 → 409); no lleva `Idempotency-Key`,
   como `/v1/onboarding` (no hay empresa a la que atarla). *Alternativa:* idempotencia por llave
   ligada al usuario.
3. La invitación **vence a los 7 días** (la tabla admite hasta 30) y puede ligarse a un correo.
   *Alternativa:* 48 horas, o siempre ligada a correo (hoy no hay proveedor de correo).
4. **Cambiada en la revisión (H1, migración 20261003120200):** una invitación **NUNCA reactiva**
   una membresía desactivada: LAD89, «Tu acceso a este negocio está desactivado: pídele a quien lo
   administra que te reactive desde Usuarios». Reactivar devuelve TODAS las asignaciones de la
   membresía (un Dueño desactivado invitado como cajero recuperaba su owner), y eso lo decide quien
   administra, desde Usuarios. Quien invitó sin `membership.manage` pasa a LAD90. *Alternativa:*
   reactivar solo lo que nombra la invitación (apagar las demás asignaciones). Regla 3: lo más
   estrecho y reversible. La versión anterior (reactivar si invitaba quien gobierna la cuenta)
   queda sustituida.
5. **`ACCESS_REVOKED` viaja con 404**, no 403: la regla del catálogo («404 antes que 403») y la
   aserción `apps/api/test/e2e-onboarding.test.ts:200` quedan intactas; lo que distingue el caso es
   el `code` y la frase. *Alternativa:* 403.
6. «Cambiar el RIF» **no consulta** si hay documentos: el texto dice las dos ramas («Si todavía no has
   emitido documentos…; si ya emitiste, el camino es «Corregir RIF»») y el 422 del servidor, que sí
   lo sabe, da el camino entero. *Alternativa:* añadir `has_issued_documents` a `CompanyResponse`
   (un cambio de contrato).
7. «Crear otra empresa» se enseña en el selector a quien tiene `company.manage` en la empresa activa;
   el servidor decide si es Titular. *Alternativa:* un campo nuevo en la sesión.

**Abierto.** Listar y anular invitaciones pendientes desde la web; el envío por correo cuando haya
proveedor; el color por empresa (O-05) no es de esta ola. Riesgo R-69.

## Nota de la revisión (2026-10-02, migración 20261003120200)

- **H2 · el token.** Lo genera la API (`crypto.randomBytes(32)`, `apps/api/src/routes/members.ts`) y a
  Postgres solo llega su huella sha256. La respuesta que guarda `idempotency_keys` va SIN token
  (`REDACTORES` en `apps/api/src/middleware/idempotency.ts`): el replay de la misma llave devuelve
  la invitación con `token: null` y «El enlace ya se mostró y no se guarda. Si lo perdiste, crea
  otro». **Corrige** lo que decían la cabecera de 20261003120000, R-69 y esta nota («el token solo
  existe en la respuesta que lo crea»): hasta esta revisión, el token se generaba en la base y la
  respuesta completa quedaba en `idempotency_keys`. *Decidido por criterio* (opción a). *Alternativa:*
  no montar la idempotencia en esta ruta.
- **H3 · O-01 seguía reproduciendo.** `recargar` fija ahora en el sessionStorage la empresa con la
  que arranca la pestaña (`resolverEmpresaDePestana`). Sin eso, una pestaña nueva que arrancaba en la
  última elegida no guardaba nada propio y tras el F5 volvía a leer el disco.
- **H4 · el acceso perdido exige historia.** «Sin rol» ya no basta: hace falta el acta
  `member.role_revoked` de esa membresía en esa empresa (vale también para quien perdió una empresa y
  conserva otra), o una membresía desactivada con un rol que la alcanzaba.
- **H5.** El enlace lleva el token en el fragmento (`#invitacion=`), que no llega a los logs del
  servidor web; se sigue leyendo `?invitacion=` durante la transición. El token pendiente se borra
  del disco al recibir `SIGNED_OUT` (todos los «Salir»).
- **H6.** `bootstrap_another_tenant` exige que `p_user` sea el actor (42501). Un 409 de «otra
  empresa» en el asistente recarga la lista y lleva a la existente. *Decidido por criterio:* la
  ruta va **sin Idempotency-Key** (desviación de la regla 4 de CLAUDE.md, igual que
  `/v1/onboarding`): no hay empresa a la que atar la llave, y la clave natural (nombre o RIF entre
  los negocios de la persona, con el candado por persona) es la que impide el doble efecto.
  *Alternativa:* una idempotencia por usuario sin tenant.
- **H7.** Una invitación de **Dueño exige correo** (422 en el dominio y CHECK
  `member_invitations_owner_email_chk`, NOT VALID; las abiertas sin correo se anularon). *Decidido
  por criterio.* *Alternativa:* un endpoint para anular invitaciones (sigue pendiente, R-69).
- **H8.** Dos invitaciones del mismo negocio aceptadas a la vez por la misma persona: candado por
  (tenant, persona), `on conflict (tenant_id, user_id) do nothing` y relectura `for update`.

## Nota de la segunda revisión (2026-10-03, migración 20261003120300)

- **E1 · el acta dice de qué empresa era la asignación (aislamiento).** `removeAssignment` anclaba
  el acta `member.role_revoked` a la empresa de la CABECERA de quien quitaba el rol, y
  `lost_access_to_company` creía a ese `company_id`. El Titular, con la cabecera de A, quitaba a P
  su rol en B; P pedía A —donde nunca trabajó— y recibía `ACCESS_REVOKED` (se le revelaba que A
  existe), y en B recibía el 404 genérico. Ahora el acta lleva `assignment_company_id` en el
  payload (la empresa de la asignación, o `null` si era de nivel tenant) y se ancla a esa empresa
  cuando la hay. **La regla, una sola, para `lost_access_to_company` y `my_lost_access`:** una
  membresía desactivada con un rol que alcanzaba la empresa, o un acta de esa membresía cuyo
  `assignment_company_id` es esa empresa o `null`. El `company_id` del acta no se lee. Las actas
  anteriores no llevan la clave (la versión desplegada ya escribía `member.role_revoked` sin ella, así que pueden existir en producción) y **no cuentan**: esa persona recibe el NOT_FOUND genérico (falla cerrado); va en
  el enunciado de la función, sin lista de excepciones. *Decidido por criterio* (corrige un defecto;
  la decisión de la primera revisión no cambia). *Alternativa:* dar por buena la empresa del acta
  vieja, que es justo la fuga.
- **E4.** En `accept_member_invitation`, la relectura de la membresía exige que exista y esté
  activa (`is distinct from 'active'`): un NULL ya no pasa.
- **E5.** En el asistente de «otra empresa», el 409 nunca acaba en silencio: si la web encuentra el
  negocio existente dice «Ya tienes un negocio con ese nombre: te llevamos a él» y entra; si no
  (el servidor compara `tenants.name`, la web ve `trade_name`), enseña el mensaje del 409 y el
  asistente sigue abierto.
- **E6.** El botón de la pantalla de invitación dice **«Descartar»** (borra la invitación del
  disco, y lo dice). *Decidido por criterio.* *Alternativa:* «Ahora no», conservándola para después.
- **E7.** `invitation_preview`: quien NO es el destinatario de una invitación ligada a un correo
  recibe **solo** el estado `other_email`, sin empresa, negocio, rol ni quién invita, **en cualquier
  estado** de la invitación (pendiente, usada, anulada o vencida): `other_email` se evalúa primero
  (migración 20261003120400, que completa la 120300). La pantalla dice «Esta invitación es para
  otro correo. Entra con ese correo o pide otra». El destinatario, y cualquier invitación sin
  correo, sigue viendo el estado real y los datos. *Decidido por criterio* (lo más estrecho).
  *Alternativa:* dejarlo.

## Nota de la tercera revisión (2026-10-03, migración 20261003120500)

- **Cota temporal del acceso perdido.** Un rol de nivel tenant alcanzaba las empresas que EXISTÍAN
  cuando se quitó, no las creadas después. `lost_access_to_company` exige ahora, en las dos ramas
  de nivel tenant, que la empresa ya existiera: `companies.created_at <= audit_events.occurred_at`
  (instante contra instante) del acta `member.role_revoked` (rama b) o de la última
  `member.deactivated` (rama a). Una membresía desactivada con rol de nivel tenant y **sin** acta
  de desactivación no cuenta: `memberships` no guarda cuándo cambió de estado. Un rol de la propia
  empresa no necesita cota. `my_lost_access` hereda la regla porque llama a la función.
  *Decidido por criterio* (lo más estrecho: «solo a quien lo tuvo»). *Alternativa:* aceptar que un
  rol de nivel tenant quitado diga «acceso perdido» en cualquier empresa del negocio, también las
  posteriores, y escribirlo en el enunciado.
- **Corrección.** Las actas `member.role_revoked` sin `assignment_company_id` no son solo de local
  y pruebas (lo decían esta nota y la cabecera de 20261003120300, que no se puede editar; la
  corrección va en la cabecera de la 120500). La regla es la misma: no cuentan, y esa persona
  recibe el NOT_FOUND genérico.
- **Registro.** El aviso del 409 de «otra empresa» dice por qué coincidió: «con ese nombre» o «con
  ese RIF».
