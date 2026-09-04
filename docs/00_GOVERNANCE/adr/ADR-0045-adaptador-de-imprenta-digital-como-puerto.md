# ADR-0045 — El adaptador de imprenta digital es un puerto, y hoy es null

- **Estado:** Aceptado
- **Fecha:** 2026-09-02
- **Impacto fiscal:** SÍ

## Contexto

La PA 102 (vigente, obligatoria para sus sujetos desde el 01/03/2025) crea la vía de la
**imprenta digital**: un tercero autorizado que asigna el número de control **documento a
documento** — no por rangos preasignados como en la forma libre. ADR-0037 ya modeló ese mundo
(`numbering_mode = 'per_document'`: el documento se emite con `control_number` NULL y se
completa cuando la imprenta responde), pero lo dejó **deshabilitado**: ninguna empresa puede
quedar en `per_document` porque el flujo de dos fases con la imprenta seguía sin contrato
(OPEN_QUESTIONS 10).

El formato del número de control lo fija el **art. 30 de la PA 102**: la expresión «N° de
Control», un identificador de **dos dígitos** y un secuencial de **hasta ocho dígitos**,
arrancando en 00-1.

Restricciones: la imprenta es un servicio EXTERNO que exige elegir un proveedor de la lista
de imprentas digitales **autorizadas** vigente — lista que no está en este repositorio y que
no se inventa (**VALIDAR-SENIAT**). `packages/fiscal` es puro (ADR-0021): sin I/O, sin
clientes HTTP. Y el equipo es una persona: el contrato tiene que poder probarse hoy sin el
proveedor.

## Opciones consideradas

1. **Esperar a elegir imprenta y escribir adaptador y contrato juntos** — a favor: cero
   especulación. En contra: el régimen `per_document`, la contingencia y los libros no pueden
   ni diseñarse contra una interfaz; cada pieza acoplaría con la PRIMERA imprenta elegida.
2. **Contrato ahora, implementación nula que rechaza** (el patrón de `NullTransmitter`,
   ADR-0028) — a favor: el dominio consume una interfaz estable; cambiar de proveedor no toca
   el dominio (regla de `packages/fiscal/CLAUDE.md`); el estado real («no hay imprenta») es un
   error explícito, no un stub que finge. En contra: el contrato puede necesitar ajustes cuando
   exista el primer proveedor real.
3. **Stub que devuelve controles de mentira en desarrollo** — en contra y descartado con
   fuerza: un número de control inventado es un documento fiscal falso; un stub que «funciona»
   en dev es exactamente el código-que-parece-funcionar contra el que este repo ya se quemó.

## Decisión

La opción 2. En `packages/fiscal/src/print-shop.ts`:

- **`DigitalPrintShopAdapter`** — un método: `assignControlNumber(documento, señal?) →
  { control_number, assigned_at, print_shop_rif }`. El documento de entrada lleva lo que la
  imprenta necesita (emisor, tipo, serie, correlativo ya asignado, fecha, total como string).
  El adaptador rechaza si el proveedor no responde; el consumidor decide reintento o
  contingencia (talonario físico, migración 35). Debe honrar `AbortSignal` y el plazo que el
  consumidor imponga — el mismo contrato temporal del transmitter (ADR-0028).
- **`CONTROL_NUMBER_RE`** (`^\d{2}-\d{1,8}$`) — el formato del art. 30, exportado para que el
  consumidor valide TAMBIÉN la respuesta de un adaptador real: la imprenta es externa y su
  respuesta no se presume bien formada.
- **`NullDigitalPrintShop`** — la implementación correcta del estado actual: **rechaza** con
  «no hay imprenta digital configurada», citando este ADR. Nunca finge.

La implementación real queda como **dependencia externa**: exige que el operador elija un
proveedor de la lista de imprentas digitales autorizadas vigente (VALIDAR-SENIAT — la lista
no está en el repo). Vivirá fuera de `packages/fiscal` (ADR-0021), detrás de esta interfaz.

## Consecuencias

- Positivas: `per_document` ya tiene contra qué diseñarse; la contingencia (migración 35) es
  la rama «la imprenta no responde» de este mismo contrato; cambiar de imprenta es cambiar un
  adaptador, no el dominio.
- Negativas y deuda aceptada: el contrato está probado solo contra el null — el primer
  proveedor real puede forzar una revisión (campos extra, autenticación, idempotencia del
  lado de la imprenta). El flujo de dos fases COMPLETO (qué es «emitido» si la imprenta
  responde tras timeout) sigue abierto: OPEN_QUESTIONS 10 **no** se cierra aquí; se cierra
  cuando el consumidor exista y se pruebe contra un proveedor.
- Revertirla: borrar `print-shop.ts` y este ADR; nada más lo importa todavía.

## Verificación

- `print-shop.test.ts`: el null RECHAZA con mensaje claro (jamás resuelve) y
  `CONTROL_NUMBER_RE` acepta exactamente la forma del art. 30 (00-1 … 99-12345678) y nada más.
- El día que exista el primer adaptador real: sus respuestas pasan por `CONTROL_NUMBER_RE`
  antes de tocar `documents.control_number`, y `per_document` se habilita SOLO para empresas
  con imprenta configurada. Revisión de este ADR al elegir proveedor.
