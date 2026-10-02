# ADR-0076 — La llave es por intento, y la cuenta vendida muere en el servidor

- **Estado:** ADR aplicado según la respuesta del dueño del 2026-09-28 (§2.9). Hallazgos: M-01, M-02, M-03, M-04, D-03, F-03, F-08, E-08 y O-02.
- **Fecha:** 2026-10-02.
- **Impacto fiscal:** indirecto: evita ventas duplicadas o perdidas.
- **Enmienda:** ADR-0005 (idempotencia) en cómo se forma la llave del cliente.

## Contexto
El recorrido encontró:
- la llave de idempotencia formada con el id de la cuenta, así que un segundo cobro de la misma cuenta devuelve la respuesta del primero (M-01, D-03);
- «ya se registró» ante un cuerpo distinto (F-03, F-08);
- una cuenta ya vendida que se sigue editando o subiendo (M-02, M-03);
- cuentas sin autor que cualquiera cobra o borra (E-08, O-02).

## Decisión
1. **Llave por intento:**
   - un UUID nuevo por intento, nunca el id de la cuenta;
   - la misma llave con otro cuerpo responde `IDEMPOTENCY_BODY_MISMATCH`, en palabras de persona («Esa operación ya se envió con otros datos; vuelve a intentarlo»);
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

## Verificación
- E2E: dos cobros de la misma cuenta con llaves distintas dan una venta y un 409; misma llave con otro cuerpo da `IDEMPOTENCY_BODY_MISMATCH`; el PUT de una cuenta vendida da 409; una cuenta de otro autor es de solo lectura.
- `pnpm recorrido M`, `D`, `F`, `E` y `O`.
