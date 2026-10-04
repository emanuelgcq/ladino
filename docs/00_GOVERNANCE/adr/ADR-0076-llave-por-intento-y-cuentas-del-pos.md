# ADR-0076 — La llave es por intento, y la cuenta vendida muere en el servidor

- **Estado:** ADR aplicado según la respuesta del dueño del 2026-09-28 (§2.9). Hallazgos: M-01, M-02, M-03, M-04, D-03, F-03, F-08, E-08 y O-02.
- **Fecha:** 2026-10-02.
- **Impacto fiscal:** indirecto: evita ventas duplicadas o perdidas.
- **Enmienda:** ADR-0018 (idempotencia): cómo se forma la llave del cliente y el code `IDEMPOTENCY_BODY_MISMATCH`.

## Contexto
El recorrido encontró:
- la llave de idempotencia formada con el id de la cuenta, así que un segundo cobro de la misma cuenta devuelve la respuesta del primero (M-01, D-03);
- «ya se registró» ante un cuerpo distinto (F-03, F-08);
- una cuenta ya vendida que se sigue editando o subiendo (M-02, M-03);
- cuentas sin autor que cualquiera cobra o borra (E-08, O-02).

## Decisión
1. **Llave por intento:**
   - un UUID nuevo por intento, nunca el id de la cuenta;
   - la misma llave con otro cuerpo responde `IDEMPOTENCY_BODY_MISMATCH`, en palabras de persona («Esa operación ya se envió con otros datos; vuelve a intentarlo»; si el intento anterior quedó hecho o sigue en curso, el texto lo dice: nota de aplicación, punto 12);
   - tras un 4xx, el cliente estrena llave; tras un fallo de red, la conserva y reintenta;
   - nada se marca «registrado» sin fila;
   - la respuesta guardada de una llave completada solo se devuelve a la misma llave.
2. **La cuenta vendida muere en el servidor:**
   - la venta marca `pos_carts.sold_at` y `sale_id`;
   - todo PUT posterior sobre esa cuenta responde 409 «esa cuenta ya se cobró»;
   - la subida pendiente se cancela o se espera antes de cobrar;
   - el cuerpo de la venta lleva `cart_version` y `attempt_id`, así dos cobros nunca son bytes iguales.
3. **De quién es la cuenta:**
   - tiene autor y caja;
   - se ve con nombre, hora y autor;
   - la cobra o la borra su autor, o quien tenga `pos.carts.manage`; los demás, en solo lectura;
   - al abrir la caja, las cuentas recuperadas de la nube se anuncian («Recuperamos 2 cuentas de ayer: ¿las conservas?»);
   - la venta guarda quién armó la cuenta y quién cobró: el vendedor es quien cobra, y el autor queda en la venta y en la auditoría.

## Consecuencias
- **Positivas:**
  - ningún cobro devuelve la respuesta de otro;
  - ninguna cuenta se vende dos veces;
  - cada cuenta tiene dueño.
- **Negativas:**
  - un cambio de contrato: `cart_version`, `attempt_id` y el code `IDEMPOTENCY_BODY_MISMATCH`;
  - la web vieja hay que desplegarla junto con la API.
- **Para revertir:** las columnas nuevas son aditivas. La llave por intento es del cliente.

## Nota de aplicación (2026-10-02, ola 3)
- **Migración `20261003100000_the_sold_cart_dies_on_the_server`**: `pos_carts.sold_at`, `sale_id`
  (FK a `documents (company_id, id)`) y `station_id`; trigger `pos_carts_02_sold_is_final` (una cuenta
  vendida no se edita ni se borra, LAD06); el permiso `pos.carts.manage`; y las policies de
  `ladino_api` dejan de ser `using (true)` (tenant del actor, ADR-0031). La purga del worker ya no
  alcanza las vendidas.
- **Servidor**: `quickSale` bloquea la cuenta ANTES de numerar: vendida ⇒ 409 `POS_CART_SOLD` con la
  venta en `details`; ajena sin permiso ⇒ 403. Al final la MARCA (o la crea ya vendida si nunca llegó
  a la nube) y escribe el acta `pos.cart.sold` con autor, cajero, `cart_version` y `attempt_id`.
  `vendor_id` = quien cobra. El PUT y el DELETE miran autor y lápida con la fila bloqueada.
- **Middleware**: otro cuerpo con la misma llave ⇒ `IDEMPOTENCY_BODY_MISMATCH`; `IDEMPOTENCY_KEY_REUSED`
  queda para la misma llave en otro endpoint.
- **Web**: `apps/web/src/llave-intento.ts` (estrenar tras 4xx, conservar tras red/5xx/IN_PROGRESS) en el
  cobro del POS, el cobro de documentos, la devolución (crear, confirmar, reembolso) y la llegada de
  mercancía. El POS sube y ESPERA la cuenta antes del POST, no la vuelve a subir tras venderla, suelta la
  que la nube dice cobrada, enseña las ajenas en solo lectura con autor, hora y caja, y anuncia las
  recuperadas al abrir.

**Decidido por criterio (§2.16):**
1. *La caja* es un uuid por equipo guardado en el disco del navegador (`station_id`), porque el POS no usa
   `cash_registers` (vacía, sin API). Alternativa: FK a `cash_registers` cuando el POS las use.
2. *Quién armó, en la venta*: la cuenta vendida se conserva (lápida) con `created_by` y `sale_id`, más el
   acta `pos.cart.sold`. Alternativa descartada: una columna nueva en `documents` (tabla fiscal con
   datos y triggers de inmutabilidad, para un dato que la lápida ya da).
3. *`pos.carts.manage`*: dueño y administrativo (migración `20261003100100` se lo quita al encargado:
   §2.8, el encargado no vende, y la aserción de HEAD `040_named_roles_test.sql:158` — el encargado
   tiene 15 — sigue sin tocarse). Ni cajero, ni contador, ni almacén. Alternativa: dárselo al encargado
   (como pedía el encargo) y cambiar esa aserción con aprobación del dueño.
4. *`cart_version`* es el contador de ediciones de la caja y queda como constancia en el acta; no es un
   candado optimista. Alternativa: rechazar el cobro si la nube tiene una edición más nueva — añadía un
   fallo nuevo en el mostrador por un conflicto que la regla del autor ya evita.
5. *`attempt_id`* es la misma llave del intento: misma llave ⇒ mismo cuerpo (el replay sigue
   funcionando); llave nueva ⇒ bytes distintos.
6. *`IDEMPOTENCY_IN_PROGRESS`* (409) NO estrena llave: el intento original sigue corriendo.
7. *M-04*: no hay texto que cambiar en «revisa y repite» porque ese camino ya no existe: la llave nunca
   es fija, y la cuenta cobrada responde «ya se cobró … ábrele una cuenta nueva» y la caja la suelta.
8. *Las ajenas recuperadas* que se «quitan» al abrir la caja solo dejan de verse en ese equipo; la nube
   las conserva para su autor.
9. *El intento anterior pudo quedar hecho* (revisión, regla 4: nunca duplicar dinero): el
   `IDEMPOTENCY_BODY_MISMATCH` lleva `details.previous_status` (`completed` / `in_progress` / `failed`).
   Con `completed` o `in_progress` la web NO estrena llave: enseña el aviso (`RevisaIntentoAnterior`,
   con el texto del servidor: punto 12) y ofrece ir a verlo. Con `failed` estrena. «Tras un 4xx se
   estrena llave» (§2.9) no puede leerse como reenviar una operación hecha. Alternativa: estrenar
   siempre. Los sitios, que son TODOS los llamadores de `conLlaveDeIntento` (familia F9: quien use
   la llave por intento pinta el aviso; sin él la pantalla cae en un error genérico y reintentar da
   `IDEMPOTENCY_BODY_MISMATCH` durante 24 h):
   - POS (`Vender.tsx`) → «Ver las ventas»;
   - cobro de un documento (`CobrarDocumento.tsx`) → «Cerrar y revisar los cobros»;
   - llegada de mercancía (`LlegoMercancia.tsx`) → «Ver las compras»;
   - devolución —crear, confirmar y reembolso, incluido el reembolso que confirma el sobregiro—
     (`DetalleFactura.tsx`, diálogo `Devolucion`) → «Cerrar y revisar la factura»: cierra el diálogo
     y vuelve a leer el documento (re-revisión, A3: antes caía en el error genérico).
10. *«Armó la cuenta»* en el detalle de la venta: el GET `/v1/documents/:id` devuelve `pos_cart`
   (autor de la lápida por `sale_id`) y DetalleFactura lo enseña. Sin tocar la tabla fiscal
   `documents`. La reversión de 20261003100000 ya NO borra las lápidas (COMMENT en `pos_carts`,
   migración 20261003100100). Alternativa: una columna en `documents`.
11. *La doble venta de una cuenta nunca subida* (revisión [1]): `quickSale` autoriza primero, toma
   `pg_advisory_xact_lock(hashtextextended('pos_cart:'||cart_id, 0))` antes de leer la cuenta (antes de
   los candados de clase, talonario y kardex), y si al marcar la lápida no afecta ninguna fila RELEE la
   cuenta y devuelve el `err` del dominio (`cuentaVendida`: 409 `POS_CART_SOLD` con la venta que sí la
   cerró en `details`). `withTransaction` revierte ante cualquier `err`
   (`packages/db/src/transaction.ts`): el rollback se lleva la factura recién emitida y libera el
   número. *Corrección de la re-revisión (A1):* este punto decía que hacía falta LANZAR un SQLSTATE
   `LAD76` porque «un `return err` la habría dejado escrita». Era falso —`withTransaction`
   convierte todo `err` en rollback— y el lanzamiento era además SQL inválido (`do $ … $` no es un dollar-quote: 42601 → 500).
   `LAD76` no lo lanza nadie y salió de `errors.ts` y de ERROR_CATALOG. Medido con el candado quitado
   en local: antes `[201, 500]`; ahora `[201, 409]` con `details.sale_id` de la ganadora, y un solo
   documento.
12. *El texto de `IDEMPOTENCY_BODY_MISMATCH` lo elige el servidor por `previous_status`*
   (re-revisión, A4): «vuelve a intentarlo» con el intento anterior `completed` invitaba a hacer justo
   lo que el punto 9 dice no hacer. `completed`: «Esa operación ya quedó registrada antes con otros
   datos. Revísala antes de repetirla.» · `in_progress`: «Esa operación todavía se está registrando.
   Espera un momento y revisa si quedó.» · `failed` u otro: el de siempre («Esa operación ya se envió
   con otros datos; vuelve a intentarlo.»). La web enseña ese texto en el aviso y no tiene uno propio
   (el suyo queda de reserva si el servidor no manda `person_message`). Alternativa: un solo texto
   para los tres estados.

**Aserciones de HEAD cambiadas** (pasaban gracias al defecto o decían el code que el dueño reemplazó):
`apps/api/test/e2e-sales.test.ts` (la venta borraba la fila: `toHaveLength(0)` → la fila existe vendida
con `sale_id`), y `IDEMPOTENCY_KEY_REUSED` → `IDEMPOTENCY_BODY_MISMATCH` en `idempotency.test.ts`,
`e2e-create-company.test.ts`, `e2e-llegada.test.ts` y `e2e-product-import-jobs.test.ts`.

## Verificación
- E2E: dos cobros de la misma cuenta con llaves distintas dan una venta y un 409; misma llave con otro cuerpo da `IDEMPOTENCY_BODY_MISMATCH`; el PUT de una cuenta vendida da 409; una cuenta de otro autor es de solo lectura.
- `pnpm recorrido M`, `D`, `F`, `E` y `O`.
