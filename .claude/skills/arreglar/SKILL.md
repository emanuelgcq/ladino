---
name: arreglar
description: Arregla UN hallazgo con la cadena del equipo — test en rojo, arreglo mínimo, revisión en contexto limpio, gate completo — y deja el commit listo. Úsala con el ID de un hallazgo de una auditoría o de un recorrido. Secuencial, nunca en paralelo. Reemplaza a revision-completa.
---

# /arreglar <ID>

Encuentra otro, prueba otro, arregla otro, revisa otro, valida otro. **Nadie revisa su propio
trabajo.**

## Antes de empezar

Si queda la marca de un recorrido, `.recorrido/.suplentes-solo-lectura`, **se retira**: con ella, un
`general-purpose` que haga de suplente del reparador o del escritor de tests no puede escribir
(`guard-agentes.sh` lo trata como de solo lectura). Los suplentes solo hacen falta si el runtime no
cargó los agentes del equipo al abrir la sesión.

## La cadena — estrictamente secuencial

1. **`escritor-tests`** — recibe el hallazgo (ID, dónde, cómo reproducirlo) y escribe el test que
   lo demuestra. **Tiene que salir en ROJO por la razón correcta.** Si sale «no reproducible», la
   cadena PARA: se reporta al dueño que el hallazgo quizá no existe, con la evidencia.

2. **`reparador`** — recibe el hallazgo y la ruta del test en rojo. Lo pone en verde con el cambio
   mínimo, más la migración y la documentación que el cambio exija. Si reporta **PARÉ POR**, la
   cadena PARA y la decisión va al dueño (R9).

3. **`revisor`** — recibe **solo** el ID, el criterio y la indicación de mirar el diff (`git diff`).
   **Nunca** la conversación, ni el razonamiento del reparador, ni su informe: el contexto limpio es
   lo que le permite ver lo que el reparador no vio.
   - `aprobado` → paso 4.
   - `cambios` → vuelve al `reparador` **UNA vez** con las razones del revisor, y otra vez al
     `revisor`.
   - `bloqueado`, o `cambios` por segunda vez → la cadena PARA y se reporta al dueño.

4. **`validador`** — gate completo con `scripts/gate-verdict.sh` contra la línea base, e invariantes.
   Un test menos que la base es rojo. **Rojo → la cadena PARA** y se reporta; no se intenta otro
   arreglo encima.

5. **La sesión principal** hace el commit (mensaje en inglés, qué y por qué, la atribución que toque)
   y el **push**, porque el validador salió en verde (CLAUDE.md §3). Los agentes nunca hacen push
   (R6: un hook lo bloquea).

   **Excepción — lo estructural sigue necesitando al dueño** (CLAUDE.md §2): si el arreglo trae una
   migración nueva, un ADR o un cambio de contrato de la API, se deja el commit preparado y se
   reporta; no se commitea sin su aprobación explícita.

## Lo que se entrega al dueño

Los cinco informes, uno por agente, en su formato exacto, y una línea de cierre:
`/arreglar <ID> · rojo→verde · revisor <veredicto> · gate <veredicto> · commit <hash> | PARADO EN <paso>: <por qué>`.
