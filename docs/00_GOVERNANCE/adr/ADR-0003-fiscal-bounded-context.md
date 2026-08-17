# ADR-0003 — El componente fiscal es un bounded context aislado con release train propio

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** SÍ
- **Enmendado el 2026-08-15** (justificación, no decisión) — ver §Enmienda

## Contexto
Si cada despliegue de una pantalla de CRM implicara rehomologar el sistema fiscal, el producto
sería inmantenible. La separación es una decisión de supervivencia comercial, no de elegancia.

> **Este párrafo ya no describe la realidad, y se conserva a propósito.** PA SNAT/2024/000121 fue
> derogada el 12/08/2026 sin sustituta: **no hay rehomologación que evitar**. Ver la enmienda.

## Enmienda 2026-08-15 — la decisión se mantiene, la justificación cambia

**La decisión no se toca.** `packages/fiscal` sigue siendo un bounded context aislado con release
train propio. Lo que cambia es **por qué**, y conviene que quede escrito, porque una decisión que
sobrevive a la desaparición de su motivo original es exactamente la que alguien propondrá revertir
dentro de un año — con el argumento correcto de que el gate de homologación ya no existe.

**Justificación original (2026-08-07):** evitar rehomologar el sistema en cada despliegue de una
pantalla no fiscal. Válida entonces. **Vacía hoy.**

**Justificación vigente (2026-08-15): absorber volatilidad regulatoria.** El argumento nuevo es
más fuerte que el que sustituye, y la prueba es lo que acaba de pasar:

- En dieciocho meses, el régimen fiscal venezolano pasó de *«homologación previa obligatoria del
  sistema y del proveedor»* a *«ninguna obligación»*, **en un día y sin sustituta**. Se espera
  normativa nueva con estándares técnicos y protocolos de comunicación, de contenido desconocido.
- Un producto con la lógica fiscal repartida por el dominio habría necesitado una reescritura para
  absorber la 121 en 2024, otra para la derogación en 2026, y una tercera cuando llegue la
  siguiente.
- Con la frontera puesta, las tres son lo mismo: cambiar lo que hay detrás de una interfaz.

Dicho de otro modo: la frontera se justificaba por un gate que podía desaparecer —y desapareció—;
ahora se justifica por la **tasa de cambio del entorno**, que no va a desaparecer. Es el mismo
límite defendido por una razón que no depende de que ninguna providencia concreta siga en vigor.

**Y el corolario comercial, que es el que paga la sobrecarga:** con la frontera puesta, **Ladino
sin emisión fiscal es un ERP completo y vendible hoy**. Sin ella, el producto entero quedaría
esperando a un régimen que no existe. ADR-0027 lo convierte en restricción verificable.

**El `VALIDAR-SENIAT` de las consecuencias queda resuelto** —no contestado: disuelto—. La pregunta
era si SENIAT aceptaría la frontera para no rehomologar. Sin homologación, la pregunta no tiene
objeto. Si un régimen nuevo la reintroduce, vuelve a abrirse **tal cual**, y por eso se deja
escrita abajo en vez de borrarla.

## Decisión
`packages/fiscal` + contenedor `ladino-fiscal` con contrato versionado, `fiscal_protocol_version`
en el payload, migraciones compatibles, adaptadores tras interfaz, y ciclo de release propio.
El resto del ERP se despliega libremente sin tocar el artefacto fiscal.

## Consecuencias
- (+) UI, CRM, inventario y analítica evolucionan sin gate de homologación.
- (−) Sobrecoste de mantener dos trenes de release y una ventana de compatibilidad.
- (−) ~~**`VALIDAR-SENIAT`**: que la frontera sea aceptada como tal por SENIAT no está confirmado.
  Si no lo fuera, la consecuencia es que todo despliegue entra al gate; el diseño sigue siendo
  correcto, solo más caro.~~
  **RESUELTO 2026-08-15 por derogación** (PA SNAT/2026/00084, Gaceta 43.435). No hay gate al que
  entrar. Se tacha en vez de borrarse: si un régimen nuevo reintroduce la homologación, esta
  pregunta vuelve exactamente como está escrita.

## Verificación
Un despliegue de `apps/web` no cambia el digest de `ladino-fiscal` ni el manifest fiscal.
