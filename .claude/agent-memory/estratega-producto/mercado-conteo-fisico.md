---
name: mercado-conteo-fisico
description: cómo hacen el conteo físico de inventario los competidores (Loyverse confirmado); Ladino exige delta calculado a mano
metadata:
  type: project
---

Loyverse tiene un flujo de "Inventory count" separado del ajuste: la persona teclea la
CANTIDAD CONTADA de cada ítem (o escanea el código de barras tantas veces como unidades ve),
y el sistema calcula la diferencia contra lo que el sistema esperaba — full count (todo el
catálogo con seguimiento de stock) o partial count (una lista elegida a mano). Fuente:
https://help.loyverse.com/help/how-work-inventory-count (consultado 2026-09-25).

Ladino solo tiene "Ajuste", que pide un "Delta (con signo)" con el hint "Ej. -3 para
faltante, 3 para sobrante" (`apps/web/src/pages/inventario/Inventario.tsx:613-616`): la
persona debe restar a mano lo contado menos lo que el sistema dice ANTES de escribir el
número. Es exactamente el paso que Loyverse le ahorra al usuario.

Clasificación: estándar (no es un diferencial de Loyverse, es la forma obvia de resolver un
conteo). Copiable en semanas: sí — es una capa de UI sobre el mismo endpoint de ajuste
(pedir "cantidad contada" en vez de "delta" y que el CLIENTE reste, o mejor, que lo calcule
el servidor a partir de `quantity_before` que el propio kardex ya guarda).

Ver hallazgo de producto relacionado en [[recorrido-2026-09-24-bloque-i]].
