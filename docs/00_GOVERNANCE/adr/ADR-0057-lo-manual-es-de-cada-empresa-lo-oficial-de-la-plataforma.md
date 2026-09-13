# ADR-0057 — Lo manual es de cada empresa; lo oficial es de la plataforma

- **Estado**: aceptada (orden del dueño de resolver todos los hallazgos, 2026-09-12)
- **Fecha**: 2026-09-12
- **Módulos**: ventas (tasas de cambio, reglas tributarias) · compras (reglas de
  retención) · puesta a punto fiscal · RLS
- **HOMOLOGATION_IMPACT**: **SÍ**. Cambia QUÉ regla tributaria y QUÉ tasa
  resuelve la emisión para cada empresa. No cambia el cálculo, ni el formato,
  ni la numeración. Las reglas y tasas ya copiadas en documentos emitidos no
  se tocan (R-05: el documento copia, no referencia).

## Contexto

`tax_rules`, `exchange_rates` y `retention_rules` nacieron **globales**, con la
excepción declarada de ADR-0025 §3 («una alícuota es de la jurisdicción, no de
la empresa»). Eso era cierto para lo que la migración iba a sembrar. Pero el
catálogo nace vacío (ADR-0038, ADR-0039) y lo llenan **personas con permisos
de una empresa**: `fx.rate.manage`, `tax.rules.manage`, `retention.rules.manage`.
La auditoría del 2026-09-11 (hallazgo A-22) lo midió:

- Una empresa carga una tasa manual USD→VES de 1,00 y todas las demás emiten
  con ella hasta que llegue la siguiente tasa del BCV.
- La primera empresa que acepta la alícuota en el asistente fija `tax_rules`
  para toda la instancia; las siguientes reciben `rules_created: 0` sin saber
  que están facturando con la regla de otro.
- Una regla de retención cargada por un tenant la aplica `resolve_retention`
  a todos los tenants.

Es una fuga de aislamiento (regla 5) por la puerta de tres tablas que no
llevan ancla.

## Decisión

**Cada fila declara de quién es.** Las tres tablas llevan `tenant_id` y
`company_id`, ambos nulos o ambos con valor, con la FK compuesta a `companies`
(ADR-0025 §9.1) y el trigger de ancla inmutable (test 006, sin excepciones):

- **`NULL` = de la plataforma.** La tasa oficial del BCV que trae el refresco
  o el botón «Traer del BCV», y las reglas que siembre el sistema por
  migración. Es el mismo patrón de `roles.tenant_id` nullable (ADR-0025 §3):
  nulo es «de sistema», con valor es «propio».
- **Con valor = de esa empresa.** Toda fila escrita con un permiso de empresa
  la lleva. Una tasa tecleada, «la tasa sigue igual», la alícuota aceptada en
  el asistente, una regla de retención cargada.

**Resolución: lo propio gana a lo de la plataforma; después, la regla de
siempre.**

- `platform.rate_for(p_company, from, to, fecha)` y `platform.rate_at(p_company,
  …)`: entre las tasas visibles para la empresa (las suyas y las de la
  plataforma), la de fecha más reciente que no sea posterior; a igual fecha, la
  propia antes que la oficial; a igual todo, la más recientemente creada.
- `platform.resolve_tax(p_company, …)` y `platform.resolve_retention(p_company,
  …)`: si la empresa tiene alguna regla propia vigente para ese hecho, se
  resuelve **solo** entre las propias; si no, solo entre las de la plataforma.
  Dentro del nivel elegido, prioridad y ambigüedad exactamente como hasta hoy
  (LAD50 / LAD53 sin cambios).
- Las firmas viejas, sin empresa, **se eliminan**. Una consulta sin empresa no
  puede existir a medias: falla al compilar, no devuelve la tasa de otro.

**La base decide quién puede escribir qué**, no la API:

- `authenticated` lee las filas de la plataforma y las de sus empresas.
  `ladino_api` lee las de la plataforma y las de los tenants del actor.
- `ladino_api` inserta filas **con empresa** solo dentro de los tenants del
  actor, y filas **de plataforma** solo cuando el actor es el de sistema
  (`platform.ladino_actor_is_system()`): el refresco del BCV y el botón «Traer
  del BCV», que escribe con actor de sistema después de comprobar el permiso.
- La API actualiza (inactiva) solo filas con empresa. Las de la plataforma se
  cambian por migración.

**La unicidad por par, fuente y día pasa a ser por ámbito**: `exchange_rates_day_key`
incluye `scope_key` (la empresa, o el cero de la plataforma). Dos empresas
pueden teclear su propia tasa del mismo día; una misma empresa, no.

**Lo ya cargado se atribuye a quien lo cargó.** La migración asigna cada fila
con `created_by` a la única empresa de ese usuario; las tasas cuya fuente es
«BCV oficial vía DolarAPI» y las filas sin autor quedan en la plataforma. Una
fila cuyo autor tenga varias empresas queda en la plataforma: atribuirla a
una sería inventar.

## Por qué así y no de otra forma

- **Alternativa descartada — permiso de plataforma para escribirlas.** Cierra la
  fuga pero deja a cada empresa sin poder teclear su tasa cuando no hay
  internet, que es exactamente el fallback que ADR-0028 promete.
- **Alternativa descartada — solo las filas nuevas llevan empresa.** Dejaba la
  tasa de 1,00 ya cargada visible para todos hasta que otra la tapara. El
  arreglo tiene que valer para lo que ya está, no solo para lo que venga.
- **Por qué la plataforma sigue existiendo.** La tasa oficial es UN hecho para
  todos; replicarla por empresa multiplicaría filas idénticas y abriría la
  puerta a que dos empresas tuvieran «tasas oficiales» distintas.

## Consecuencias

- Tras desplegar, una empresa que facturaba con la alícuota aceptada por OTRA
  la pierde: `resolve_tax` responde LAD50 hasta que pase por «Aceptar la
  alícuota» en su propio asistente. Es el comportamiento correcto y el
  asistente lo enseña como paso pendiente. **VALIDAR-OPERACIÓN**: revisar en
  producción, después de la migración, que cada empresa activa tiene su
  `iva_general` en `/v1/fiscal/setup`.
- Toda lectura de tasa en dominio y API pasa por `rate_for`/`rate_at` con la
  empresa: se eliminan los doce `select … from exchange_rates … order by
  rate_date desc` repetidos. Un solo criterio de «la tasa del día».
- pgTAP 052 fija: la tasa propia gana a la oficial del mismo día; la oficial
  más reciente gana a la propia más antigua; una regla propia oculta las de la
  plataforma para esa empresa y no para otra; las firmas sin empresa ya no
  existen; la API no inserta filas de plataforma con actor de usuario.
- Índice: ADR-0025 §3 queda matizado — la excepción «catálogo global» sigue
  valiendo para `permissions`; las tres tablas de este ADR dejan de acogerse a
  ella.
