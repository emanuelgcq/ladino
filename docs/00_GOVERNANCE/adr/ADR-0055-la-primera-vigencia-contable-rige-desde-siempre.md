# ADR-0055 — La primera vigencia contable rige desde siempre

- **Estado**: aceptada (orden del dueño de resolver todos los hallazgos, 2026-09-12)
- **Fecha**: 2026-09-12
- **Módulos**: contabilidad (plantillas de asiento, papeles contables, cola de pendientes)
- **HOMOLOGATION_IMPACT**: NO. No toca documentos fiscales ni numeración; cambia
  desde cuándo una plantilla contable se considera vigente.

## Contexto

ADR-0042 dejó una promesa: *documento posteado ⇒ asiento o fila en cola*, y
la cola se vacía con «Contabilizar los pendientes». ADR-0029 fijó que las
plantillas y los papeles tienen vigencia por fecha y se cierran, no se borran.
Las dos cosas juntas producían este efecto (hallazgo A-11 de la auditoría del
2026-09-11):

- `journal_templates.effective_from` y `company_account_settings.effective_from`
  nacen con `default now()`.
- El generador exige una plantilla vigente **a la fecha del documento**
  (`journal-generator.ts`), y el reproceso reusa el `posting_date` original.
- Luego todo hecho emitido ANTES de importar el plan quedaba en cola con «No
  hay plantilla de mapeo», y el botón que existe para vaciar la cola volvía a
  encontrar la misma ausencia: revisados 1, contabilizados 0, pendientes 1.

En producción son 1.527 hechos (los del arranque de la empresa «Ladino»); en
local se reprodujo con una sola factura. El dueño pospuso el reproceso el
2026-09-10 sin saber que el botón no lo iba a hacer.

## Decisión

**La PRIMERA vigencia de cada plantilla (por empresa y hecho) y de cada papel
(por empresa y propósito) rige desde siempre: `effective_from = -infinity`.**
Las versiones siguientes empiezan cuando se crean y cierran a la anterior,
exactamente como hasta hoy (ADR-0029 intacto).

- Migración 50 lo aplica a lo ya existente: la fila más antigua de cada grupo
  pasa a `-infinity`.
- `importJournalTemplates` y `setAccountPurpose` insertan con `-infinity`
  cuando no existía ninguna vigencia previa del grupo, y con `now()` cuando la
  hay.
- El generador y el reproceso no cambian: con la vigencia abierta hacia atrás,
  el hecho antiguo encuentra su plantilla.

## Por qué así y no de otra forma

- **Es lo que el contador pide al configurar.** Quien importa el plan el día 15
  espera que las ventas del 1 al 14 se contabilicen con ese plan; no existe
  otra plantilla con la que pudieran contabilizarse.
- **No reescribe historia.** Un hecho que YA tiene asiento no se toca; solo
  los que están en cola. Y una plantilla que fue sustituida conserva su cierre:
  los hechos posteriores al cambio siguen tomando la vigente a su fecha.
- **Alternativa descartada — que el reproceso use «la primera plantilla
  vigente».** Resolvía la cola pero dejaba la regla en el código del backfill,
  invisible para el generador en línea y para quien lea la tabla. La vigencia
  en la fila es la única fuente de verdad.

## Consecuencias

- Tras desplegar la migración 50 y la API, «Contabilizar los pendientes» debe
  dejar la cola de producción en cero. `accounting_coverage_gaps()` sigue
  siendo el invariante que lo comprueba.
- Los asientos generados por el reproceso llevan su `posting_date` original
  (el día de Caracas del hecho, ADR-0054) y `rules_version` de hoy: la
  auditoría dice con qué versión de reglas se asentó cada uno.
- pgTAP 050 fija la regla: tras la migración no existe un grupo cuya vigencia
  más antigua no sea `-infinity`, y una segunda versión sigue empezando en
  `now()`.
