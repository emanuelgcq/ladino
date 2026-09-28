# ADR-0068 — El paso interior lo autoriza la operación que lo contiene

- **Estado:** ADR aplicado según la respuesta del dueño del 2026-09-28 (listado en el mensaje de apertura de la ola 1; §2.8 y N-01/N-02/N-04)
- **Fecha:** 2026-09-28
- **Impacto fiscal:** NO. No cambia ningún documento ni libro: cambia quién puede producirlos.
- **Hallazgos:** N-01, N-02, N-04 (G-08), B-16, C-08, K-11.

## Contexto

El recorrido encontró que **ningún cajero ha podido vender mercancía nunca** (N-01). La venta pide
`sales.invoice.issue` y, dentro, descuenta el kardex con `issueStockBatch`, que vuelve a autorizar
con **su** permiso, `inventory.move`, que el cajero no tiene. La misma forma se repite:

- **Anular** (`sales.invoice.annul`) revierte el asiento con `reverseJournalEntry`, que pide
  `accounting.entry.reverse`, y el administrativo no lo tiene (N-04).
- **El alta simple** (`product.manage`) pone el precio con `setPrice`, que pide `price_list.manage`,
  y el encargado no lo tiene (B-16, C-08).

Solo el fundador tiene todos los permisos, y todos los E2E venden con el fundador: el defecto nunca
se vio fallar. El test del rol (`040_named_roles_test.sql:55`) asevera «el cajero vende» mirando la
lista de permisos, no una venta.

El Dueño invitado a otra empresa (N-02) es la misma familia vista desde las personas. Su rol nace
acotado a la empresa, y la gestión de personas exige una asignación a nivel de tenant
(`members.ts`, `nivelTenant`). La web decide con `ladino_user_has_permission`, que sí acepta la de
empresa: le enseña «Usuarios y roles» y el servidor se lo niega.

## Opciones consideradas

1. **Dar a cada rol los permisos interiores** (`inventory.move` al cajero, `accounting.entry.reverse`
   al administrativo, `price_list.manage` al encargado). A favor: cero código. En contra: el cajero
   podría mover mercancía por la ruta suelta, que es justo lo que su rol no debe hacer. Además,
   cambia la aserción de `040_named_roles_test.sql:61`, que es correcta.
2. **El paso interior lo autoriza la operación que lo contiene.** Hay precedentes: la reposición al
   anular (ADR-0061 §2, `inventory.ts:457-459`) y la revalorización desde la factura del proveedor
   (`revalorizar`). A favor: cada permiso dice lo que la persona hace, no cómo está construido el
   código. En contra: cada caso de uso compuesto debe declarar qué pasos autoriza.

## Decisión

Se elige la opción 2.

1. **Toda función de dominio que hace un paso de otro módulo tiene dos entradas.** La pública
   autoriza con su permiso propio, para la ruta suelta. La interna recibe un contexto ya
   autorizado y la usa el caso de uso que contiene el paso:
   - la **venta** autoriza la salida de kardex, con `sales.invoice.issue` y el alcance del almacén
     sobre ese mismo permiso;
   - la **devolución** autoriza el reingreso, con el permiso de devolución;
   - la **anulación** autoriza la reversa del asiento, con `sales.invoice.annul`;
   - el **alta simple** autoriza el precio, con `product.manage`.
2. El permiso existente `sales.invoice.annul` es el «permiso para anular» del documento del dueño
   (`sales.void`). No se renombra: un renombre no cierra ningún hallazgo.
3. **Los roles son por empresa** (N-02).
   - Quien tiene `membership.manage` sobre una empresa gestiona a las personas de ESA empresa:
     agrega, asigna y quita roles en ella, y la «desactivación» se hace en esa empresa.
   - Lo que gobierna la cuenta es del **Titular de la cuenta**, el que tiene la asignación a nivel
     de tenant: crear empresas, dar o quitar la titularidad y la facturación de Ladino.
   - Un Dueño invitado no puede quitar ni desactivar al Titular.
   - El Dueño invitado recibe también operación de almacén, igual que el fundador (ADR-0049).
4. **La web enseña solo lo que el servidor permite.** Cada botón se condiciona al mismo permiso que
   exige su endpoint. Un 403 que se escape dice qué falta en palabras de persona; nunca el nombre
   técnico del permiso.
5. **La venta de cada oficio es un test** (E2E «una venta por oficio»).
   `040_named_roles_test.sql:55` pasa a observar una venta real de un cajero. La `:61` no cambia.

## Consecuencias

- **Positivas.** El cajero vende; el administrativo anula; el encargado da de alta con precio; el
  Dueño invitado gobierna su empresa. Los permisos vuelven a describir oficios.
- **Negativas.**
  - Cada caso de uso compuesto nuevo tiene que acordarse de usar la entrada interna. Si usa la
    pública, el defecto vuelve. El test por oficio es la red.
  - Una operación compuesta concede el paso interior sin mirar el permiso interior. Por ejemplo, un
    rol que vende saca mercancía aunque no tenga `inventory.move`. Es exactamente lo que se busca,
    y queda escrito aquí.
- **Para revertir:** volver a la entrada pública en los cuatro casos. Nada de datos cambia.

## Verificación

- El E2E «una venta por oficio» en verde con cajero, encargado, administrativo y Dueño invitado.
- `pnpm recorrido N`: N-01, N-02 y N-04 dejan de reproducir.
