# ADR-0067 — La cuenta se pregunta, no se adivina

- **Estado**: aceptada (dueño, 2026-09-18: «me dice método de pago, mas no me dice con qué cuenta
  la pagué, banesco, mercantil, cuenta en dólares, efectivo, usdt, eso no está bien planteado,
  ¿cómo se va a propagar?»)
- **Fecha**: 2026-09-18
- **Módulos**: tesorería · ventas (POS y cobro de documentos) · compras (pagos y llegada) ·
  contabilidad
- **Rigor**: máximo (dinero).
- **HOMOLOGATION_IMPACT**: NO. Ningún documento fiscal cambia, ninguna alícuota, ningún libro.
  Cambia **a qué caja entra y de qué caja sale** el dinero, que es cosa de tesorería y del mayor.

## Contexto

ADR-0062 §1 dejó una escalera para resolver la cuenta cuando el cliente no manda ninguna:

1. la forma de pago configurada para ese instrumento, en la moneda del pago;
2. la cuenta **propia** de la familia del instrumento (efectivo → caja; lo digital → banco o
   billetera), activa, en esa moneda, **la más antigua**;
3. «Sin asignar (moneda)».

La escalera es correcta **como último recurso del servidor**: la API es la API, y la app móvil, un
guion o una integración pueden registrar un pago sin pantalla. El problema no es la escalera: es
que **las pantallas se apoyaron en ella para no preguntar**.

Con una sola cuenta por familia, el peldaño 2 acierta siempre. Con dos, elige «la más antigua», y
eso no es una regla de negocio: es un desempate. Esto es lo que produjo en producción el
2026-09-18, en la empresa «Ladino», que tiene Banesco **y** Banco Mercantil:

| Instrumento | Dónde cayó el dinero |
|---|---|
| `zelle` | Zelle 64 · **Caja USD 41** · Sin asignar 3 |
| `efectivo_usd` | **Zelle 43** · Caja USD 27 |
| `pago_movil` | Banco Mercantil 136 · Sin asignar 6 |
| `transferencia` | Banco Mercantil 122 · Sin asignar 1 |

**Banesco existe, está activa y no ha recibido un solo bolívar.** Efectivo en dólares acabó en la
cuenta de Zelle. Y en «ferretería», «Sin asignar (VES)» acumula 42.646,12 mientras «Caja Bs» está
en −50.000: el dinero está registrado, pero no donde está.

La causa de fondo: **`payment_methods` está vacía en las ocho empresas de producción.** Esa tabla
es justo la que ata «pago móvil» a «Mercantil», y sin ella todo el sistema cae al peldaño 2. Nunca
se empujó a nadie a configurarla porque la aplicación «funcionaba» igual — con la cuenta
equivocada.

Y no todas las pantallas fallan igual. Dos ya lo hacen bien y llevan meses en producción:

| Pantalla | ¿Pregunta la cuenta? |
|---|---|
| Cobrar documento | **Sí** — la cuenta fija de la forma, o las cuentas activas de esa moneda |
| Registrar gasto | **Sí** — `account_id` obligatorio |
| POS (Vender) | No |
| Pagar a un proveedor | No |
| Llegó mercancía | No |

## Decisión

### 1. Ninguna pantalla deja que el servidor adivine cuando hay más de una candidata

La escalera de ADR-0062 §1 **se queda intacta** para la API. Lo que cambia es que una pantalla no
la usa como sustituto de una pregunta. La regla es:

- **una sola cuenta candidata** → no se pregunta. No hay nada que elegir, y preguntar por preguntar
  es ruido;
- **más de una** → **se pregunta, y sin preselección**. Una preselección es la misma adivinanza con
  un sello encima: quien acepta lo que ya venía puesto no ha elegido nada.

«Candidata» significa lo mismo que en el peldaño 2 —cuenta propia, activa, de la familia del
instrumento y de la moneda del pago—, para que la pregunta y el último recurso no puedan
contradecirse.

### 2. El instrumento y la cuenta son DOS hechos, y los dos se guardan

La tentación es sustituir el desplegable de formas por uno de cuentas: «lo pagué por Mercantil» es
como habla la gente. No se hace, porque el instrumento tiene efecto propio y la cuenta no lo
lleva dentro:

- de un mismo Banesco salen un pago móvil, una transferencia y un punto de venta, y en el libro y
  en la conciliación no son lo mismo;
- **lo pagado en divisas es materia de IGTF** (P-29, pendiente del asesor): esa decisión se toma
  sobre el instrumento, no sobre el nombre de la cuenta;
- `payments.instrument` ya alimenta el cierre de caja y el mayor.

Así que la pantalla pregunta las dos cosas. Cuando la forma configurada trae su cuenta, la segunda
pregunta desaparece: para eso se configura.

### 3. En el POS no se pregunta dos veces: se abre el botón

El mostrador se mide en toques. Añadir «¿de qué cuenta?» después de cada forma de pago es
inaceptable donde se cobra con una mano.

En su lugar, **cuando un instrumento base tiene más de una cuenta candidata, el POS enseña un
botón por cuenta** en vez de uno genérico: «Pago móvil · Banesco» y «Pago móvil · Mercantil». Un
toque, igual que hoy, y el botón dice a dónde va el dinero. Con una sola candidata, el botón se
queda como está.

### 4. Lo ya atribuido no se reescribe: se enseña

`platform.money_landing_gaps(p_company)` — **informe, no invariante** (ADR-0066 §8 dejó escrito por
qué la distinción importa). Devuelve los cobros y pagos que:

- cayeron en una cuenta **de sistema** («Sin asignar»), o
- cayeron en una cuenta cuya **familia no corresponde** al instrumento (efectivo en una cuenta de
  banco, o lo digital en una caja física).

Su respuesta correcta **no es cero**: «Sin asignar» es legítima mientras el negocio no tenga una
cuenta de esa familia, y ADR-0062 §3 la puso ahí para repartirla. El informe dice qué hay y cuánto,
y **quien mueve el dinero es una persona**, con la transferencia entre cuentas que ya existe.

No se reescribe ningún `account_id`: un pago es un hecho con su fecha, su autor y su asiento. Un
`UPDATE` masivo sobre dónde cayó el dinero de 500 cobros es exactamente la clase de arreglo que
esta base no admite (regla 2 y ADR-0006).

### 5. La regla de familia vive en el SERVIDOR, y solo ahí

La tentación era copiar `FAMILIA_DE_INSTRUMENTO` a la web y filtrar las cuentas en el navegador.
No se hace: dos copias de una regla son dos reglas, y el día que una cambie la pantalla ofrecerá
candidatas que el servidor no aceptaría —o esconderá las que sí—.

En su lugar, **`GET /v1/treasury/accounts/candidates` devuelve el mapa entero**: por cada
instrumento, sus cuentas en el **mismo orden** en que `resolverCuentaEfectivo` las resolvería, más
`fixed_by_method`. Un solo viaje por empresa, cacheado, y lo usan las cinco pantallas — incluido el
POS, que pinta ocho botones y no va a hacer ocho peticiones para saber a dónde lleva cada uno.

**No devuelve saldos, y es a propósito**: elegir de qué cuenta sale el dinero no es «ver el
dinero», así que el permiso es el de quien REGISTRA el movimiento —la cajera, el encargado— y no
`treasury.read` (ADR-0048). Es la misma frontera que ya se trazó con el catálogo de formas de pago.

En la web queda solo `decidirCuenta()`, que no sabe nada de familias: recibe lo que respondió el
servidor y decide si hay algo que preguntar. La puerta ya se rompió dos veces por armarse su propia
lista (`/v1/warehouses` en ADR-0066 i, y el desplegable de formas vacío el 2026-09-18): la tercera
no sería mala suerte.

## Consecuencias

- Quien tenga dos bancos verá una pregunta más al pagar y un botón más en el POS. Es el precio de
  que el saldo de Banesco signifique algo.
- Quien tenga una cuenta por familia **no nota nada**.
- «Sin asignar» deja de crecer por omisión y pasa a ser lo que ADR-0062 quiso: una excepción
  visible y repartible.
- El informe va a salir con filas el primer día. Eso es lo que se pidió: enseñar, no tapar.
- **VALIDAR-CONTADOR**: el informe no propone asientos ni los corrige; si el contador quiere
  reexpresar dónde cayó el dinero de meses anteriores, es una transferencia entre cuentas con su
  motivo, no una corrección silenciosa.

## Reversibilidad

- **La función del informe** — total (`drop function`): es una lectura.
- **Las pantallas** — reversibles por código; nada se persiste distinto salvo que el `account_id`
  que viaja ahora lo eligió una persona en vez de deducirlo el servidor.
- **La escalera de ADR-0062 §1 no se toca**, así que ningún cliente que no mande cuenta cambia de
  comportamiento.

## Alternativas descartadas

- **Sustituir el desplegable de formas por uno de cuentas.** Más simple de entender y una pregunta
  menos, pero pierde el instrumento, que es el que decide el IGTF y el que distingue un pago móvil
  de una transferencia dentro del mismo banco. Se perdería un dato fiscal para ganar un clic.
- **Preseleccionar la respuesta de la escalera.** Es la adivinanza otra vez, con la firma de quien
  pulsó «Seguir» sin mirar. Si el sistema no sabe, la pantalla no finge que sabe.
- **Obligar a configurar las formas de pago antes de cobrar.** Arreglaría la raíz de una vez, pero
  bloquea a un negocio que solo quiere vender su primer día. Se queda como empujón en «Mi dinero»,
  no como barrera.
- **Reescribir el histórico.** Descartada por el dueño y por la regla 2: un movimiento contable no
  se actualiza, se corrige con otro movimiento.
