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
     agrega, asigna y quita roles en ella. Desactivar a una persona es desactivar su membresía en la cuenta, así que un gestor acotado solo puede desactivar (o reactivar al volver a agregarla) a quien tiene al menos un rol en su empresa y ninguno en empresas que él no gestiona.
   - Lo que gobierna la cuenta es del **Titular de la cuenta**, el que tiene la asignación a nivel
     de tenant: crear empresas, dar o quitar la titularidad y la facturación de Ladino.
   - Un Dueño invitado no puede quitar ni desactivar al Titular.
   - El Dueño invitado recibe también operación de almacén, igual que el fundador (ADR-0049).
4. **La web enseña solo lo que el servidor permite.** Cada botón se condiciona al mismo permiso que
   exige su endpoint. Un 403 que se escape dice qué falta en palabras de persona; nunca el nombre
   técnico del permiso.
5. **La venta de cada oficio es un test** (E2E «una venta por oficio»).
   `040_named_roles_test.sql:55` pasa a observar una venta real de un cajero. La `:61` no cambia.

6. **El alcance de almacén de la venta** lo decide el permiso de vender. Un rol de venta acotado a
   almacenes (encargado, administrativo) solo vende desde los suyos. Un rol no acotado (cajero, Dueño)
   vende desde cualquier almacén de su empresa. *Decidido por criterio* (2026-09-28, menor sorpresa:
   el dueño vende desde todos sus depósitos). La alternativa era exigir también a los roles no
   acotados un binding por almacén. Antes de este ADR, el dueño recibía 403 al vender desde un
   depósito sin binding, pero por el permiso anidado `inventory.move`, no por una decisión.

7. **Las lecturas también tienen dueño** (ola 3, 2026-10-03; RESPUESTA §2.8 «Lecturas»; N-07,
   P-04, E-12, A-07, C-09). Migración `20261003130000_permissions_that_end_in_green`.
   - Membresías, asignaciones y alcances se leen con `membership.read` (el `members.read` del
     documento del dueño; no se renombra, como `sales.void` en el punto 2). Cada quien ve siempre
     las suyas. Antes las leía por PostgREST cualquier miembro activo, aun sin rol. Quien lee las
     personas de UNA empresa ve las membresías con asignación en esa empresa y las del nivel
     cuenta (operan en todas), no las del tenant entero; todas, solo con `membership.read` de
     nivel cuenta (el Titular). Migración `20261003130200` (revisión, H5).
   - La deuda de cada cliente (`GET /v1/customers?with_debt=1`) exige `ar.read`: el cajero lo
     tiene, para fiar; el almacenista recibe 403. La lista sin deuda no cambia.
   - Las seis tablas con `tenant_id` que dejaban a `ladino_api` con `using (true)` pasan a
     `ladino_service_tenant_ids()`, como las demás; la séptima, `pos_carts`, la alinea la
     migración del POS de la misma ola (`20261003100000`). El invariante «ninguna policy de
     `ladino_api` con `true` en una tabla con `tenant_id`» vale cero y lo miran el pgTAP 101 y
     `pnpm recorrido E`.
   - Nada se escribe en el almacenamiento antes de autorizar: el logo y la foto preguntan el
     permiso (y la foto, que el producto exista) antes de procesar y subir.
   - Las altas de personas, roles y alcances guardan su autor en la fila (O-03): las cinco tablas
     que tenían `created_by` sin `set_row_provenance` lo reciben. Invariante: «toda tabla de
     `public` con `created_by` tiene `set_row_provenance`» = 0 (pgTAP 101, `pnpm recorrido O`).

8. **Separación de funciones** (ola 3, 2026-10-03; RESPUESTA §2.8 «Separación de funciones»;
   J-03, y el terreno de G-20, H-14 y D-11). Lo que el documento del dueño fija: reembolsar,
   confirmar un sobregiro, pagar a un proveedor por encima del umbral y aprobar la cuenta bancaria
   de un proveedor exigen un permiso propio, motivo y rastro; con cuatro ojos, quien registra no
   aprueba; en la bodega de una persona, la aprobación es el permiso más el motivo; el cierre de
   caja solo acepta cajas; ninguna pantalla revela el saldo de una cuenta que el rol no ve.
   - **El cierre de caja** (J-03, cerrado): solo `kind = 'cash'`. Con solo `cash.close` (el
     encargado) se ve la caja que no es de sistema, igual que el listado (ADR-0048): cualquier
     otra cuenta da 404, sin el saldo en el mensaje. Quien sí la ve (`treasury.read`) recibe
     «Solo se cierran cajas», también sin el saldo. La comprobación va antes del cálculo.
   - **Los permisos** `sales.refund`, `treasury.overdraft` y `purchase.payment.approve` existen
     y son del Dueño. `supplier.bank_account.approve` ya existía. *Decidido por criterio*: solo
     el Dueño por ahora. De los tres, `treasury.overdraft` YA se exige (D-11, ola 3: `exigeSaldo`, ADR-0066 nota de la ola 3 §8); `sales.refund` y `purchase.payment.approve` todavía no los exige ningún caso de uso; cada hallazgo que los haga
     cumplir (G-20, D-11, H-14) decide si el administrativo también los recibe. La alternativa era
     dárselos ya al administrativo («aprueba», §2.8), y se descartó porque concede algo que nadie
     comprueba.
   - **Cuatro ojos, por permiso**: `company_settings.four_eyes`. NULL = automático: activo para un
     permiso cuando más de una persona activa TIENE ese permiso en la empresa (la misma resolución
     que el servidor, `ladino_user_has_permission`); true/false = lo que decida el dueño.
     `platform.four_eyes_active(empresa, permiso)` y
     `platform.approval_allowed(empresa, permiso, quien registró, quien aprueba)`: con cuatro ojos,
     quien registró no aprueba. Una bodega con dueño y cajero no tiene cuatro ojos para aprobar un
     pago a proveedor (solo el dueño puede) y sí para vender. *Decidido por criterio* (revisión,
     H4; migración `20261003130200`): contar quién PUEDE aprobar, porque con una sola persona capaz
     exigir «otro» bloquearía el pago. La alternativa era dar los permisos de aprobación también al
     administrativo para que haya dos; la primera versión (130000) contaba personas con cualquier
     rol, y un cajero encendía cuatro ojos que nadie podía cumplir.
   - **El aviso de sobregiro** (`exigeSaldo`) dice el saldo de la cuenta solo si quien opera tiene
     `treasury.read`; si no, dice que no alcanza para lo que saca, sin el saldo (revisión, H6).
   - **El umbral del pago a proveedor**: `company_settings.supplier_payment_approval_threshold`
     y su moneda, **USD 1.000** por omisión. Es una regla interna, no una cifra legal. *Decidido
     por criterio* (§2.16 (3) y (5)): en USD porque el dueño piensa sus precios en USD (ADR-0046);
     mil porque por debajo un negocio pequeño paga a diario sin trámite, y por encima un segundo
     par de ojos es lo que hacen los ERP venezolanos con aprobaciones por monto. La alternativa era
     no tener umbral (todo pago aprobado) o pedirle la cifra al dueño en el registro.
   - Todavía no hay endpoint para cambiar `four_eyes` ni el umbral: añadirlo cambia el contrato de
     la API y queda para el primer hallazgo que los haga cumplir.
   - **El sobregiro en el acto no pasa por los cuatro ojos** (D-11, ola 3, 2026-10-03; ADR-0066
     nota de la ola 3 §8). `treasury.overdraft` + motivo + acta `treasury.overdraft.confirmed`, y
     nada más: el sobregiro se confirma en la misma petición que el egreso, quien registra es
     quien confirma, y `platform.approval_allowed(empresa, X, X)` lo negaría siempre en una
     empresa con más de una persona —no hay aprobación pendiente en la que otra persona apruebe—.
     *Decidido por criterio*; la alternativa es construir esa aprobación pendiente y aplicar la
     regla. El permiso sigue siendo solo del Dueño (la siembra no cambia).

9. **Logos por contenido** (ola 3, 2026-10-03; RESPUESTA §2.15; A-14). La carpeta de cada logo
   es el SHA-256 de lo subido: el mismo archivo es la misma ruta y no crea objetos. El logo es
   **presentación**, no un requisito del art. 13 de la PA 00071: el PDF usa siempre el logo
   VIGENTE y ningún documento congela una versión. Por eso una versión se conserva solo mientras
   es la vigente y durante 30 días desde que **queda huérfana** (el fin de su última ventana en las
   actas `company.logo_set`; una versión que nunca quedó puesta es huérfana desde que nació).
   Después la purga la API tras cada logo nuevo con `platform.company_logo_purgeable`, porque la
   base no puede borrar del almacenamiento. *Decidido por criterio* (revisión, H2 y H3; migración
   `20261003130200`): sin rama «referenciada por documentos», porque no hay documento que
   referencie un logo. La alternativa (a) era congelar el logo al emitir (guardar su ruta en el
   documento y conservar esas versiones para siempre); se descartó porque la norma no lo pide y
   obliga a conservar imágenes sin plazo. Purga en la subida y no job del worker, porque el worker
   no tiene la credencial de Storage; la alternativa queda abierta si las huérfanas se acumulan en
   empresas que no vuelven a cambiar el logo.

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

## Nota de la re-revisión (migración 20261003130300, 2026-10-03)

- **C1 · `platform.four_eyes_active` responde solo por su tenant.** Era `security definer` sin
  guarda: con el id de una empresa ajena, el actor de servicio aprendía su ajuste de cuatro ojos y
  si allí hay más de una persona con un permiso. Ahora lleva la misma guarda que
  `company_logo_purgeable` (`platform.ladino_service_tenant_ids()`). *Decidido por criterio*: para
  una empresa ajena, o sin actor, devuelve TRUE (encendidos) —constante, no revela nada, y falla
  cerrado si alguien la usa en un `if`—. La alternativa era NULL (que en plpgsql cuenta como falso
  y fallaría abierto) o lanzar 42501 (que rompería `approval_allowed` con un error en vez de un
  «no»). pgTAP 101: actor de otro tenant, sin actor, usuario de dos tenants y variante rota.
- **Abierto, sin tocar:** `GET /v1/negocio/resumen` suma lo que deben los clientes
  (`lo_que_me_deben`) y lo que se debe a proveedores (`lo_que_debo`) con solo `treasury.read`,
  sin `ar.read` ni `ap.read`. ADR-0048 fija ese permiso para el resumen y el E2E de tesorería lo
  asevera con un rol que solo tiene `treasury.read`: exigir `ar.read` cambia una decisión y el
  contrato, y la decide el dueño. Los roles de fábrica con `treasury.read` (Dueño, Administrativo)
  tienen los tres; el hueco es de los roles a medida.

- **Cerrado después (misma re-revisión):** el punto «abierto, sin tocar» de arriba se resolvió por
  criterio con la opción (b): el resumen se sigue sirviendo con `treasury.read`, y
  `lo_que_me_deben` / `lo_que_debo` van en `null` sin `ar.read` / `ap.read` (ni se consultan).
  El contrato se amplía a nulo. Detalle y alternativas en ADR-0048, nota de la re-revisión. La
  aserción de `e2e-treasury` que esperaba «0.00» para un rol sin esos permisos pasaba gracias al
  permiso anidado y cambió a `null`.
