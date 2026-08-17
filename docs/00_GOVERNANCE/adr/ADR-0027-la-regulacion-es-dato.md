# ADR-0027 — La regulación es dato, no código

- **Estado:** Propuesto · **Fecha:** 2026-08-15 · **Impacto fiscal:** SÍ
  (cambia cómo se clasifica el impacto fiscal, no el comportamiento fiscal)
- **Motivado por:** la derogación de PA SNAT/2024/000121 por PA SNAT/2026/00084
  (Gaceta 43.435, 12/08/2026), sin norma sustituta
- **Enmienda la justificación de:** ADR-0003 · **Se complementa con:** ADR-0028

## Contexto

El 12 de agosto de 2026, la providencia que sostenía todo el andamiaje de homologación de Ladino
**desapareció sin reemplazo**. Con ella cayeron la homologación previa del sistema, la
autorización previa del proveedor y —la de mayor efecto— la obligación del **contribuyente** de
usar software homologado, que vivía en la Disposición Final Cuarta de la propia 121.

El detalle sobre el que hay que decidir no es que la norma cayera. Es **con cuánta violencia se
movió el suelo**: dieciocho meses de requisitos, un checklist de expediente, un gate de release y
ocho `VALIDAR-SENIAT` abiertos, todo evaporado en un día, y con la expectativa pública de que
llegará normativa nueva con estándares técnicos y protocolos de comunicación cuyo contenido nadie
conoce.

Un proyecto que hubiera cableado la 121 en su código estaría hoy con una reescritura por delante.
Ladino no lo está —los controles se construyeron como controles de ERP y la regla de `CLAUDE.md`
§2 impidió hard-codear obligaciones sin fuente— pero eso fue **disciplina**, no arquitectura. Este
ADR lo convierte en arquitectura, porque la disciplina no sobrevive a la rotación de gente y la
próxima sacudida llegará igual.

## Decisión

**La regulación entra al sistema como dato versionado y efectivo por fecha, nunca como estructura
de código.** Corolario operativo: **una norma nueva debe costar un adaptador más una migración de
datos. Nunca una reescritura.**

De ahí se derivan cuatro compromisos concretos.

### 1. El producto no depende de la emisión fiscal para existir

**Ladino sin emisión fiscal es un ERP completo y vendible: administrativo, de inventario y
contable. Con emisión fiscal es un ERP fiscal.** Es la misma base de código, con un módulo
conectado o desconectado.

Esto deja de ser una aspiración y pasa a ser una **restricción verificable**: ningún módulo de
`packages/domain`, `packages/accounting`, `packages/inventory` ni `apps/web` puede importar
`packages/fiscal`, ni degradarse si `ladino-fiscal` no está desplegado. El gate de fronteras de
ADR-0021 ya lo puede comprobar, y a partir de aquí lo comprueba **en esa dirección**, no solo en
la contraria.

La consecuencia comercial importa tanto como la técnica: con la 121 derogada y sin sustituta,
**hoy no hay nada que impida vender y desplegar Ladino en producción** para todo lo que no sea
emisión fiscal. Eso no era cierto hace tres días, y el diseño no cambió: cambió el entorno, y el
diseño lo absorbió.

### 2. Toda regla tributaria es una fila con vigencia, no una rama de código

Ya está en la regla 8 de `CLAUDE.md` para tasas y alícuotas. Se extiende a **todo lo normativo**:
formatos de documento, campos obligatorios, secuencias de numeración, reglas de contingencia,
protocolos de remisión. Cada uno lleva `valid_from`, `valid_to`, fuente citada y versión.

El criterio para distinguirlo es simple y se aplica antes de escribir: **si la respuesta correcta
puede cambiar por una Gaceta, es dato.** Si solo puede cambiar porque nos equivocamos, es código.

`sum(debit) = sum(credit)` es código: ninguna providencia va a derogar la partida doble. El
formato del RIF es dato. La lista de campos obligatorios de una factura es dato. Que una factura
emitida no se edite es código, porque no viene de la 121 sino del Código de Comercio y de la
naturaleza del documento.

### 3. `HOMOLOGATION_IMPACT` cambia de significado y se queda

El campo del formato de entrega **no se retira**. Cambia lo que declara:

- **Antes:** «esto entra al gate de homologación previa».
- **Ahora:** «esto toca comportamiento fiscal observable, y hay que poder decir qué cambió,
  cuándo y bajo qué versión de reglas».

Retirarlo habría sido el error caro. La capacidad de responder *«¿con qué reglas se calculó este
documento?»* no era un requisito de la 121: es lo que permite reconstruir una declaración, atender
una fiscalización y absorber la norma siguiente sabiendo qué se hacía antes. Se conserva por su
utilidad propia, y por eso `rules_version` es columna en `audit_events` desde S0.4.

### 3-bis. Una restricción de unicidad no se construye sobre una columna best-effort

Va aquí y no en un ADR de esquema porque es la misma idea aplicada a otro material: **un dato cuyo
contrato admite «si falta, queda NULL en silencio» no puede sostener una garantía dura.**

El caso que la produjo: en S0.4 se metió `created_by` en el índice único de `idempotency_keys`
para acotar la clave por actor. `created_by` lo rellena un trigger de procedencia desde
`coalesce(auth.uid(), GUC)`, y su propia migración lo documenta en negrita: *si la API olvida
fijar el GUC, queda NULL en silencio*. Resultado medido: el mismo cliente, la misma clave y el
mismo cuerpo, con un intento con GUC y el reintento sin él, **producían dos reservas y dos
efectos**. Un silencio documentado convertido en documento fiscal duplicado.

**La regla:** procedencia y semántica son cosas distintas y no se conflan. `created_by` responde
*quién escribió esta fila, con la mejor información disponible*. `actor_id` responde *en nombre de
quién se reserva esta clave*, es explícito, `NOT NULL`, y lo fija quien tiene la información — no
un efecto lateral de otro mecanismo. Confundirlos hace que cambiar el contrato de uno cambie el
otro **en silencio**, que es el modo de fallo que este proyecto lleva ocho casos documentando.

**Y el corolario, que es el que casi se pierde:** el índice **nunca fue la fuga**. La fuga era el
*lookup de replay*. Un índice acotado por actor no sirve de nada si la consulta que busca la
respuesta guardada no filtra por actor. Arreglar el almacenamiento y no la lectura deja el agujero
intacto con aspecto de cerrado. Escrito en `API_SPEC.md` §Idempotencia.

### 4. La ausencia de norma no es permiso para relajar controles

Los controles de la matriz de PA121 —append-only, RLS, ACID, versionado de reglas, event ledger—
**se quedan enteros**. Dejaron de ser obligación legal y siguen siendo requisitos de producto: un
ERP contable sin trazabilidad no es vendible, homologado o no.

Es el mismo argumento de `CLAUDE.md` §2 en su forma menos evidente: *ausencia de mecanismo no es
prohibición* — y **ausencia de obligación no es autorización**. Que nadie vaya a exigir la pista
de auditoría no la hace prescindible; la hace voluntaria, que es distinto y no cambia nada de lo
construido.

## Consecuencias

**Buenas.**

- Una norma nueva se absorbe por el borde: adaptador y migración de datos, sin tocar dominio.
- El producto es vendible hoy, sin esperar a un régimen que no existe.
- La documentación derogada se conserva como histórico consultable en vez de reescribirse.

**Malas, y asumidas.**

- **El coste de las dos vías de release de ADR-0003 se mantiene** aunque su justificación original
  desapareciera. Es deliberado: ver la enmienda de ADR-0003.
- **`fiscal_protocol_version` y el manifest de release siguen sin implementarse**, y ahora sin la
  urgencia que les daba el gate. Riesgo de que se difieran indefinidamente: queda en el registro.
- **Tratar todo lo normativo como dato tiene coste real.** Una tabla de reglas con vigencia es más
  cara de construir y de probar que un `if`. Se paga a cambio de no reescribir.

**Lo que este ADR no decide.**

- Qué exigirá la norma esperada. No hay borrador, y suponerlo sería exactamente lo que este ADR
  existe para impedir.
- Si Ladino solicitará algo cuando exista un régimen nuevo. Es decisión de negocio.

## Alternativas descartadas

**Retirar los controles de la 121 ahora que nadie los exige.** Descartada por el punto 4: son
controles de ERP, no de homologación. Retirarlos ahorraría poco y habría que reconstruirlos con
datos dentro.

**Congelar `packages/fiscal` hasta que se publique la norma nueva.** Tentador, y equivocado:
lo que hace falta para emitir una factura válida **no cambió** —PA 071 y PA 102 siguen vigentes—.
Lo que cayó es el régimen de autorización del software, no el de emisión del documento.

**Retirar `HOMOLOGATION_IMPACT` del formato de entrega.** Descartada por el punto 3.

## Verificación

| Qué | Dónde |
|---|---|
| Ningún paquete no fiscal importa `packages/fiscal` | `dependency-cruiser` (ADR-0021), en la dirección nueva |
| Ninguna tasa, alícuota, formato u obligación hard-coded sin fuente citada | revisión de `fiscal-reviewer` + hook de `CLAUDE.md` §2 |
| `rules_version` presente y no nulo en toda fila de auditoría | `audit_events.rules_version NOT NULL` (S0.4) |
| El histórico de la 121 sigue legible y sin reescribir | `docs/02_COMPLIANCE/` con encabezados de estado |
