# ADR-0029 — El régimen fiscal es dato versionado por empresa

- **Estado:** Propuesto · **Fecha:** 2026-08-18 · **Impacto fiscal:** SÍ
- **Aplica:** ADR-0027 (la regulación es dato) al propio régimen · **Consume:** ADR-0028 (adaptadores)
- **Implementación:** Fases 10–11. **Este ADR es solo la decisión.**

## Contexto

Ladino es multi-empresa y multi-cliente. La pregunta que no tiene respuesta hoy es cómo gobierna
el operador que **una empresa opera bajo un régimen fiscal y otra bajo otro**.

La tentación es un booleano —`emite_facturas` o `usa_imprenta_digital`— y es incorrecta por tres
razones independientes, cada una suficiente por sí sola.

**No es binario.** Conviven, hoy y a la vez:

| Régimen | Norma |
|---|---|
| Sin emisión fiscal (solo ERP administrativo y contable) | ninguna |
| Formatos libres | PA SNAT/2011/00071 |
| Digital vía imprenta autorizada | PA 102 |
| Máquina fiscal | PA SNAT/2018/0141 |
| Con transmisión al SENIAT | la norma esperada (no publicada) |

**No es global, es por empresa.** Veinte clientes en regímenes distintos no es un caso raro: es el
caso normal de un SaaS. Y una misma empresa puede tener sucursales con máquina fiscal y ventas
digitales conviviendo.

**No es puntual, es histórico.** Una factura emitida en septiembre bajo el régimen A tiene que
seguir siendo reproducible en 2029 aunque la empresa cambiara al B en octubre. Un campo
sobrescribible no puede sostener eso.

## Decisión

**El régimen fiscal es dato versionado por empresa, efectivo por fecha, con la norma que lo
respalda citada. No es un flag, no es una rama de código, y no se sobrescribe.**

### 1. `fiscal_regimes` — catálogo gobernado por el operador

Un régimen declara: código, qué documentos permite emitir, si la numeración es interna o de
imprenta, si exige transmisión, **qué adaptador de ADR-0028 usa**, y **la norma que lo respalda con
Gaceta y fecha**.

Ese último campo no es documentación: es la aplicación de `CLAUDE.md` §2 al catálogo. Un régimen
sin fuente normativa citada es una obligación inventada, y aquí sería una inventada *para todos los
clientes que se le asignen*.

### 2. `company_fiscal_regime` — el vigente por empresa, append-only

Régimen vigente por empresa con `effective_from`, quién lo asignó y cuándo. **Append-only: se
cierra el vigente y se abre otro.** Nunca un `UPDATE` sobre la fila en curso.

Es la misma decisión que ADR-0006 toma para los asientos, por el mismo motivo: el histórico *es* el
dato. Sobrescribir el régimen de una empresa borraría la única evidencia de bajo qué reglas operó
el trimestre pasado.

### 3. Todo documento emitido persiste `regime_id` y `rules_version`

**Cambiar de régimen no toca ningún documento pasado.** Es R-05 aplicado a una dimensión más: lo
que valía en el momento de emitir se congela con el documento.

`rules_version` ya es columna en `audit_events` desde S0.4, por esta misma razón.

### 4. Dos capas que no se confunden: qué soporta el build y qué tiene la empresa

- **Qué regímenes soporta el build es CÓDIGO**, y va en el version manifest junto a
  `fiscal_protocol_version`.
- **Qué régimen tiene una empresa es DATO.**

Y la consecuencia operativa, que es el punto de la separación: **asignar a una empresa un régimen
que el build no soporta falla AL ASIGNARLO**, no al emitir la primera factura tres semanas después.
Un fallo en el momento de la decisión administrativa, no en mitad de una operación de caja.

Es `CLAUDE.md` §2 otra vez: si algo no debe poder hacerse, tiene que fallar activamente.

## 5. `fiscal_regimes` es append-only y versionado — resolviendo la tensión con R-05

**El problema.** R-05 exige que los documentos fiscales **copien** el snapshot de identidad fiscal,
no que lo referencien, porque con un `JOIN` un solo `UPDATE` reescribe retroactivamente el pasado.
`regime_id` es una **referencia**, y el catálogo lo gobierna el operador: es mutable. Una factura de
septiembre apunta a `regime_id = 3`; en 2027 el operador corrige la definición del régimen 3; esa
factura pasa a reproducirse bajo reglas que no existían cuando se emitió. **Documento inmutable
reinterpretado sin tocar una fila del documento.**

**La decisión: `regime_id` apunta a una VERSIÓN concreta del régimen, no al régimen.** El catálogo
es append-only: corregir un régimen **crea una versión nueva**, y los documentos emitidos siguen
apuntando a la vieja.

Se descartan las dos alternativas, y por qué importa:

- **Que el documento copie los atributos**: la lista de atributos a copiar crece con cada norma y
  nadie la mantiene completa. Una copia incompleta es peor que una referencia, porque *parece*
  congelada.
- **Referencia versionada + copia**: dos fuentes que deben concordar acaban discrepando, y entonces
  hay que decidir cuál gana con un documento fiscal de por medio.

Es la misma forma que ADR-0006 (append-only) y que la regla 8 de `CLAUDE.md` (tasas efectivas por
fecha y fuente). El régimen deja de ser un puntero móvil y pasa a ser un hecho fechado.

### 5.1 Qué captura una versión de régimen — y por qué la lista es exhaustiva

**Una lista no se puede demostrar exhaustiva enumerando.** Cualquier enumeración es «suficiente
hoy», y el fallo vuelve por la puerta de atrás en cuanto una norma añada un atributo que nadie
metió en el versionado. Así que la exhaustividad se construye de otra forma: con una **regla de
cierre** y una **propiedad verificable**.

**La regla de cierre.** La reproducción de un documento descansa sobre **cuatro anclas de versión**,
y no hay una quinta:

| Ancla | Qué gobierna | Dónde vive |
|---|---|---|
| `rules_version` | cálculo tributario: alícuotas, bases, retenciones | ya es columna en `audit_events` (S0.4) |
| `rounding_policy_id` | redondeo y reparto de residuos | `MonetaryFact`, ADR-0024 |
| `fiscal_protocol_version` | qué soporta el build | version manifest, ADR-0009 |
| **`regime_version_id`** | **todo lo demás que afecta a la reproducción** | este ADR |

La cuarta es **el complemento de las otras tres**, no una lista paralela. Definida así, la pregunta
«¿está esto versionado?» tiene siempre respuesta: si un atributo afecta a cómo se reproduce un
documento y no cae en las tres primeras, **cae aquí por definición**. No hay hueco donde algo se
escape sin que alguien lo haya sacado a propósito.

Lo que hoy cae en la cuarta, sabiendo que la lista puede crecer **dentro** de ella sin romper nada:
qué documentos permite emitir · numeración interna o de imprenta, con sus reglas de serie y número
de control · campos obligatorios del documento y su disposición · si exige transmisión y con qué
adaptador de ADR-0028 y qué versión de su contrato · reglas de contingencia aplicables · la norma
que lo respalda con Gaceta y fecha.

**La propiedad verificable, que es lo que convierte la regla en algo falsable:**

> Reemitir un documento con **los mismos insumos** y **las mismas cuatro anclas** debe producir un
> documento **idéntico**. Si difiere, hay un atributo fuera del versionado — y el test dice cuál.

Eso es un test de reproducción, no una revisión de código, y no depende de que nadie se acuerde de
nada. Es el equivalente del gate de coste de S0.4: la propiedad se comprueba, no se confía.

**Y la consecuencia operativa:** al añadir un atributo nuevo al régimen, la pregunta no es «¿hay que
versionarlo?» sino «¿en cuál de las cuatro anclas entra?». Si la respuesta es «en ninguna», es que
afecta a la reproducción y no está versionado: eso es el defecto, y hay que pararse ahí.

## Consecuencias

**Buenas.**

- Una providencia nueva se absorbe añadiendo un régimen al catálogo, no tocando el dominio: es
  ADR-0027 aplicado a su propio caso.
- Veinte clientes en cinco regímenes distintos no requieren cinco builds.
- El régimen «sin emisión fiscal» deja de ser un caso especial y pasa a ser una fila más — que es
  lo que hace vendible el producto hoy, con la 121 derogada.

**Malas, y asumidas.**

- Un catálogo con vigencia es más caro de construir y de probar que un `enum`.
- **Corregir una errata en un régimen crea una versión.** Es el coste de append-only y se paga
  igual que en los asientos: no hay «corrección menor» que no deje rastro.
- El version manifest no existe todavía (S0.6 diferido), así que la comprobación build↔régimen no
  tiene dónde apoyarse aún.

## Verificación

| Qué | Cuándo |
|---|---|
| **Reemitir con los mismos insumos y las mismas cuatro anclas produce un documento idéntico** — la propiedad que hace falsable la exhaustividad de §5.1 | Fase 11, y es el test que gobierna todo este ADR |
| Corregir un régimen crea versión nueva; los documentos viejos siguen apuntando a la anterior | Fase 10, pgTAP |
| Asignar un régimen no soportado por el build falla **al asignar** | Fase 10 |
| `company_fiscal_regime` rechaza `UPDATE` sobre la fila vigente | Fase 10, pgTAP |
| Todo régimen del catálogo tiene norma con Gaceta y fecha | Fase 10, `CHECK` + `fiscal-reviewer` |

**Variante rota:** quitar una versión del ancla —dejar que `regime_id` apunte al régimen y no a su
versión— debe poner **en rojo** el test de reproducción. Si no lo pone, el test no mide lo que dice.
