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
