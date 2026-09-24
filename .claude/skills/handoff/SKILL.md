---
name: handoff
description: Cerrar una sesión o una entrega de Ladino dejando un handoff que permita retomar sin releer todo. Úsalo al terminar una entrega, cuando el contexto se esté llenando o al terminar una jornada. AÑADE la entrada nueva ARRIBA; nunca sobrescribe.
---

# Handoff de sesión — Ladino

`docs/00_GOVERNANCE/HANDOFF.md` es **acumulativo**: tiene una entrada por entrega, **la más nueva
arriba**, y la historia entera se conserva. Es lo que se lee para retomar, y lo que se cita desde
los ADR y el RISK_REGISTER («ver 26ª entrega»).

**No se sobrescribe jamás.** Una versión anterior de esta skill decía «sobrescribe el anterior; el
histórico está en git», y aplicada al pie de la letra habría borrado 29 entregas y 2.900 líneas de
decisiones razonadas. Que algo esté en git no significa que alguien lo vaya a leer.

## Cómo se añade — sin tocar lo que ya hay

1. Escribe la entrada nueva en un fichero aparte (en el scratchpad, no en el repo), y **guarda una
   copia del HANDOFF actual** en el scratchpad: es tu forma de volver atrás.
2. Antepónla al HANDOFF con un separador, **leyendo el fichero original y escribiéndolo entero**
   — nunca con un editor que reemplace el contenido (un hook bloquea además cualquier `Write` que deje
   menos entregas de las que había):

   ```bash
   node -e "
   const fs = require('fs');
   const F = 'docs/00_GOVERNANCE/HANDOFF.md';
   const antes = fs.readFileSync(F, 'utf8');
   const nueva = fs.readFileSync(process.argv[1], 'utf8').trimEnd();
   fs.writeFileSync(F, nueva + '\n\n---\n\n' + antes);
   " <ruta-de-la-entrada-nueva>
   ```

3. **Comprueba que no se perdió nada** — el número de entradas sube exactamente en una:

   ```bash
   grep -c '^# Handoff' docs/00_GOVERNANCE/HANDOFF.md   # antes: N · después: N + 1
   ```

   Si no sube en una, algo se pisó: **restaura la copia del paso 1** y repite. No uses
   `git checkout --`: descartaría también cualquier edición del HANDOFF que aún no esté commiteada.

(No hace falta formatear: `.prettierignore` excluye `docs/`.)

Para CORREGIR una entrada ya escrita (una cifra, un nombre), se edita solo ese fragmento con Edit.
Nunca se reescribe el fichero entero a mano.

## La plantilla de la entrada

```md
# Handoff — AAAA-MM-DD (Nª entrega) — <título que diga qué cambió, no «avances»>

## Qué pasaba
El problema, con cifras si las hay. Qué veía la persona y qué pasaba de verdad.

## Qué se cambió
Por pieza: migración (número y nombre), endpoint, pantalla. Qué hace cada una y POR QUÉ así.

## Pruebas
pgTAP, E2E, QA de pantalla: cuántos, qué cubren. Si una ASERCIÓN EXISTENTE cambió, se dice
aquí con su valor antes y después (regla del dueño: ninguna se cambia sin avisar).

## Lo que queda abierto
Lo que no se hizo y por qué; las migraciones que esperan la ventana de deploy; los VALIDAR-*.

HOMOLOGATION_IMPACT = YES | NO (con la razón)
```

Sé específico. «Continuar con ventas» no sirve. «Implementar `confirmSalesOrder` en
`packages/domain`; ya existen la migración 12 y el schema Zod» sí.

## Numeración

El número de entrega sigue al de la entrada de arriba (la 29ª va seguida de la 30ª). Los riesgos
nuevos del RISK_REGISTER llevan número único: busca el último `### R-NN` antes de añadir uno.
