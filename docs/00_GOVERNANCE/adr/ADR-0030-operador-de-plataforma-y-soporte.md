# ADR-0030 — Operador de plataforma con alcance acotado, y soporte viable

- **Estado:** Propuesto · **Fecha:** 2026-08-18 · **Impacto fiscal:** SÍ
  (toca quién puede acceder a datos fiscales y bajo qué constancia)
- **Extiende:** ADR-0025 (RBAC y aislamiento) · **Se apoya en:** ADR-0014, ADR-0017, ADR-0029
- **Implementación:** Fase 10. **Este ADR es solo la decisión.**

## Contexto

ADR-0025 modela `tenants → companies → memberships` y **no contempla a quien opera el SaaS**. Hoy
el operador no existe en el modelo: no es miembro de ningún tenant, así que
`platform.ladino_tenant_ids()` le devuelve vacío y no ve absolutamente nada. Como punto de partida
está bien —deniega por defecto— pero deja dos problemas sin resolver: hay tareas de plataforma que
alguien tiene que hacer, y **el soporte tiene que ser viable** o el hueco se rellenará con lo peor
posible.

**El riesgo concreto:** un «superadmin» con acceso total desharía las seis migraciones de
aislamiento de S0.3 de un plumazo. Y no por malicia: por ser el camino corto cuando un cliente
llama con un problema en producción un viernes.

**El alcance es acotado por diseño, no por disciplina.** Es la doctrina de `CLAUDE.md` §2 aplicada a
las personas: si el operador no debe poder leer los datos de un cliente, tiene que **fallar
activamente**, no depender de que nadie lo intente.

## Decisión

### 1. Lo que el operador puede hacer sin restricción

- Gestionar el catálogo de `fiscal_regimes` (ADR-0029).
- Asignar regímenes a empresas.
- Administrar el ciclo de vida de tenants: alta, suspensión, baja.

Son operaciones **sobre la estructura**, no sobre los datos de negocio. Un operador que da de alta
un tenant no ve ni una factura.

### 2. Lo que no tiene, nunca, por defecto

**Acceso permanente a datos de negocio de ningún cliente.** Ni lectura. El caso «solo miro» es
precisamente el que se normaliza y deja de registrarse.

### 3. Pero el soporte tiene que ser viable — tres vías, en este orden

**a) Diagnóstico sin datos.** Resuelve la mayoría de los casos y debe agotarse primero:

- logs estructurados (ADR-0017: `request_id`, `tenant_id`, `company_id`, `user_id`, `use_case`,
  `duration`, `result` — **nunca el payload fiscal completo**);
- `audit_events` de la empresa **con IDs pero sin importes**;
- estados del `outbox`: qué está `pending`, qué murió en `dead` y con qué `last_error`;
- errores y su `request_id`.

Con esto se responde «¿por qué falló mi factura de ayer?» sin ver una sola cifra.

**b) Reproducción en staging** con datos sintéticos y **el mismo régimen fiscal** que el cliente
(ADR-0029). Casi todo lo que a) no resuelve es un problema de configuración de régimen, y
reproducirlo es más rápido que mirar datos reales.

**c) Impersonación con consentimiento** — solo para lo que a) y b) no resuelven:

- **El cliente la activa** desde su panel, o el operador la solicita y **el cliente aprueba**.
  Nunca se autoconcede.
- **Ventana temporal que expira sola.** Nadie tiene que acordarse de revocar: el mecanismo que
  depende de que alguien se acuerde es el que falla.
- **Lectura por defecto. Escribir exige una segunda aprobación explícita**, distinta de la primera.
- **Cada acción deja `audit_event`** con la identidad del operador, marcada como **acceso de
  soporte**, y **VISIBLE PARA EL CLIENTE en su propio panel**.

### 4. La línea que separa soporte de puerta trasera

Es la última viñeta, y merece decirse aparte porque es la decisión entera del ADR:

**No es que el operador pueda leer. Es que el cliente lo autorizó, por un tiempo acotado, y quedó
constancia que él mismo puede consultar.**

Un acceso de soporte que el cliente no puede ver *a posteriori* es indistinguible de una puerta
trasera, aunque tenga consentimiento previo y registro interno. La visibilidad para el cliente no
es cortesía: es lo que hace que el consentimiento signifique algo.

### 5. Qué sigue prohibido incluso con impersonación activa

- **Emitir un documento fiscal en nombre del cliente.** Un documento fiscal declara lo que hizo el
  contribuyente; que lo emita el proveedor del software, aunque sea con permiso, es falsificación
  de la identidad del emisor con buena intención.
- **Aprobar lo que la segregación de funciones exige que apruebe otro** (pagos, cuentas bancarias
  de proveedor, cierres). Si el operador puede cerrar el círculo, la SoD deja de existir.
- **Cambiar el RIF** (`company.tax_id.manage`, M4). Identifica al contribuyente ante el SENIAT.
- **Conceder permisos o alterar el RBAC del cliente**, incluida su propia impersonación.

El escalón de escritura (§3c) se justifica solo para lo que un usuario del cliente podría hacer y
está bloqueado por un defecto: desbloquear un documento atascado, reprocesar una fila `dead` del
outbox, corregir un dato de maestro. **No para nada de la lista de arriba.**

## Qué toca de lo ya construido — y por qué eso es una ventaja

Este ADR no inventa un mecanismo nuevo de aislamiento: **se apoya en el que ya está probado**.

- **La impersonación puede modelarse como un `membership` acotado en el tiempo.** Y eso hace que
  herede gratis la propiedad que S0.3 ya demostró con once aserciones: **la revocación es inmediata
  en la sesión abierta, sin reemitir token** (ADR-0014, pgTAP 007). La ventana que expira no
  necesita mecanismo propio — es el `membership` dejando de estar activo, y ya está probado que eso
  corta el acceso en la consulta siguiente.
- **Requiere `expires_at` en `memberships`** y que las funciones `platform.ladino_*` lo filtren
  además de `status`. Ojo: esas funciones las usan **más de cuarenta policies** y hoy tienen gate de
  coste (pgTAP 013). Cualquier cambio pasa por ese gate.
- **Requiere un tercer valor en `audit_events.actor_type`**, hoy `CHECK (actor_type in ('user',
  'system'))`. El acceso de soporte no es ninguno de los dos, y colapsarlo en `user` borraría
  precisamente la distinción que este ADR existe para registrar.
- **Requiere que el cliente pueda leer esos eventos**, lo que encaja con el permiso
  `fiscal.audit.read` que ya existe.

## Consecuencias

**Buenas.**

- El aislamiento de S0.3 se mantiene intacto: no hay rol que lo esquive.
- El soporte es posible sin acceso permanente, y las dos primeras vías cubren la mayoría de casos
  sin tocar datos.
- La ventana que expira sola elimina la clase de fallo «se concedió acceso temporal y sigue activo
  dos años después», que es de las más comunes del sector.

**Malas, y asumidas. Son tres costes concretos, no advertencias.**

**C1 · `memberships` necesita `expires_at`, y las funciones `ladino_*` deben filtrarlo.**
Es un cambio sobre la ruta caliente: esas cuatro funciones las invocan **más de cuarenta policies**,
una vez por fila. Un predicado más por invocación no es gratis, y en S0.4 ya se vivió lo que cuesta
equivocarse ahí — una regresión de 28× que ningún test de corrección detectó.

**Obligatorio: medir con el gate de coste (pgTAP 013) ANTES y DESPUÉS del cambio**, y dejar las dos
cifras escritas en la migración. No «comprobar que el gate pasa»: comparar. Un gate con 11× de
margen absorbe una degradación de 2× sin ponerse rojo, y esa degradación es real aunque el gate no
la vea.

**C2 · `audit_events.actor_type` necesita un tercer valor.** Hoy es `CHECK (actor_type in ('user',
'system'))`. Un acceso de soporte no es ninguno de los dos, y colapsarlo en `user` **borraría
exactamente la distinción que este ADR existe para registrar**: el cliente vería en su panel una
acción suya que no hizo. Es una migración sobre una tabla append-only, así que se añade el valor —
las filas existentes no cambian.

**C3 · Esto gobierna el acceso POR LA APLICACIÓN, no el acceso directo a la infraestructura.**
Quien tenga las credenciales del proyecto Supabase no pasa por ninguna de estas defensas: lee
cualquier tenant, desactiva los triggers y reescribe la pista de auditoría. **Este ADR no lo cubre y
no puede cubrirlo.** Registrado como **R-07** en `RISK_REGISTER.md`, con mitigación operativa —
separación de credenciales, MFA, y copia de la auditoría **fuera de la misma base**, que es lo único
que da detección real.

Se dice aquí porque el riesgo no es el acceso en sí: es que la solidez de los controles de
aplicación haga *creer* que este flanco está cubierto.

**C4 · Soporte más lento en el caso difícil.** Pedir consentimiento y esperar aprobación cuesta
tiempo real con el cliente parado. Es el precio de que el acceso sea excepcional, y hay que decirlo
ahora, antes de que alguien proponga saltárselo «solo esta vez».

## Verificación

| Qué | Cómo |
|---|---|
| Un operador **sin** impersonación activa que intenta leer datos de negocio de un cliente **falla** | pgTAP, ejerciendo la lectura y no consultando bits |
| Una impersonación expirada deja de dar acceso **en la consulta siguiente** | pgTAP, reutilizando el escenario de revocación de 007 |
| Toda acción bajo impersonación deja `audit_event` con `actor_type` de soporte | pgTAP + test de integración |
| El cliente **puede leer** esos eventos en su propio alcance | pgTAP con `fiscal.audit.read` |
| Emitir un documento fiscal bajo impersonación **falla** | test de integración, Fase 11 |
| El operador no puede concederse a sí mismo impersonación | pgTAP |

**Y la variante rota, como manda la skill:** desactivar la comprobación de ventana y comprobar que
el test de expiración **se pone rojo**. Un control de acceso que nunca ha fallado no se sabe si
controla algo.
