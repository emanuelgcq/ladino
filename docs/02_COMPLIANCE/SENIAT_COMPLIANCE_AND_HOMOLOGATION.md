# Cumplimiento y homologación SENIAT

> # ⛔ DOCUMENTO HISTÓRICO — LA NORMA QUE LO SOSTIENE ESTÁ DEROGADA
>
> **PA SNAT/2024/000121 fue derogada por PA SNAT/2026/00084**, Gaceta Oficial N.º 43.435 del
> **12/08/2026**, **sin norma sustituta**.
>
> **Nada de lo que este documento describe es exigible hoy**: ni la homologación del sistema, ni la
> autorización previa del proveedor, ni la obligación del contribuyente de usar software
> homologado —que vivía en la Disposición Final Cuarta de la propia 121 y cae con ella—, ni el
> checklist de expediente, ni las prohibiciones del Art. 8.
>
> **Se conserva a propósito y no se actualiza.** Si la 121 vuelve reformada, la pregunta útil no
> será «¿qué dice la nueva?» sino «¿qué cambió respecto de esta?», y para responderla hace falta
> el texto de entonces, no una versión reescrita a posteriori. Un histórico corregido no es un
> histórico.
>
> Estado vigente en **`REGULATORY_STATUS.md`**, que es el punto de entrada de esta carpeta.
> Por qué la arquitectura no cambia: **ADR-0027**. Qué se deja preparado para la norma esperada:
> **ADR-0028**.

> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Base principal

Providencia Administrativa **SNAT/2024/000121**, Gaceta Oficial N.º 43.032 del 19/12/2024.

## Requisitos del sistema — PA121 Art. 3

Ladino debe demostrar:

1. integridad, continuidad, confiabilidad, conservación, accesibilidad, legibilidad, trazabilidad, inalterabilidad e inviolabilidad de registros;
2. capacidad de remisión electrónica al SENIAT de registros de facturación/interés fiscal en la forma exigida;
3. registro automático de eventos/interacciones relevantes;
4. corrección/anulación de factura solamente mediante nota de débito/crédito, preservando el original;
5. seguimiento fiable y timestamp de datos;
6. aplicación correcta de reglas de IVA que correspondan;
7. cumplimiento de normas generales de facturación;
8. clave/acceso de consulta SENIAT al sistema, API y funcionalidades exigidas.

## Requisitos del proveedor

PA121 exige que proveedores de estos sistemas estén previamente autorizados y contempla proveedores domiciliados en el país. La solicitud incluye, entre otros:
- identificación;
- email;
- ficha técnica del sistema;
- aplicativo/lenguaje/base de datos;
- monitoreo y auditoría;
- tipo de conexión;
- manuales;
- documentación societaria;
- declaración jurada.

`BLOCKER`: definir la persona jurídica/proveedor venezolano de Ladino antes del expediente.

## Evaluación y autorización

- SENIAT realiza evaluación técnica.
- El informe técnico es vinculante.
- Luego existe un lapso normativo para acto de homologación/autorización.
- Nueva versión fiscal: debe solicitarse homologación.

## Impacto directo en CI/CD

**No** se puede tratar producción fiscal como “continuous deployment” irrestricto.

Se establecen dos canales:
- `platform-release`: UI, reportes no fiscales, performance, etc.
- `fiscal-certified-release`: artefacto versionado sujeto a análisis de impacto y homologación cuando corresponda.

## Obligaciones críticas PA121 Art. 8

- no comercializar sistemas no homologados/autorizados para la función fiscal;
- no permitir contabilidad fiscal alterna;
- prevenir conexión de equipos/dispositivos no fiscales o no homologados en el alcance que determine SENIAT;
- notificar irregularidad/alteración del sistema por sujeto pasivo.

### BLOCKER cloud/mobile
`VALIDAR-SENIAT`: el numeral relativo a dispositivos no fiscales/no homologados requiere interpretación formal para una arquitectura web + Expo con BYOD. No asumir que “cualquier teléfono” puede ser estación fiscal sin evaluación.

## Arquitectura de evidencia

Ladino implementará, como recomendación técnica:
- fiscal event store append-only;
- hash por registro y hash encadenado por secuencia;
- snapshots periódicos firmados;
- logs de acceso;
- audit API read-only;
- retención prolongada;
- versionado de reglas;
- evidencia de build desplegado.

Estas técnicas **son decisiones de diseño**, no deben presentarse como algoritmos exigidos literalmente por PA121.

## Checklist de expediente

- ficha técnica;
- diagramas;
- modelo de datos;
- arquitectura;
- manual de usuario;
- manual de auditoría;
- manual de contingencia;
- seguridad;
- control de versiones;
- API de consulta;
- catálogo de eventos;
- pruebas de integridad;
- pruebas de notas crédito/débito;
- numeración;
- integración imprenta digital;
- plan de remisión SENIAT;
- evidencia de versionado.
