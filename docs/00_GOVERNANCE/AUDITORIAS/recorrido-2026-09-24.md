Bloques cerrados: A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P y Z · Recorrido terminado el 2026-09-28 · El informe final está al principio · El estado de los arreglos (respuesta del dueño) está al final, en «Estado»

# Recorrido de Ladino de la A a la Z — 2026-09-24

Ladino usado de punta a punta como lo usarían personas reales, pantalla por pantalla, y cada
diferencia entre lo que una pantalla **promete** y lo que **hace**, documentada. Nada se arregla en
este recorrido: se encuentra, se prueba que existe y se documenta. Arreglar viene después, con
`/arreglar` y este informe en la mano.

**Entorno:** local completo — web en 5174, API en 3000, Supabase local — con la base limpia al
empezar. Nada toca el remoto. Guiones en `scripts/recorrido/`; evidencia cruda (captura, texto, red
y consola de cada pantalla) en `.recorrido/2026-09-24/<bloque>/`, fuera de git; capturas de los
hallazgos en `docs/08_UX/capturas-recorrido/<bloque>/`.

**Equipo:** la sesión principal conduce con Playwright; por bloque, `estratega-producto` (PROMESA,
TEXTO, ESTADOS, TECLADO, FORMA), `auditor-codigo` (DATOS, DINERO, CONTABILIDAD, ROLES, TIEMPO) y,
en A, B, E, G, H, L y M, `auditor-fiscal` (MODO, DOCUMENTOS); `validador` al cerrar cada bloque.

> **Nota sobre los agentes.** Al preparar el equipo, la app de escritorio tenía congelada la lista de
> agentes de cuando se abrió la sesión, y la revisión del propio equipo la hicieron suplentes
> genéricos que leían su definición y abrían su informe con `ROL: <agente>`. Al retomar la sesión
> la lista se recargó: **el recorrido lo hacen los agentes reales, invocados por su nombre**, y el
> hook `SubagentStop` valida el formato de cada informe contra su definición.

## Formato de cada hallazgo

```
ID · bloque · severidad (crítica|alta|media|baja) · empresa · rol
PANTALLA: ruta
DIMENSIÓN: cuál de las doce
PROMETE: qué dice el texto, la spec o el ADR (archivo:línea)
HACE: qué pasó de verdad
EVIDENCIA: captura, consulta a la base, valor del invariante
REPRODUCIR: pasos exactos, con los datos del escenario
¿SE NOTA?: la persona lo ve | termina en verde
¿NECESITA DECISIÓN DEL DUEÑO?: sí (cuál) | no
```

---

## Informe final

### Resumen ejecutivo

**Qué se hizo.**
- 16 bloques (A-P) y el cierre Z, del 24 al 28 de septiembre de 2026, sobre el entorno local, sin tocar el remoto.
- Cuatro empresas: E1, una bodega sin RIF que en M pasa a facturar y se convierte en E4; E2, un distribuidor ordinario con dos depósitos; E3, una ferretería contribuyente especial.
- Seis oficios: dueño, cajero, encargado, administrativo, contador y almacenista.
- Doce dimensiones.

**El resultado.** 235 hallazgos:

| Severidad | Total | Terminan en verde | Necesitan decisión del dueño |
|---|---|---|---|
| Crítica | 13 | 7 | 10 |
| Alta | 67 | 26 | 41 |
| Media | 94 | 21 | 54 |
| Baja | 61 | 4 | 7 |
| **Total** | **235** | **58** | **112** |

- 39 hallazgos llevan SOSPECHA en el título: están razonados sobre el código, sin reproducir.
- Las marcas para el asesor: VALIDAR-TRIBUTARIO en 23 hallazgos, VALIDAR-SENIAT en 20 y VALIDAR-CONTABLE en 13.

**Lo primero que hay que saber: lo que termina en verde.** Son hallazgos en los que la pantalla dice que todo salió bien y el dato queda mal. Nadie los va a reportar, porque nadie los ve:
- **L-01:** el libro de ventas y el CSV que se entrega al contador **suman** las notas de crédito. El débito fiscal sale inflado en 14.081,56 Bs en E2 y en 1.691,84 Bs en E3. La declaración sí resta, así que libro y declaración no coinciden.
- **G-01:** Ladino acepta un rango de notas de crédito que pisa el de facturas. Dos documentos fiscales quedan con el mismo número de control.
- **E-02, E-03, A-03:** un contribuyente especial cobra en divisas sin percibir IGTF si no lo declaró, y nada lo pregunta. Cuando lo percibe, la factura no lo imprime.
- **H-01:** un contribuyente especial nunca retiene IVA desde la web, aunque tenga la regla cargada.
- **E-01:** con el talonario en serie B, la única salida es declarar un rango que no existe en el papel.
- **C-01:** la importación lee «0.500» como 500. Los invariantes no lo ven, porque el kardex inflado y su asiento suben juntos.
- **M-05:** el RIF de una persona natural se imprime como una cédula de nueve cifras en el PDF de la factura.
- **M-02 (SOSPECHA):** una cuenta del POS que vuelve de la nube, cobrada igual que la primera vez, devuelve la venta vieja como si fuera nueva. El efectivo entra y la venta no existe.
- **Dinero:**
  - F-02: una factura pagada vuelve a deber cuando el BCV publica tarde.
  - F-05: el IGTF «además» registra más dinero del que entró.
  - J-02: cerrar una caja en sobregiro convierte en ganancia el dinero que la dueña puso de su bolsillo.
  - G-05 y G-06: la devolución deja el saldo fijo en bolívares y el IGTF «percibido».
  - D-05, D-06, D-07 y H-02: la llegada de mercancía y el diferencial cambiario.
- **Permisos:**
  - J-03: el cierre de caja acepta el banco y revela su saldo.
  - N-07: cualquier miembro lee las membresías del negocio.
  - P-04: cualquier miembro, hasta el almacenista, recibe lo que debe cada cliente.
  - O-03: las altas de personas no guardan autor en su fila.
- **Tests que pasan gracias al defecto:**
  - K-01: el único test de reapertura de período.
  - I-02: los cuatro tests de «Salida».
  - L-02: nadie corre la conciliación con una nota de crédito.
  - N-01: `040_named_roles_test.sql:55` asevera «el cajero vende» mirando la lista de permisos, no una venta.

**Lo que la persona ve y no puede hacer.** Aquí el error es visible, pero no tiene salida:
- **N-01, el hallazgo más grave del recorrido:** el cajero no puede vender ningún producto con existencia, ni de contado ni fiado, y **nunca ha podido**. El rol nació así el 2026-09-04. En producción, toda empresa que haya agregado un cajero tiene una caja que no le sirve. No se miró la base remota (R6).
- **D-01:** una bodega sin RIF no puede registrar ninguna compra.
- **J-01:** «Mover plata» entre dos cuentas de la misma moneda da siempre un error del servidor.
- **K-01:** un período cerrado no se puede reabrir.
- **I-01:** ninguna salida de inventario (merma, consumo, vencido) se registra desde la web.
- **F-01:** la retención no entra si la tasa cambió desde la factura.
- **M-01:** la primera factura de la bodega da 409 por una cuenta que resucitó.
- **H-03:** la nota de crédito de un proveedor es imposible desde la web.
- **D-02:** una factura en dólares no se puede pagar en bolívares.
- **G-07:** el cajero no tiene ningún camino para una devolución.
- **N-02:** el «Dueño» invitado a otra empresa no puede gestionar a nadie ni vender mercancía.

**Lo que está bien, y es mucho.**
- **Los invariantes cruzados dieron 0 en las tres empresas al cierre de los 16 bloques:** stock contra kardex, mayor contra asientos, cobertura contable de ventas, compras e inventario, anuladas netas, inventario contra mayor, comprobación y tesorería.
- **Las cifras del Inicio cuadran con la base hasta el último decimal** (P).
- **Nada se mezcla entre empresas** (O): 16 comprobaciones cruzadas dan 0, y la cabecera, el cuerpo y las FK compuestas cierran el paso.
- **Desactivar a una persona corta su acceso en la siguiente petición**, sin esperar a que caduque el token.
- **Ninguna anulación ni error dejó nada a medias.**

El núcleo contable es sólido. Lo que falla está en los bordes: los permisos de los oficios que no son el fundador, los documentos fiscales, los caminos que el servidor tiene y la web no alcanza, y la presentación.

**La lección del recorrido.** Los invariantes estuvieron en 0 mientras había 13 hallazgos críticos, porque miran que el dinero cuadre, no que la persona pueda trabajar ni que el papel fiscal diga la verdad. Tres familias de test no existen, y son las que habrían visto casi todo lo crítico:
- **una venta hecha por cada oficio**, no por el fundador (N-01, N-02, N-04, B-16, G-08);
- **cada documento fiscal leído como lo lee el SENIAT**: número de control, serie, IGTF y RIF (G-01, E-01, E-03, M-05);
- **la conciliación libro-mayor como invariante del gate**, que hoy solo corre el guion del recorrido (L-01, L-02).

### Matriz pantalla × dimensión

Cada celda da la peor severidad (X crítica · A alta · M media · b baja) y el número de hallazgos. «·» quiere decir sin hallazgo, porque está bien o porque no aplica. «—» es MODO o DOCUMENTOS en un bloque sin auditor fiscal y sin hallazgo de otro agente: nadie lo miró.

| Pantalla | Prom | Texto | Estad | Tecl | Forma | Datos | Dinero | Contab | Roles | Tiempo | Modo | Docs |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| A · Registro y empresa (/registro) | A7 | b1 | A1 | M2 | · | b2 | · | b1 | M1 | b2 | A4 | A6 |
| B · Primer día (/empezar) | A2 | M3 | M2 | b1 | b1 | A4 | b4 | M2 | b2 | · | M3 | A3 |
| C · Productos y precios (/productos, /admin/productos) | A5 | M1 | A1 | · | M1 | A5 | X1 | · | M2 | A2 | — | — |
| D · Llegó mercancía (/admin/llego-mercancia) | X5 | A3 | A2 | M2 | M1 | M2 | A5 | A2 | M1 | A1 | X2 | — |
| E · Vender (/vender) | A6 | M3 | X4 | b1 | · | X5 | X6 | X2 | A3 | b1 | X3 | X7 |
| F · Cobros y deudas (/admin/cuentas, /clientes) | A3 | X6 | A4 | · | A2 | · | X6 | X4 | M1 | A2 | — | — |
| G · Corregir una venta (/admin/ventas/:id) | A3 | M4 | M1 | · | · | X2 | A6 | A2 | A3 | · | A3 | X6 |
| H · Compras y gastos (/compras, /admin/compras) | X4 | A2 | A3 | M1 | A1 | M1 | A2 | X2 | M2 | M1 | X2 | A3 |
| I · Inventario (/inventario, /admin/inventario) | A3 | M3 | M2 | A1 | · | A5 | · | b1 | M1 | · | — | — |
| J · Mi dinero (/dinero) | X1 | A1 | X2 | · | · | A1 | X2 | A2 | A1 | · | — | — |
| K · Contabilidad (/admin/contabilidad) | X2 | M3 | M3 | · | b1 | M1 | M1 | X5 | M2 | M1 | A1 | — |
| L · Libros y declaraciones (/admin/libros, /admin/declaraciones) | M1 | M4 | M2 | · | · | A1 | X2 | · | · | · | A3 | X5 |
| M · De recibos a facturas (/empezar paso 4, Configuración) | A1 | A3 | X3 | M1 | M1 | X3 | A1 | · | · | · | M4 | A1 |
| N · Usuarios y roles (Configuración) | X4 | A3 | A5 | · | · | M2 | · | · | X5 | b1 | — | — |
| O · Varias empresas (cambiar de empresa) | · | b2 | A1 | · | M2 | A4 | · | · | · | · | — | — |
| P · Inicio, reportes y búsqueda (/, /admin/reportes, Ctrl+K) | M3 | M3 | · | · | A2 | M2 | A3 | M1 | M1 | b1 | — | — |

Así se lee:
- **DINERO, DATOS y PROMESA** concentran lo crítico.
- **E (Vender)** tiene una X en seis de las doce dimensiones.
- **N (Usuarios y roles)** tiene X en PROMESA y en ROLES: la misma raíz, N-01.
- **TECLADO y FORMA** son la zona más sana.

### Raíces comunes

Muchos hallazgos son la misma causa vista desde pantallas distintas. Arreglar la raíz cierra la familia:

| Raíz | Hallazgos | Qué la arregla |
|---|---|---|
| **Permiso anidado:** un caso de uso compuesto llama a otro que vuelve a autorizar con su propio permiso, y solo el fundador los tiene todos | N-01, N-02, N-04 (G-08), B-16 | que el paso interior lo autorice el permiso de la operación que lo contiene (precedente: ADR-0061 §2), y un E2E por oficio |
| **Llave de idempotencia fija para cuerpos distintos** | D-03, F-03, F-08, M-01, M-02, M-03, M-04 | una llave por intento, o la cuenta vendida marcada en el servidor |
| **El contribuyente especial** (IGTF y retenciones) | A-03, E-02, E-03, F-05, G-06, H-01, H-04, L-03, L-04 | el camino del especial de punta a punta, con el asesor |
| **Numeración y contenido del documento fiscal** | B-03, E-01, E-04, G-01, G-02, A-06, G-03, M-05 | reglas de rango en la base, y el PDF contra la PA 00071 art. 13 |
| **Decimales del funcional** | K-08, E-05, P-01, P-03, L-05 | redondear al servir (ya lo dice ADR-0063) y decidir la regla del céntimo para los egresos |
| **Moneda y diferencial** | D-02, D-07, H-02, F-01, F-02, G-05, H-06 | el pago cruzado y el diferencial al pagar |
| **Cuentas del POS compartidas** | E-08, M-01, M-03, O-02 | decidir de quién es una cuenta, y enseñarlo |
| **Formato del documento de identidad** | A-08, M-05, O-04, P-02 | una sola función, y el dato normalizado al guardar |
| **Tests que pasan gracias al defecto** | K-01, I-02, L-02, H-03, N-01 (040:55) | el test que observa la conducta, no la superficie (CLAUDE.md §3) |
| **Períodos y fechas** | K-01, K-02, K-03, K-04, D-08, D-09, P-09 | el ciclo cierre-reapertura-cierre, y la granularidad declarada |
| **La empresa activa** | O-01, N-02, A-13 | la empresa por pestaña, y el dueño invitado |

### Promesas rotas

Son los hallazgos de la dimensión PROMESA: lo que una pantalla, una spec o un ADR dicen y el producto no hace.

50 hallazgos tienen la dimensión PROMESA. Van de más a menos grave:

- **D-01** (crítica) · una bodega sin RIF no puede registrar ninguna compra a un proveedor
- **H-01** (crítica) · un contribuyente especial nunca retiene IVA desde la web, aunque tenga la regla cargada, y nada lo dice
- **J-01** (crítica) · «Mover plata» entre dos cuentas de la misma moneda falla siempre con un error del servidor
- **K-01** (crítica) · ningún período cerrado se puede reabrir, y el único test de reapertura está en verde gracias al defecto
- **N-01** (crítica) · el cajero no puede vender ningún producto con existencia, ni de contado ni fiado, y nunca ha podido
- **A-01** (alta) · el registro pierde el logo en silencio, después de enseñarlo puesto
- **A-02** (alta) · «Facturas legales desde el primer día», y el alta con RIF no deja cómo facturar
- **A-04** (alta) · «Contabilidad y Libros fiscales aparecen solos cuando tienen datos», y aparecen el primer día
- **B-01** (alta) · «también se puede vender describiendo la venta»: no se puede
- **C-02** (alta) · después del primer día, dar de alta un producto son cuatro pantallas
- **D-02** (alta) · pagar en bolívares una factura en dólares es imposible, y la pantalla lo propone
- **D-04** (alta) · «Cédula o RIF: puede quedar vacío», y sin RIF el proveedor no se guarda
- **D-05** (alta) · la llegada suma el IVA a lo que la persona escribe, y en ningún momento enseña un importe
- **D-06** (alta) · «Ya llegó la factura» no deja poner el precio de la factura: la revalorización que promete el código no se alcanza
- **E-06** (alta) · no hay «compartir» ni WhatsApp de la factura o el recibo, y la documentación de cumplimiento lo da por construido
- **E-07** (alta) · la tarjeta del producto enseña el precio del mostrador y el carrito cobra el del cliente
- **F-04** (alta) · la misma deuda enseña cuatro cifras distintas, y una sale por WhatsApp al cliente
- **F-05** (alta) · en la ficha, el IGTF se cobra «además» de lo que el cliente pagó, y la cuenta registra más dinero del que entró
- **G-04** (alta) · el estado de cuenta enseña la nota de crédito con saldo positivo, como si el cliente la debiera
- **G-07** (alta) · el cajero no tiene ningún camino para una devolución
- **H-07** (alta) · «Se paga todos los meses: para recordártelo cuando toque», y no hay recordatorio
- **I-01** (alta) · ninguna «Salida» de inventario (merma, consumo, regalo, vencido) se puede registrar desde la web
- **I-04** (alta) · las recetas existen en pantalla y son inalcanzables: ningún producto puede volverse compuesto
- **M-06** (alta) · la banda «Con tu RIF puedes facturar →» lleva al paso 1 de 4, «Tus productos», no al de facturas
- **N-02** (alta) · el «Dueño» que se agrega a otra empresa no es dueño: no ve a las personas, no puede vender mercancía, y la web le ofrece lo que el servidor le niega
- **N-03** (alta) · a quien le quitan el rol o lo desactivan, Ladino le propone fundar un negocio
- **A-09** (media) · elegir el rubro avanza solo; elegir «¿tienes RIF?» no
- **A-10** (media) · «Sin documentos emitidos, el cambio es directo» se muestra siempre, y nada recuerda actualizar el RIF ante el SENIAT
- **A-12** (media) · «Te toma menos de dos minutos», para 8 pantallas o para 11
- **A-13** (media) · no hay forma, desde dentro de Ladino, de abrir una segunda empresa
- **B-09** (media) · la tasa: «Un toque al día» y «Se actualiza sola» en la misma pantalla
- **C-06** (media) · «vender al mayor» no tiene interruptor, y activarlo no cambia la caja
- **C-07** (media) · ningún producto puede llevar lote ni vencimiento: la parte de la llegada que los pide no se enciende nunca
- **C-10** (media) · la foto del producto no se puede arrastrar
- **C-11** (media) · el historial de precios enseña en Bs la conversión de HOY, también para los precios viejos
- **E-13** (media) · la caja nunca vende sin existencia, y el ajuste de empresa que diría lo contrario está muerto
- **E-14** (media) · la lista preferida del cliente solo se elige al crearlo en /admin/clientes; la caja crea las J como «ordinario» sin preguntar
- **E-15** (media) · con documentos emitidos, «Cambiar el RIF» sigue diciendo «Sin documentos emitidos, el cambio es directo» y manda a «crear otra empresa», cosa que no se puede
- **F-13** (media) · no hay dónde ver quién me debe: «Cuentas por cobrar» pide elegir un cliente, y «Ver quién me debe» lleva a la lista entera de clientes
- **G-15** (media) · un saldo a favor que ya existe no se puede devolver en dinero
- **H-10** (media) · «Lo que debo → Ver qué debo» lleva a los gastos, no a lo que se debe
- **H-11** (media) · «Cuentas por pagar» no enseña nada hasta elegir un proveedor
- **I-07** (media) · «¿contaste mercancía?» lleva a un ajuste que pide la diferencia calculada a mano
- **K-09** (media) · quien se registra para que lo agreguen a un negocio ajeno cae en «Vamos a montar tu negocio»
- **L-10** (media) · el selector de formatos del libro de ventas ofrece el TXT de retenciones
- **N-08** (media) · no hay invitación: la persona tiene que registrarse antes, y si lo hace le proponen fundar un negocio
- **P-05** (media) · «Te deben… Un mensaje a tiempo cobra la mitad» lleva a una lista que no se puede ordenar por deuda
- **P-06** (media) · Ctrl+K no encuentra un documento por su número ni una acción como «cierre»
- **P-07** (media) · «Reportes» es una sola cifra, el diferencial cambiario, y tres enlaces
- **E-22** (baja) · el recibo de una venta fiada parece un recibo pagado

### Tiempos

| Bloque | Peticiones | Más de 3 s | La más lenta |
|---|---|---|---|
| A | — | una | la primera subida de logo tras arrancar la API, ~8,5 s (A-19) |
| B | 224 | 0 | — |
| C | 628 | 0 | importar, 2,2 s. Una importación grande agota el tiempo del cliente (C-04) |
| D | 293 | 0 | la llegada, 0,58 s |
| E | 955 | 0 | `POST /v1/pos/sales`, 2,05 s |
| F | 200 | 0 | `POST /v1/fiscal-declarations/supported-retentions`, 0,62 s |
| G | 372 | 0 | 0,5 s |
| H | 206 | **una** | `POST /v1/expenses`, 3,86 s (H-15) |
| I | 201 | 0 | `POST /v1/inventory/issues`, 0,78 s |
| J | 124 | 0 | `GET /v1/negocio/resumen`, 0,45 s |
| K | 196 | 0 | 1,69 s |
| L | 152 | 0 | 0,43 s |
| M | 181 | 0 | `POST /v1/pos/sales`, 0,48 s |
| N | 510 | 0 | `GET /v1/treasury/accounts`, 0,68 s |
| O | 141 | 0 | `POST /v1/pos/sales`, 0,54 s |
| P | 240 | 0 | `GET /v1/products?search=Cemen`, 0,88 s |

Salvo el primer logo, la importación grande y un gasto, **ninguna operación pasó de 3 s**. La venta, con dos segundos en E, es la operación que más sube. Sigue vigente lo medido en la sesión anterior: dentro de una transacción no hay pipelining, y solo quitar sentencias baja la latencia.

Dos cosas crecerán con los datos:
- `/v1/negocio/resumen` llama a `document_debt_today` una vez por documento abierto (P);
- cada aterrizaje de un rol sin permisos amplios pide 3 a 5 datos que recibe con 403 (N-11).

### Lo que no se probó, lo que se creó por la API y lo que no está construido

**No se probó:**
- **El paso del tiempo:** los tramos de antigüedad de 31 a 90+ días y el encadenamiento de dos meses de IVA con datos. La empresa nace el 24/09, y el régimen no deja fechar documentos antes de su vigencia (F, L).
- **El PDF real de una factura de E1:** nunca hubo una, por M-01. Lo que se dice sale de leer la función que lo arma (M).
- **El reembolso con saldo a favor aplicado desde un pago de más** (F-10), y el eco de M-02, que se razona pero no se reprodujo.
- **La lectura directa por PostgREST en Cloud** (N-07, solo en local); el alta de empresa de alguien sin rol (N-03); el teclado de los diálogos de personas (N).
- **La conversión cacheada con tasas por empresa** (O-07), porque no existen tasas por empresa.
- **La app móvil, y los PDF de nota de crédito y de débito impresos en papel.**

**Se creó fuera de la interfaz**, y está marcado en cada bloque:
- una factura de E2 fechada hace 40 días, que el régimen rechazó (F);
- la merma de 2 Galletas en E2, por la API y sin motivo, para entender I-01 (I);
- en E2, un asiento fechado el 20/08 (el n.º 58, posteado) y un borrador del 21/08 que queda vivo en agosto cerrado (K);
- dos intentos de cargar una tasa manual, los dos rechazados (D, J);
- la consulta de la deuda por rol (P-04).

**No está construido**, aunque una pantalla, una spec o un texto lo dé a entender:
- las recetas (I-04) y la alícuota reducida, adicional, exonerada y no sujeta (B-04);
- «vender describiendo la venta» (B-01) y compartir por WhatsApp (E-06);
- el pago cruzado USD↔Bs (D-02) y la nota de crédito de proveedor desde la web (H-03);
- el comprobante de retención como documento (H-04) y el recordatorio de gastos (H-07);
- la invitación por correo (N-08) y abrir una segunda empresa desde dentro (A-13);
- la búsqueda de documentos por número y el «Asistente de Ladino» (P-06);
- los reportes de ventas, margen e IVA (P-07);
- el contribuyente formal en ventas, libros y documentos (M-10).

### Cómo trabajaron los agentes

**Quién encontró qué.** De los 235 hallazgos:
- **100 los encontraron dos o más agentes por su cuenta.**
- El resto los encontró uno solo: auditor-codigo 63, auditor-fiscal 37 (y solo estuvo en 7 bloques), estratega-producto 27 y la sesión principal 7.
- En total participaron: auditor-codigo en 131, estratega en 106, sesión principal en 97 y auditor-fiscal en 53.
- La sesión principal casi nunca encuentra sola: su papel es producir la evidencia y verificar la de los demás.

**Dónde se contradijeron, y quién tenía razón:**
- **E-09**, leído en el código, decía que el cajero fía cualquier importe. La ejecución en N lo desmintió a medias: el cajero no puede vender nada (N-01). Leer el código dio la regla, y ejecutarla dio el hallazgo.
- **La hipótesis del estratega en N** («el cajero tampoco vende de contado») se confirmó con una venta dirigida. Es el hallazgo más grave del recorrido, y salió de ese ciclo hipótesis → ejecución.
- **En M**, el estratega leyó la captura 024 como un «eco» de R-7. Era la venta real de la primera ejecución del guion. Se corrigió y el eco quedó como SOSPECHA (M-02).
- **En P**, el estratega temía clientes duplicados por el RIF con guiones. El auditor lo descartó: el índice único normaliza (P-02).
- **Sospechas convertidas en hallazgos con una pasada dirigida:** O-01 (la pestaña que recarga), N-02 (el dueño invitado) y P-04 (la deuda por rol).

**Incidentes del equipo, para ajustar las definiciones:**
- auditor-codigo agotó sus 60 turnos en E, F, H, I y K, y el validador sus 40 en M. Sus informes se rescataron pidiéndoles la entrega. **Propuesta:** subir `maxTurns` de auditor-codigo, o partir su encargo por bloque.
- **El estratega editó `docs/08_UX/INFORMATION_ARCHITECTURE.md` en M**, contra la instrucción de no tocar el repositorio. El cambio sigue sin commitear, y lo decides tú. Desde N se le pidió explícitamente y no volvió a pasar.
- Los agentes escribieron su memoria en `.claude/agent-memory/`, sin commitear.
- El validador de cada bloque juzga el último gate sobre el mismo código, porque correr el gate borraría el escenario. El gate de verdad se corre una sola vez, en Z. **Propuesta:** que la skill `/recorrido` lo diga así.

### Orden propuesto para `/arreglar`

El criterio es primero lo que cuesta dinero o papel fiscal hoy, en producción; después lo que termina en verde; y dentro de cada tramo, lo que no necesita decisión.

**Tramo 0 · urgente, afecta a producción:**
1. **N-01**, el cajero no vende. Decisión: la opción 2, que la salida de la venta la autorice la venta, no cambia ninguna aserción existente. La opción 1 obliga a cambiar `040_named_roles_test.sql:61`. En la misma pasada, su familia: N-04 (G-08), B-16 y N-02.
2. **L-01 + L-02**, el libro de ventas. El signo ya está decidido (R-1). Hay que añadir la conciliación libro-mayor a los invariantes del gate, con una nota de crédito.
3. **J-01**, «Mover plata». Sin decisión para el arreglo.
4. **K-01**, reabrir un período, con K-02 en la misma pasada. Arreglarlo puede obligar a cambiar la aserción de pgTAP 025, que pasa gracias al defecto, y eso requiere tu aprobación.

**Tramo 1 · papel fiscal que termina en verde** (necesita decisión, varios con el asesor):
5. **G-01**, rangos solapados.
6. **E-01**, la serie del talonario.
7. **M-05**, el RIF V/E. La parte que no depende de la norma, no reagrupar, se puede hacer ya.
8. **E-02, E-03, A-03 y H-01**, el especial: IGTF y retenciones.
9. **C-01**, los decimales de la importación.

**Tramo 2 · bloqueos visibles:**
10. **M-01 a M-04 + D-03, F-03 y F-08**: una decisión sobre la llave de idempotencia cierra siete hallazgos.
11. **I-01 + I-02**, las salidas de inventario.
12. **F-01**, la retención con cambio de tasa.
13. **D-01**, la bodega sin RIF que compra.
14. **O-01**, la empresa por pestaña.
15. **P-01**, redondear al servir, que ya lo dice ADR-0063, junto con P-03 y K-08 cuando haya respuesta del contador.

**Después:** el índice de abajo. Primero las altas sin decisión, que se pueden llevar a `/arreglar` una por una; luego las que esperan tu respuesta.

### Índice de hallazgos por severidad

#### Críticas (13)

**Sin decisión del dueño (3):**

- **J-01** · (todas) · «Mover plata» entre dos cuentas de la misma moneda falla siempre con un error del servidor
- **K-01** · (todas) · ningún período cerrado se puede reabrir, y el único test de reapertura está en verde gracias al defecto
- **L-01** · E2, E3 · el libro de ventas suma las notas de crédito en vez de restarlas, y el CSV que se entrega al contador infla el débito fiscal _(termina en verde · VALIDAR-TRIBUTARIO)_

**Con decisión del dueño (10):**

- **C-01** · E1, E2, E3 · la importación lee «0.500» como 500 y «0.125» como 125 _(termina en verde)_
- **D-01** · E1 · una bodega sin RIF no puede registrar ninguna compra a un proveedor _(VALIDAR-TRIBUTARIO)_
- **E-01** · E3 · la caja factura siempre en serie A: con el talonario en serie B no vende, y la única salida es declarar un rango que no existe en papel _(termina en verde · VALIDAR-SENIAT)_
- **E-02** · E3 · un contribuyente especial cobra en divisas sin percibir IGTF y nada lo avisa ni lo encuentra después _(termina en verde · VALIDAR-TRIBUTARIO)_
- **E-03** · E3 · la factura no muestra el IGTF que la caja cobró _(termina en verde · VALIDAR-SENIAT · VALIDAR-TRIBUTARIO)_
- **F-01** · E3 · el comprobante de retención no se puede cargar en una factura en dólares si la tasa cambió desde la emisión _(VALIDAR-CONTABLE)_
- **G-01** · E2 · dos documentos fiscales con el mismo número de control: Ladino acepta un rango de notas de crédito que se solapa con el de facturas _(termina en verde · VALIDAR-SENIAT)_
- **H-01** · E3 · un contribuyente especial nunca retiene IVA desde la web, aunque tenga la regla cargada, y nada lo dice _(termina en verde · VALIDAR-TRIBUTARIO)_
- **M-01** · E4 · una cuenta ya cobrada vuelve de la nube y queda envenenada: la primera factura de la bodega da 409
- **N-01** · E2 · el cajero no puede vender ningún producto con existencia, ni de contado ni fiado, y nunca ha podido


#### Altas (67)

**Sin decisión del dueño (26):**

- **A-01** · E1 · el registro pierde el logo en silencio, después de enseñarlo puesto _(termina en verde)_
- **A-05** · E1 · al poner el RIF, la razón social nunca se pide: la primera factura saldrá con el nombre comercial _(termina en verde)_
- **A-06** · E1 · el recibo de devolución imprimiría «RIF: P-END…», fila de IVA y cita a la PA 00071 _(SOSPECHA · VALIDAR-SENIAT)_
- **C-03** · E2 · un producto pausado sigue en /productos con precio y existencia
- **D-08** · (todas) · «Ya era mía» fechada hoy falla si se registra antes de las 08:00 de Caracas _(SOSPECHA)_
- **D-09** · E2 · la llegada de ayer no se puede registrar en una empresa nueva, y la pantalla lo sabe antes y no lo impide
- **E-04** · E2, E3 · la factura no discrimina la base ni el IVA por alícuota, ni dice el porcentaje _(VALIDAR-SENIAT)_
- **F-02** · E2 · una factura pagada vuelve a deber cuando el BCV publica tarde la tasa del día _(termina en verde)_
- **F-03** · E2 · corregir un cobro rechazado y volver a registrar da «ya se registró», y no registra nada
- **F-06** · (todas) · un importe escrito a la venezolana, con punto de miles, deja el botón apagado sin decir por qué
- **F-07** · (todas) · SOSPECHA: el cobro «que cierra» sobrescribe el importe y deja la caja corta y un residuo en CxC _(termina en verde · SOSPECHA)_
- **F-08** · (todas) · SOSPECHA: la devolución con reembolso repite F-03, y «confirmar el sobregiro» no puede funcionar _(SOSPECHA)_
- **G-02** · E2, E3 · las notas de crédito y de débito no mencionan la factura que corrigen _(VALIDAR-SENIAT)_
- **G-03** · E1 · el recibo de devolución de una bodega sin RIF sale con un RIF inventado, desglose de IVA y cita de la providencia
- **G-04** · E2 · el estado de cuenta enseña la nota de crédito con saldo positivo, como si el cliente la debiera
- **G-08** · (todas) · SOSPECHA: el rol administrativo ve «Anular», pero la anulación falla al final por un permiso contable _(SOSPECHA)_
- **H-03** · E2 · la nota de crédito de un proveedor es imposible desde la web, y los E2E pasan porque mandan un campo que la pantalla no pide _(VALIDAR-TRIBUTARIO)_
- **H-06** · E2 · el pedido nace en bolívares y el precio no dice en qué moneda va: 15 cajas «a 18» quedaron en 270 Bs _(termina en verde)_
- **I-02** · (todas) · los cuatro tests de «Salida» están en verde porque no mandan el motivo que la web siempre manda _(termina en verde)_
- **I-03** · E2 · D-14 confirmado: con dos depósitos, «¿A qué depósito?» atrapa al teclado
- **J-03** · (todas) · el «cierre de caja» del servidor acepta cualquier cuenta, también el banco, y revela su saldo a quien no debería verlo _(termina en verde)_
- **K-07** · E2 · el mayor sin fecha «desde» enseña un saldo inicial falso, igual al final _(termina en verde)_
- **L-02** · — · los tests no pueden ver L-01: el que cruza libro y declaración aplica el signo él mismo, la conciliación nunca se probó con una NC y nadie la corre _(termina en verde)_
- **M-02** · E4 · si la cuenta resucitada se cobra igual que antes, el servidor devuelve la venta vieja como nueva, y el efectivo entra sin venta _(termina en verde · SOSPECHA)_
- **M-06** · E4 · la banda «Con tu RIF puedes facturar →» lleva al paso 1 de 4, «Tus productos», no al de facturas
- **P-01** · (todas) · «Lo que gané» sale con cuatro a seis decimales en la pantalla más vista, contra lo que dice ADR-0063 _(VALIDAR-CONTABLE)_

**Con decisión del dueño (41):**

- **A-02** · E2, E3 · «Facturas legales desde el primer día», y el alta con RIF no deja cómo facturar
- **A-03** · E3 · «contribuyente especial» no se pregunta, y sin declararlo el IGTF se omite en silencio _(termina en verde · VALIDAR-TRIBUTARIO)_
- **A-04** · E1, E2 · «Contabilidad y Libros fiscales aparecen solos cuando tienen datos», y aparecen el primer día
- **B-01** · E2 · «también se puede vender describiendo la venta»: no se puede
- **B-02** · E2 · aceptar el IVA otra vez con otro porcentaje deja un acta que no se aplica _(termina en verde)_
- **B-03** · E2, E3 · el talonario nunca dice «número de control», y la factura no llevará los datos de la imprenta _(termina en verde · VALIDAR-SENIAT)_
- **C-02** · (todas) · después del primer día, dar de alta un producto son cuatro pantallas
- **C-04** · (todas) · una importación grande agota el tiempo, dice «No se pudo leer el archivo» y sigue creando; al reintentar, duplica _(termina en verde · SOSPECHA)_
- **D-02** · E2 · pagar en bolívares una factura en dólares es imposible, y la pantalla lo propone
- **D-03** · (todas) · tras un error, corregir y confirmar dice «ya se registró con otros datos», y no se registró nada
- **D-04** · E1, E2 · «Cédula o RIF: puede quedar vacío», y sin RIF el proveedor no se guarda
- **D-05** · E2, E3 · la llegada suma el IVA a lo que la persona escribe, y en ningún momento enseña un importe _(termina en verde)_
- **D-06** · E2 · «Ya llegó la factura» no deja poner el precio de la factura: la revalorización que promete el código no se alcanza _(termina en verde)_
- **D-07** · E2, E3 · pagar otro día una factura en USD no reconoce el diferencial cambiario _(termina en verde · SOSPECHA · VALIDAR-CONTABLE)_
- **E-05** · E3 (toda factura cuyo IVA en USD no cae exacto) · el IVA en Bs no es el 16 % de la base en Bs _(termina en verde · VALIDAR-TRIBUTARIO)_
- **E-06** · E1, E2, E3 · no hay «compartir» ni WhatsApp de la factura o el recibo, y la documentación de cumplimiento lo da por construido
- **E-07** · E2 · la tarjeta del producto enseña el precio del mostrador y el carrito cobra el del cliente
- **E-08** · (todas) · las cuentas abiertas son de la empresa: vuelven de la nube sin aviso, y cualquier cajero ve, cobra o borra las de otro
- **F-04** · (todas) · la misma deuda enseña cuatro cifras distintas, y una sale por WhatsApp al cliente _(VALIDAR-CONTABLE)_
- **F-05** · E3 · en la ficha, el IGTF se cobra «además» de lo que el cliente pagó, y la cuenta registra más dinero del que entró _(termina en verde · VALIDAR-TRIBUTARIO)_
- **G-05** · (todas) · la deuda en dólares se revalúa cada día, pero el saldo a favor de devolver esa misma factura queda fijo en bolívares _(termina en verde)_
- **G-06** · E3 · la devolución de una venta cobrada con IGTF deja el impuesto como «percibido» de una venta que ya no existe _(termina en verde · VALIDAR-TRIBUTARIO)_
- **G-07** · (todas) · el cajero no tiene ningún camino para una devolución
- **H-02** · E2, E3 · D-07 confirmado: pagar otro día una factura en dólares no reconoce el diferencial, y la cuenta por pagar queda descuadrada para siempre _(termina en verde · VALIDAR-CONTABLE)_
- **H-04** · E3 · el comprobante de retención no existe como documento _(termina en verde · VALIDAR-SENIAT)_
- **H-05** · E3 · pagar al proveedor desde /admin/compras sin saldo en la cuenta: el mensaje dice «confirma que quieres registrarlo igual» y no hay con qué
- **H-07** · E2 · «Se paga todos los meses: para recordártelo cuando toque», y no hay recordatorio _(termina en verde)_
- **I-01** · (todas) · ninguna «Salida» de inventario (merma, consumo, regalo, vencido) se puede registrar desde la web _(VALIDAR-CONTABLE)_
- **I-04** · (todas) · las recetas existen en pantalla y son inalcanzables: ningún producto puede volverse compuesto
- **J-02** · E2 · cerrar una caja en sobregiro convierte en ganancia el dinero que la dueña puso de su bolsillo _(termina en verde · VALIDAR-CONTABLE)_
- **K-02** · (todas) · SOSPECHA: aun arreglando K-01, volver a cerrar un período reabierto también violaría un CHECK: el modelo solo admite un ciclo _(SOSPECHA)_
- **K-03** · (todas) · SOSPECHA: el cierre del ejercicio es imposible si diciembre ya está cerrado _(SOSPECHA)_
- **K-04** · E2 · SOSPECHA: una factura de proveedor que llega tarde, de un mes cerrado, no se puede registrar con su fecha _(SOSPECHA · VALIDAR-CONTABLE · VALIDAR-TRIBUTARIO)_
- **L-03** · E3 · el TXT de retenciones de IVA no sigue el orden de campos del instructivo publicado del SENIAT _(VALIDAR-SENIAT)_
- **L-04** · E3 · el contribuyente especial declara IVA por quincena y la pantalla le propone el mes _(VALIDAR-SENIAT)_
- **L-05** · E3 · el excedente que pasa al período siguiente mezcla crédito fiscal y retenciones no absorbidas en una sola cifra _(VALIDAR-TRIBUTARIO)_
- **M-05** · E4 · el RIF de persona natural sale como una cédula de nueve cifras, en la pantalla y en el PDF de la factura _(termina en verde · VALIDAR-SENIAT)_
- **N-02** · E3 · el «Dueño» que se agrega a otra empresa no es dueño: no ve a las personas, no puede vender mercancía, y la web le ofrece lo que el servidor le niega
- **N-03** · E2 · a quien le quitan el rol o lo desactivan, Ladino le propone fundar un negocio
- **N-04** · E2 · «Anular» se le ofrece al administrativo, falla al final y enseña el nombre técnico del permiso
- **O-01** · E2, E3 · una pestaña que recarga se pasa sola a la empresa que se eligió en otra pestaña, sin avisar


#### Medias (94)

**Sin decisión del dueño (40):**

- **A-07** · (todas) · un miembro sin permiso escribe en el almacenamiento antes de recibir su 403 _(termina en verde)_
- **A-08** · E2 · el RIF no se valida (bien), pero la web decide prefijos y estructura sin fuente _(termina en verde · VALIDAR-SENIAT)_
- **A-09** · (todas) · elegir el rubro avanza solo; elegir «¿tienes RIF?» no
- **B-05** · E2, E3 · cargar un talonario no deja acta _(termina en verde)_
- **B-10** · E2 · el asistente no recuerda en qué paso ibas
- **B-11** · E2, E3 · «El porcentaje lo fija la ley, no Ladino»… y la ayuda dice «hoy 16 %» fijo en la interfaz
- **B-12** · E2, E3 · el paso 4 queda en blanco mientras carga _(SOSPECHA)_
- **C-08** · (todas) · el encargado ve «Importar» y «Nuevo producto» y todo le falla por no poder poner precios _(SOSPECHA)_
- **C-09** · (todas) · la foto del producto se procesa y se guarda antes de comprobar el permiso _(SOSPECHA)_
- **C-10** · (todas) · la foto del producto no se puede arrastrar
- **C-11** · E1, E2 · el historial de precios enseña en Bs la conversión de HOY, también para los precios viejos _(SOSPECHA)_
- **D-10** · E2 · el kardex queda desordenado: «Ya era mía» de hoy aparece antes que movimientos anteriores del mismo día
- **D-11** · E2 · confirmar un sobregiro no queda auditado ni pide permiso
- **D-12** · E1 · a una empresa sin RIF se le ofrece «entra al libro de compras y da crédito fiscal»
- **D-13** · E2 · el aviso de sobregiro enseña «120000.00000000»
- **D-14** · E2 · «¿A qué depósito?» atrapa al teclado: Enter elige pero no avanza, y no hay «Seguir» _(SOSPECHA)_
- **E-12** · (todas) · siete tablas con `tenant_id` dejan a la API ver todas las empresas: su aislamiento depende solo del WHERE _(termina en verde)_
- **E-16** · E3 · /admin/igtf ofrece «Marcarla como sujeto pasivo especial» a una empresa que ya lo es
- **F-12** · (todas) · ningún invariante cruza las cuentas por cobrar por documento con la cuenta 1.1.03 del mayor _(termina en verde)_
- **G-09** · E2, E3 · en el papel de las notas falta el porcentaje de IVA, la nota de débito no describe el ajuste y ninguna trae el motivo _(VALIDAR-SENIAT)_
- **G-12** · E1, E2 · un documento pagado exacto queda con saldo de ±0,01 para siempre
- **G-13** · (todas) · cargar un talonario fiscal no deja acta, y la regla vive en la API, no en el dominio
- **G-14** · E2 · en una factura cobrada, «Anular» desaparece sin decir por qué ni que el camino es «Devolución»
- **G-16** · E3 · «no hay rango… para debit_note serie A», dos veces
- **H-10** · (todas) · «Lo que debo → Ver qué debo» lleva a los gastos, no a lo que se debe
- **H-12** · E3 · SOSPECHA: el libro de compras no identifica el comprobante de retención _(SOSPECHA · VALIDAR-SENIAT)_
- **H-15** · E2 · registrar un gasto tardó 3,9 s (validador)
- **I-06** · E2 · el kardex mezcla los saldos de los dos depósitos y enseña tipos crudos
- **I-09** · (todas) · «Revisa los campos marcados», y ningún campo se marca
- **K-06** · E2 · «postéalos o descártalos», pero un borrador no se puede descartar: el de agosto queda zombi
- **K-10** · E2 · la miga «Inicio» lleva al contador a un callejón sin salida
- **K-11** · E2 · SOSPECHA: el contador ve «Nuevo cliente» e «Importar», y el servidor lo rechaza _(SOSPECHA)_
- **L-08** · E2, E3 · el libro no separa la base por alícuota ni trae el resumen mensual _(VALIDAR-SENIAT)_
- **L-10** · E2, E3 · el selector de formatos del libro de ventas ofrece el TXT de retenciones
- **M-03** · (todas) · la cuenta cobrada puede volver por otros dos caminos _(SOSPECHA)_
- **M-04** · E4 · el aviso del 409 invita a revisar y repetir, y la cuenta está muerta
- **M-07** · E4 · la escalera de /empezar son cuatro barritas sin texto
- **N-05** · E2 · Mi dinero le dice al encargado que no hay tasa BCV, cuando la hay
- **N-07** · (todas) · cualquier miembro activo, incluso sin rol, lee todas las membresías y asignaciones del negocio directamente de la base _(termina en verde)_
- **O-03** · (todas) · las altas de personas y sus roles no guardan autor en su fila _(termina en verde)_

**Con decisión del dueño (54):**

- **A-10** · E2 · «Sin documentos emitidos, el cambio es directo» se muestra siempre, y nada recuerda actualizar el RIF ante el SENIAT _(VALIDAR-TRIBUTARIO)_
- **A-11** · E2, E3 · el pie de la factura cita una homologación derogada _(VALIDAR-SENIAT)_
- **A-12** · (todas) · «Te toma menos de dos minutos», para 8 pantallas o para 11
- **A-13** · E2 · no hay forma, desde dentro de Ladino, de abrir una segunda empresa
- **B-04** · E2, E3 · la alícuota reducida, la adicional, lo exonerado y lo no sujeto se pueden elegir y no se pueden vender _(VALIDAR-TRIBUTARIO)_
- **B-06** · (todas) · la «versión de reglas» es la misma cadena desde S0.5 _(termina en verde)_
- **B-07** · E3 · «especial» rige desde que se guarda: sin fecha de notificación ni vigencia _(termina en verde · VALIDAR-TRIBUTARIO)_
- **B-08** · E2, E3 · «Formatos libres» mezcla dos medios que la PA 00071 separa _(SOSPECHA · VALIDAR-SENIAT)_
- **B-09** · (todas) · la tasa: «Un toque al día» y «Se actualiza sola» en la misma pantalla
- **C-05** · E2 · la importación descarta en silencio la existencia de un servicio (y el costo de una fila sin existencia) _(termina en verde)_
- **C-06** · E2 · «vender al mayor» no tiene interruptor, y activarlo no cambia la caja
- **C-07** · (todas) · ningún producto puede llevar lote ni vencimiento: la parte de la llegada que los pide no se enciende nunca
- **E-09** · (todas) · el cajero puede fiar cualquier importe a cualquier cliente, incluido uno que acaba de crear _(termina en verde)_
- **E-10** · E1, E2, E3 · en el papel, el total de la línea lleva IVA y el precio no, y el subtotal no es la suma de la columna _(VALIDAR-SENIAT)_
- **E-11** · (todas) · el mayor registra los cobros en divisas como bolívares, sin el importe en USD ni la tasa _(termina en verde · VALIDAR-CONTABLE)_
- **E-13** · (todas) · la caja nunca vende sin existencia, y el ajuste de empresa que diría lo contrario está muerto _(termina en verde)_
- **E-14** · E2 · la lista preferida del cliente solo se elige al crearlo en /admin/clientes; la caja crea las J como «ordinario» sin preguntar
- **E-15** · E2 · con documentos emitidos, «Cambiar el RIF» sigue diciendo «Sin documentos emitidos, el cambio es directo» y manda a «crear otra empresa», cosa que no se puede
- **E-17** · E3 · el 409 de numeración dice «invoice» y no da camino desde la caja
- **E-18** · E2 · SOSPECHA: la cesta básica se facturó con IVA _(termina en verde · SOSPECHA · VALIDAR-TRIBUTARIO)_
- **F-09** · E3 · «Comprobante cargado», y la lista de abajo dice «Ningún comprobante en este período»
- **F-10** · E2 · el cobro de más se rechaza en USD con punto decimal, y manda a hacer una nota de crédito
- **F-11** · (todas) · cargar un comprobante de retención lo puede hacer el cajero y no el contador _(termina en verde)_
- **F-13** · (todas) · no hay dónde ver quién me debe: «Cuentas por cobrar» pide elegir un cliente, y «Ver quién me debe» lleva a la lista entera de clientes
- **G-10** · E2 · anular o nota de crédito: la norma no dice cuándo, y el libro de ventas trata la anulada distinto que el de compras _(VALIDAR-TRIBUTARIO)_
- **G-11** · E2, E3 · las notas del 25/09 imprimen la tasa de la factura del 24/09, sin decir de dónde sale _(VALIDAR-TRIBUTARIO)_
- **G-15** · E2 · un saldo a favor que ya existe no se puede devolver en dinero
- **H-08** · (todas) · el comprobante del gasto: no se adjunta con teclado, se guarda como «.img» y cualquier miembro lo lee
- **H-09** · E2 · un gasto con factura e IVA (la luz) no da crédito fiscal ni entra al libro, y la pantalla no lo avisa _(VALIDAR-TRIBUTARIO)_
- **H-11** · (todas) · «Cuentas por pagar» no enseña nada hasta elegir un proveedor
- **I-05** · E2 · un producto inactivo con existencia desaparece de «qué tengo» y su mercancía queda congelada _(termina en verde)_
- **I-07** · (todas) · «¿contaste mercancía?» lleva a un ajuste que pide la diferencia calculada a mano
- **I-08** · (todas) · mover y ajustar el inventario están separados solo de nombre
- **J-04** · E2 · «Lo que debo» y la caja en dólares no cuadran con el mayor, y ningún invariante lo mira _(termina en verde · VALIDAR-CONTABLE)_
- **K-05** · E2 · cualquier fecha entre el año 2000 y el 2200 crea su período sin preguntar; el asiento de agosto entró antes de que existiera la empresa
- **K-08** · E2 · los estados financieros enseñan cuatro y seis decimales, porque los importes funcionales de compras e inventario no se redondean al céntimo _(VALIDAR-CONTABLE)_
- **K-09** · (todas) · quien se registra para que lo agreguen a un negocio ajeno cae en «Vamos a montar tu negocio»
- **L-06** · E2, E3 · la conciliación culpa a «un asiento que ningún documento respalda», que no existe, y no lleva a ningún documento
- **L-07** · E2 · la factura anulada va en el libro de ventas y en el CSV con todos sus importes _(VALIDAR-TRIBUTARIO)_
- **L-09** · E3 · el calendario de los contribuyentes especiales de 2026 no está cargado, y el motivo para no cargarlo ya no existe _(VALIDAR-SENIAT)_
- **M-09** · E4 · la caja no dice que ahora se factura: la banda de recibos desaparece y nada la sustituye
- **M-10** · E4 · «Formal» se ofrece sin decir qué significa, y en ventas, libros y documentos Ladino lo trata como un ordinario _(termina en verde · VALIDAR-TRIBUTARIO)_
- **M-11** · E4 · para Ladino, la factura empieza cuando se pulsa «Así facturo»; la ley puede ponerla antes _(VALIDAR-TRIBUTARIO)_
- **M-12** · E4 · después del cambio, un recibo viejo no se puede devolver con ningún documento _(SOSPECHA)_
- **N-06** · E2 · al cajero desactivado con la caja abierta, el cobro le dice «Eso no existe o no está disponible para ti»
- **N-08** · (todas) · no hay invitación: la persona tiene que registrarse antes, y si lo hace le proponen fundar un negocio
- **O-02** · E2 · la venta del POS queda entera a nombre de quien cobra: quién armó la cuenta no queda en ningún sitio _(termina en verde)_
- **O-05** · E2, E3 · nada distingue una empresa de otra salvo el texto: mismo ícono para todas, sin el logo que ya existe
- **P-02** · (todas) · el RIF del cliente se guarda con guiones o sin ellos según por dónde entró, y la búsqueda depende de cómo se escriba
- **P-03** · E2, E3 · los gastos y pagos a proveedores en divisa se asientan con fracciones de céntimo _(termina en verde · VALIDAR-CONTABLE)_
- **P-04** · E2 · cualquier miembro recibe lo que debe cada cliente, aunque el Inicio se lo oculte _(termina en verde)_
- **P-05** · (todas) · «Te deben… Un mensaje a tiempo cobra la mitad» lleva a una lista que no se puede ordenar por deuda
- **P-06** · (todas) · Ctrl+K no encuentra un documento por su número ni una acción como «cierre»
- **P-07** · (todas) · «Reportes» es una sola cifra, el diferencial cambiario, y tres enlaces


#### Bajas (61)

**Sin decisión del dueño (54):**

- **A-14** · (todas) · cada logo nuevo deja el anterior en el almacenamiento
- **A-15** · E1, E2, E3 · la importación del plan de cuentas se audita como si fuera un asiento
- **A-16** · (todas) · la auditoría no guarda origen: ip, dispositivo, sesión y build siempre vacíos _(SOSPECHA)_
- **A-17** · E2 · la corrección de RIF acepta el marcador reservado «PEND-…» _(SOSPECHA)_
- **A-18** · (todas) · el teclado en el asistente: la bienvenida y los grupos de opciones
- **A-19** · E1 · la primera subida de logo tras arrancar la API tardó ~8,5 s
- **B-13** · E1, E2, E3 · el alta simple guarda como «hora de la tasa» el reloj del servidor
- **B-14** · (global) · la tasa BCV del día se guarda sin acta
- **B-15** · E2, E3 · la regla dice «ACEPTADA por el dueño» aunque la acepte el contador _(SOSPECHA)_
- **B-16** · (todas) · el encargado puede crear productos pero no poner precio: el alta simple le falla _(SOSPECHA)_
- **B-17** · (todas) · el paso de cuentas promete «pago móvil» y el tipo no existe
- **B-18** · (todas) · el teclado en /empezar: diálogos sin Enter y grupos sin flechas
- **B-19** · E3 · el aviso de máquina fiscal parafrasea mal el art. 8 de la PA 00071 _(VALIDAR-TRIBUTARIO)_
- **C-12** · E2 · un precio programado a futuro impide cambiar el de hoy, con un mensaje que dice «período ya cerrado» _(SOSPECHA)_
- **C-13** · E2 · la vigencia del precio empieza con el reloj del navegador o del servidor, no con el de la base
- **C-14** · E2 · un reintento de «Cargar precio» abre otra vigencia igual
- **D-15** · E2, E3 · la línea de factura de proveedor mezcla la base sin IVA con el total con IVA
- **D-16** · E2 · el pago a proveedor no enlaza su asiento; una categoría sin regla daría un error de JavaScript _(SOSPECHA)_
- **D-17** · E2 · «Se la compraste a Alimentos del Centro, C.A..»
- **D-18** · (todas) · «No, quedo debiendo» con teclado pide un paso más que con el ratón
- **E-19** · E1 · lo entregado y el vuelto no se guardan, y el diálogo rotula «Recibido» lo abonado _(termina en verde)_
- **E-20** · — · `tax_amount` de la línea va en la moneda de la venta y el del documento en Bs, con el mismo nombre _(termina en verde)_
- **E-21** · (todas) · SOSPECHA F1: la pantalla del IGTF muestra la regla de mañana desde las 20:00 de Caracas _(SOSPECHA)_
- **E-23** · (todas) · elegir la forma de pago es el único paso de la caja que exige ratón
- **E-24** · — · la documentación cita la marca «(E)» y el adquirente un numeral corridos _(VALIDAR-SENIAT)_
- **F-15** · E3 · una factura pagada deja −0,01 para siempre en la cuenta 1.1.03 del mayor _(termina en verde)_
- **F-16** · (todas) · SOSPECHA F1: la antigüedad cuenta un día de más desde las 20:00 de Caracas _(SOSPECHA)_
- **F-17** · (todas) · SOSPECHA: a 390 px, la ficha y el diálogo de cobro apilados pueden verse como uno solo _(SOSPECHA)_
- **G-17** · E2 · «saldo a favor», en minúsculas, como forma de pago
- **G-19** · E2 · la reversa de una anulación queda como asiento «manual»
- **G-21** · E2 · «Este factura ya tiene cobros…»
- **H-13** · E2 · la compra sin factura sale como «Factura» en /compras
- **I-10** · E2 · «Ajuste registrada»
- **I-12** · (todas) · SOSPECHA: «Por agotarse» daría siempre en alerta los productos llevados por lotes, y cuenta los inactivos _(SOSPECHA)_
- **J-05** · (todas) · el motivo del cierre se guarda, pero la pantalla no lo enseña
- **K-12** · E2 · «Borrador creado · Asiento 01a0d990»: un pedazo del id en lugar de algo que se pueda buscar
- **K-13** · E2 · «el período 2026-8 está CERRADO»
- **K-14** · E2 · el diario no cabe a 1366 px: la columna de débitos se corta
- **K-15** · E2 · cada pantalla del contador pide `/v1/treasury/accounts` y recibe 403
- **L-11** · (todas) · la pantalla de libros cita la fuente equivocada: «Obligación de PA 071 y PA 102»
- **L-13** · E2 · «Generaciones» enseña el formato crudo («csv_columnas_legales»), y el mismo dato se llama «Hash» en Libros y «Huella» en Declaraciones
- **L-14** · (todas) · la pantalla pide el libro con el rango al revés mientras se escribe la fecha
- **L-15** · E3 · la quincena del IGTF la calcula la web: una regla fiscal en el cliente
- **M-08** · E4 · «Tu RIF ya está cargado desde el registro», cuando se puso después en Configuración
- **M-13** · — · la pregunta P-17 al asesor describe un comportamiento que ya no existe
- **N-09** · (todas) · la pantalla que no le toca redirige en silencio, y hay dos pantallas distintas que se llaman «Inventario»
- **N-10** · (todas) · el rastro de quitar el rol y de reactivar queda incompleto _(termina en verde)_
- **N-11** · (todas) · cada aterrizaje pide 3 a 5 datos que el rol no puede ver, y recibe 403
- **O-04** · E2, E3 · «Elige la empresa» y «Cambiar de empresa» enseñan el RIF crudo, y el resto de la web con guiones
- **O-06** · (todas) · el botón del selector enseña el nombre comercial y la lista la razón social _(SOSPECHA)_
- **O-07** · (todas) · la conversión Bs/USD se cachea sin la empresa _(SOSPECHA)_
- **P-08** · (todas) · el pie del gráfico dice «esmeralda ganancia» y la barra es azul
- **P-09** · (todas) · si hay tasa BCV de mañana, el Inicio la enseña mientras la caja cobra con la de hoy _(SOSPECHA)_
- **P-10** · (todas) · «Por agotarse» ignora la existencia en lotes _(SOSPECHA)_

**Con decisión del dueño (7):**

- **E-22** · E1 · el recibo de una venta fiada parece un recibo pagado
- **F-14** · E1 · la bodega sin RIF lee «Cuentas por cobrar», «Antigüedad de saldos» y «Abonada»
- **G-18** · (todas) · SOSPECHA: una nota de crédito sobre una factura fiada no baja su deuda _(SOSPECHA)_
- **G-20** · (todas) · SOSPECHA: la misma persona devuelve, reembolsa y confirma el sobregiro, sin aprobación _(SOSPECHA)_
- **H-14** · (todas) · SOSPECHA: el pago a proveedor no tiene aprobación, y el dueño crea el proveedor y aprueba su cuenta bancaria _(SOSPECHA)_
- **I-11** · E2 · el asiento de una salida no lleva el motivo, que era la razón de pedirlo _(VALIDAR-CONTABLE)_
- **L-12** · E3 · «Retenciones de IVA» (las practicadas) y «Retenciones que nos hicieron» (las soportadas) no se distinguen por el nombre

### Cierre Z (validador)
**Gate completo, verde, sobre el árbol final.** `pnpm gate`, que corre los 11 pasos y el `db:reset`, dio:
- 736 pasos, vitest 805 en 19 paquetes y pgTAP 1264 en 70 ficheros, iguales a la línea base;
- VERIFY EXIT=0, openapi:check OK y release:manifest:check OK.

El `git diff` de apps, packages y supabase está vacío: el recorrido no cambió ni una línea de código. La primera corrida cayó en el paso 1 (Prettier), por los guiones sin formatear de `scripts/recorrido/`, que están fuera de git. Se les dio formato y la segunda corrida pasó.

**Invariantes.** Después del `db:reset`, la base local queda sin empresas. Por eso el escenario se volcó antes a `.recorrido/2026-09-24/escenario.dump` (2,1 MB, 3.414 objetos, fuera de git). La última medición sobre el escenario fue el cierre de P: las tres empresas dieron 0, con el informe de conciliación en 1 en E2 y E3 (L-01).

**Documento:**
- 16 bloques, cada uno con su cierre;
- 235 hallazgos consecutivos: 13 críticos, 67 altos, 94 medios y 61 bajos;
- el índice lista los 235;
- toda captura citada existe, y ninguna queda sin citar. Faltaban 6, que se citaron en este cierre;
- en lo que se publica no hay secretos ni la clave de las cuentas de prueba.

---

## Bloque A · Registro y empresa

**Qué se hizo.** Tres registros premium por la interfaz: E1 (sin RIF, con logo), E2 y E3 (con RIF).
En «Mi empresa»: el logo de E1, el perfil de E2 y un cambio de RIF de E2 sin documentos, ida y vuelta.
El asistente se hizo entero con teclado, a 390 px en oscuro y a 1024 px en oscuro. Se probaron
además tres «Crear mi negocio» simultáneos por la API (auditor-codigo). **Quedan para después**
(no hay documentos todavía): el cambio de RIF con documentos emitidos, la corrección con motivo y
el logo en el PDF (tras el bloque E); poner el RIF de E1 por primera vez (bloque M).

**Quién encontró qué:** S = sesión principal · E = estratega-producto · C = auditor-codigo ·
F = auditor-fiscal.

### A-01 · A · alta · E1 · dueña — el registro pierde el logo en silencio, después de enseñarlo puesto (S, E, C)
PANTALLA: registro premium, pasos «Ponle la cara a tu negocio» y «Así se ve tu negocio» → /empezar
DIMENSIÓN: PROMESA · ESTADOS
PROMETE: «Tu logo saldrá en la app y en tus recibos» (`apps/web/src/pages/registro/Registro.tsx:667`); el resumen pinta el logo ya puesto (`:810-816`).
HACE: `crear()` sube el logo DESPUÉS de fundar el negocio y descarta el resultado: `.catch(() => null)` sin mirar el status (`Registro.tsx:385-395`); si el alta da 409 ni lo intenta (`:367-371`). En el recorrido la subida dio 422 y E1 quedó con `logo_path` NULL, aterrizando en /empezar sin ningún aviso.
EVIDENCIA: `capturas-recorrido/A/A-01-resumen-promete-el-logo.png`, `A-01-aterriza-sin-aviso.png`; `.recorrido/…/A/010-E1-resumen.json` (`red`: `POST /v1/companies/logo → 422`, `avisos: []`); audit `company.logo_set` de E1 con `from: null` (lo subió después «Mi empresa»). El 422 fue del entorno (la API arrancó sin almacenamiento); el defecto es que CUALQUIER fallo de la subida se traga.
REPRODUCIR: registrar un negocio con logo con la ruta del logo fallando → resumen con logo → «Crear mi negocio» → /empezar sin aviso → Configuración: sin logo.
¿SE NOTA?: termina en verde
¿NECESITA DECISIÓN DEL DUEÑO?: no

### A-02 · A · alta · E2, E3 · dueño — «Facturas legales desde el primer día», y el alta con RIF no deja cómo facturar (F)
PANTALLA: registro, «¿Tu negocio ya tiene RIF?» → /empezar
DIMENSIÓN: PROMESA · MODO
PROMETE: «Sí, tengo RIF — Facturas legales desde el primer día.» (`Registro.tsx:550`)
HACE: el alta con RIF no crea régimen fiscal (`packages/domain/src/onboarding.ts:108` solo lo inserta sin RIF), deja `taxpayer_type_code` NULL y ningún talonario. E2 y E3 aterrizan con «Tus facturas» pendiente; facturar exige completar el paso 4 de /empezar (régimen, alícuota con acta, talonario, tipo de contribuyente).
EVIDENCIA: base local tras el bloque A: E2 y E3 `(sin régimen)`, `taxpayer_type_code` NULL, 0 rangos; `capturas-recorrido/A/A-03-facturas-desde-el-primer-dia.png`, `A-03-e3-aterriza-sin-regimen.png`.
REPRODUCIR: registrar con «Sí, tengo RIF» → aterrizar en /empezar → «Tus facturas» sin hacer.
¿SE NOTA?: la persona lo ve (al llegar al paso 4)
¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿se cambia la promesa del registro, o el registro con RIF deja la facturación lista? (auditor-codigo lo considera diseño: la pantalla y la base coinciden; lo que no coincide es el texto)

### A-03 · A · alta · E3 · dueño — «contribuyente especial» no se pregunta, y sin declararlo el IGTF se omite en silencio (F)
PANTALLA: registro; /admin/configuracion → «Tipo de contribuyente»
DIMENSIÓN: MODO
PROMETE: «Especial — El SENIAT te notificó que eres sujeto pasivo especial: además retienes IVA y percibes IGTF.» (`apps/web/src/components/capa-fiscal/TipoDeContribuyente.tsx:27-31`)
HACE: el registro no lo pregunta; marcarlo exige que la empresa ya esté en modo facturas (`packages/domain/src/igtf.ts:190-198`). La emisión no mira el tipo de la EMPRESA (`sales.ts:800-801` solo lee el del cliente) y la percepción exige `especial` (`igtf.ts:106-109`): si nadie lo declara, o se elige «Ordinario» por error, las facturas cobradas en divisa salen sin percepción y nada avisa. «Tus facturas» se da por listo con cualquier tipo (`Empezar.tsx:114`).
EVIDENCIA: código citado (CONFIRMADO); el 409 en modo `ninguno` es SOSPECHA — se comprueba en el bloque B, donde E3 se declara especial.
REPRODUCIR: E3 recién registrada → Configuración → «Especial» (409 esperado). Luego, con formas libres y «Ordinario», facturar con cobro en divisa → sin percepción.
¿SE NOTA?: termina en verde
¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿se exige declarar el tipo (y la fecha de notificación si es especial) antes de la primera factura? · VALIDAR-TRIBUTARIO: ¿desde qué fecha rige la condición de especial, la de la notificación o la de su carga? · VALIDAR-TRIBUTARIO: la PA SNAT/2022/000013 que el código cita (`igtf.ts:86`, `:133`) no está en REGULATORY_STATUS ni en IGTF_SPEC

### A-04 · A · alta · E1, E2 · dueño — «Contabilidad y Libros fiscales aparecen solos cuando tienen datos», y aparecen el primer día (F)
PANTALLA: /admin/configuracion → Módulos, y el menú
DIMENSIÓN: PROMESA
PROMETE: «Compras, Contabilidad y Libros fiscales aparecen solos…» cuando la empresa tiene datos en ellos (`apps/web/src/pages/Configuracion.tsx:171-172`).
HACE: el alta importa siempre el plan de cuentas (`onboarding.ts:153-157`); la sonda da Contabilidad por activa si hay cuentas, y Libros si Contabilidad lo está (`apps/web/src/app/modulos-activos.ts:24-28`). Resultado: Contabilidad visible para toda empresa nueva, y Libros fiscales, Declarar IVA e IGTF para toda empresa con RIF desde el minuto uno, sin un dato.
EVIDENCIA: `capturas-recorrido/A/A-05-modulos-fiscales-sin-datos-E2.png`, `A-05-modulos-E1.png`
REPRODUCIR: registrar cualquier empresa → Configuración: el texto dice una cosa y el menú muestra otra.
¿SE NOTA?: la persona lo ve
¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿se cambia el texto o la regla de la sonda?

### A-05 · A · alta · E1 · dueña — al poner el RIF, la razón social nunca se pide: la primera factura saldrá con el nombre comercial (F)
PANTALLA: /admin/configuracion → «Poner mi RIF»
DIMENSIÓN: DOCUMENTOS
PROMETE: «Con tu RIF activas las facturas. La razón social y la dirección fiscal tienen que estar cargadas.» (`apps/web/src/pages/configuracion/MiEmpresa.tsx:608`); ADR-0050:49-50: «RIF real exige razón social y domicilio fiscal».
HACE: el alta sin RIF guarda como razón social el nombre del negocio (`onboarding.ts:88`); «Editar» oculta el campo sin RIF (`MiEmpresa.tsx:456`); el diálogo del RIF solo pide la dirección (`:555`, `:633-647`) y el servidor solo comprueba la dirección (`packages/domain/src/company-profile.ts:209-216`). La primera factura congelará «Bodega La Esquina» como razón social del emisor (`sales.ts:1103-1107`).
EVIDENCIA: código (CONFIRMADO). Se reproduce en el bloque M.
REPRODUCIR: E1 → Poner mi RIF → RIF + dirección → facturar → el PDF dice «Bodega La Esquina» como razón social.
¿SE NOTA?: termina en verde
¿NECESITA DECISIÓN DEL DUEÑO?: no (es la regla de ADR-0050)

### A-06 · A · alta · E1 · dueña — el recibo de devolución imprimiría «RIF: P-END…», fila de IVA y cita a la PA 00071 (F) — SOSPECHA fuerte, se reproduce en G
PANTALLA: /admin/ventas → detalle de una devolución de recibo → PDF y Copia
DIMENSIÓN: DOCUMENTOS · MODO
PROMETE: el recibo «no lleva RIF del emisor… un documento no fiscal no finge campos de factura» (`apps/api/src/routes/documents-pdf.ts:213-214`); ADR-0050:44.
HACE (por el código): `esRecibo = kind === "receipt"` (`documents-pdf.ts:202`) deja fuera a `receipt_return`, que se imprime como factura: el marcador `PEND01A0D5479C` de la copia del emisor (`sales.ts:1105`) se lee con prefijo «P» → «RIF: P-END01A0D5479C» (`documents-pdf.ts:93-105`), más la fila «IVA:» (`:332-335`), «(art. 13.14, PA 00071)» (`:346`), el pie de forma libre (`:392-394`) y el título «RECEIPT_RETURN» (falta en `KIND_TITULO`, `:35-42`). La web ofrece «Copia» a todo lo que no sea `receipt` (`DetalleFactura.tsx:323`).
EVIDENCIA: camino determinista en el código; sin documento todavía.
REPRODUCIR: bloque G, E1: devolver una venta con recibo → abrir la devolución → PDF y Copia.
¿SE NOTA?: la persona lo ve, en un papel que entrega al cliente
¿NECESITA DECISIÓN DEL DUEÑO?: no para el defecto · VALIDAR-SENIAT (P-16, abierto): qué leyenda lleva un recibo de devolución no fiscal

### A-07 · A · media · (todas) · cajero — un miembro sin permiso escribe en el almacenamiento antes de recibir su 403 (C)
PANTALLA: API `POST /v1/companies/logo`
DIMENSIÓN: ROLES
PROMETE: lo que cada rol puede hacer lo decide el servidor.
HACE: la ruta sube los tres objetos del logo a Storage (`apps/api/src/routes/companies.ts:321-323`) ANTES de que el caso de uso compruebe `company.settings.manage` (`packages/domain/src/company-profile.ts:265`): 403, y los objetos se quedan. `logo_path` no cambia.
EVIDENCIA: cajero en la empresa de prueba del auditor: 403 en 0,35 s y `storage.objects` del prefijo de 15 → 18.
REPRODUCIR: un usuario con rol cajero hace `POST /v1/companies/logo` con una imagen.
¿SE NOTA?: termina en verde
¿NECESITA DECISIÓN DEL DUEÑO?: no

### A-08 · A · media · E2 · dueño — el RIF no se valida (bien), pero la web decide prefijos y estructura sin fuente (F)
PANTALLA: registro «¿Cuál es el RIF?» y «Cambiar el RIF»
DIMENSIÓN: DOCUMENTOS
PROMETE: sin expresión regular mientras el formato siga en VALIDAR-SENIAT (`packages/schemas/src/companies.ts:7-12`).
HACE: acepta J-40555123-5 y J-40555123-4 para la misma base (uno de los dos dígitos verificadores es inválido); y la web fija una lista cerrada de prefijos J/V/E/G/P (`Registro.tsx:76`), interpreta «P» de dos maneras (pasaporte en `Registro.tsx:75`, no domiciliado en HANDOFF) e imprime el RIF con una estructura propia (`apps/web/src/pages/negocio/comunes.tsx:46-58`, `documents-pdf.ts:93-105`).
EVIDENCIA: `.recorrido/…/A/008-*` y `010-*`; `capturas-recorrido/A/A-10-cambiar-rif.png`
REPRODUCIR: E2 → Cambiar el RIF → J-40555123-5 → «RIF cambiado» → de vuelta a J-40555123-4.
¿SE NOTA?: termina en verde
¿NECESITA DECISIÓN DEL DUEÑO?: no — VALIDAR-SENIAT (OPEN_QUESTIONS #9, abierto): prefijos, estructura y dígito verificador del RIF

### A-09 · A · media · (todas) · fundador — elegir el rubro avanza solo; elegir «¿tienes RIF?» no (E, S)
PANTALLA: registro, «¿A qué se dedica?» y «¿Tu negocio ya tiene RIF?»
DIMENSIÓN: TECLADO · PROMESA
PROMETE: las dos pantallas enseñan un «Continuar» explícito; el rubro tiene además un `onDoubleClick={avanzar}` (`Registro.tsx:529`) que delata la intención: un clic elige, avanzar pide Continuar.
HACE: los botones de rubro no llevan `type="button"` dentro del `<form>` (`Registro.tsx:522-540`): son `submit`, y un clic, Espacio o Enter avanza sin pasar por Continuar. Los de RIF sí lo llevan (`:556`) y no avanzan.
EVIDENCIA: `capturas-recorrido/A/A-09-rubro-avanza-solo.png`, `A-09-rif-no-avanza.png`; `.recorrido/…/A/057-teclado2-paso-2.json` (`avanzoConEnter: true`) y `058-…-paso-3.json` (`false`, 2 Tabs hasta Continuar).
REPRODUCIR: en «¿A qué se dedica?», un clic en cualquier rubro → ya está en la pantalla siguiente.
¿SE NOTA?: la persona lo ve
¿NECESITA DECISIÓN DEL DUEÑO?: no (estratega-producto lo califica alta)

### A-10 · A · media · E2 · dueño — «Sin documentos emitidos, el cambio es directo» se muestra siempre, y nada recuerda actualizar el RIF ante el SENIAT (F)
PANTALLA: /admin/configuracion → Cambiar el RIF / Corregir RIF / Editar
DIMENSIÓN: PROMESA · DOCUMENTOS
PROMETE: «Sin documentos emitidos, el cambio es directo y queda auditado» (`MiEmpresa.tsx:609`).
HACE: la auditoría se cumple (`company.tax_id_changed` con anterior/nuevo, y outbox). Pero el texto es fijo: aparece también con documentos emitidos, y el servidor responde después con 422 (`company-profile.ts:206-207`). Nada avisa de que un cambio de razón social o domicilio se actualiza también en el RIF ante el SENIAT.
EVIDENCIA: `.recorrido/…/A/007-*`, `008-*`, `010-*`. El caso con documentos se comprueba tras el bloque E.
REPRODUCIR: E2 → Cambiar el RIF (texto fijo); tras el bloque E, repetir con documentos.
¿SE NOTA?: la persona lo ve
¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿se avisa de la actualización ante el SENIAT? · VALIDAR-TRIBUTARIO: plazo del COT (¿art. 155?) para actualizar el RIF, y si corregir un RIF mal tecleado obliga a reemitir lo facturado

### A-11 · A · media · E2, E3 · cualquiera — el pie de la factura cita una homologación derogada (F) — se comprueba en E
PANTALLA: PDF de factura y notas
DIMENSIÓN: DOCUMENTOS
PROMETE: la homologación fue derogada por la PA SNAT/2026/00084 sin sustituta (`docs/02_COMPLIANCE/REGULATORY_STATUS.md:21-41`).
HACE: todo documento que no es `receipt` imprime «Documento en formato libre, pendiente de homologación SENIAT (VALIDAR-SENIAT)» (`documents-pdf.ts:394`): un papel entregado al cliente cita un trámite que ya no existe, y un marcador interno.
EVIDENCIA: código; se comprueba con la primera factura de E2 en el bloque E.
REPRODUCIR: bloque E, E2: facturar → PDF → pie.
¿SE NOTA?: la persona lo ve
¿NECESITA DECISIÓN DEL DUEÑO?: sí — el texto de la leyenda · VALIDAR-SENIAT: ¿debe llevar alguna leyenda una factura en forma libre emitida por software tras la PA 00084?

### A-12 · A · media · (todas) · fundador — «Te toma menos de dos minutos», para 8 pantallas o para 11 (E)
PANTALLA: registro, bienvenida
DIMENSIÓN: PROMESA
PROMETE: «Te toma menos de dos minutos. Puedes ajustar todo después.» (`Registro.tsx:462`), antes de saber qué rama recorrerá la persona.
HACE: sin RIF son 8 pantallas; con RIF, 11 (número, razón social y dirección fiscal «tal como aparece en el RIF») (`Registro.tsx:257-270`). No se cronometró a una persona real: el argumento es estructural.
EVIDENCIA: `.recorrido/…/A/013-*` a `038-*`
REPRODUCIR: contar las pantallas de E1 frente a las de E2.
¿SE NOTA?: a mitad de camino
¿NECESITA DECISIÓN DEL DUEÑO?: sí — el tono del texto

### A-13 · A · media · E2 · dueño — no hay forma, desde dentro de Ladino, de abrir una segunda empresa (S)
PANTALLA: toda la web
DIMENSIÓN: PROMESA
PROMETE: ADR-0049:16-18 trata «crear su segunda empresa» como operación del dueño a nivel tenant; el escenario del dueño con dos empresas (E2 y E3) es un caso real.
HACE: el asistente solo aparece con `companies.length === 0` (`apps/web/src/app/session.tsx:259`); no existe «nueva empresa» en la web, y `bootstrap_tenant` impone un negocio por usuario (LAD81). En el recorrido, E3 la registró otra cuenta y el dueño de E2 entra por invitación (bloques N y O).
EVIDENCIA: búsqueda en `apps/web/src` sin resultados para crear otra empresa.
REPRODUCIR: con la sesión del dueño de E2, buscar cómo crear otra empresa.
¿SE NOTA?: la persona lo ve
¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿se ofrece crear una segunda empresa desde dentro? ¿En el mismo tenant o en otro?

### A-14 · A · baja · (todas) · dueño — cada logo nuevo deja el anterior en el almacenamiento (C)
DIMENSIÓN: DATOS · PANTALLA: Mi empresa → logo · PROMETE: nada · HACE: cada subida crea tres objetos nuevos y no borra los anteriores (`companies.ts:318-323`): cinco subidas, 15 objetos, 12 huérfanos · EVIDENCIA: `storage.objects` del prefijo de la empresa de prueba · REPRODUCIR: subir el logo cinco veces · ¿SE NOTA?: termina en verde · ¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿se conservan las versiones viejas (un PDF emitido puede apuntar a una)?

### A-15 · A · baja · E1, E2, E3 · dueño — la importación del plan de cuentas se audita como si fuera un asiento (C)
DIMENSIÓN: CONTABILIDAD · PANTALLA: ninguna (línea de tiempo de auditoría) · PROMETE: auditoría por agregado · HACE: `accounting.chart_imported` y `accounting.templates_imported` llevan `aggregate_type='journal_entry'` y el id de la EMPRESA como `aggregate_id` (`packages/domain/src/accounting.ts:114`, `:119`), en audit y outbox · EVIDENCIA: las 8 filas dan `journal_entry` con `aggregate_id = company_id` · REPRODUCIR: `select aggregate_type, aggregate_id = company_id from audit_events where event_type like 'accounting.%'` · ¿SE NOTA?: termina en verde · ¿NECESITA DECISIÓN DEL DUEÑO?: no

### A-16 · A · baja · (todas) · — — la auditoría no guarda origen: ip, dispositivo, sesión y build siempre vacíos (C) — SOSPECHA
DIMENSIÓN: DATOS · PANTALLA: ninguna · PROMETE: CLAUDE.md regla 3: «Todo documento fiscal y movimiento contable guarda autor, timestamp, origen y versión de reglas» · HACE: `ip`, `device_id`, `session_id` y `app_build` en NULL en el 100 % de las filas del bloque; `rules_version` es la constante `domain-s0.5` · EVIDENCIA: `select ip, app_build, rules_version from audit_events` · REPRODUCIR: la consulta · ¿SE NOTA?: termina en verde · ¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿«origen» es el canal (web/móvil/API) y alguien debe rellenarlo? (no se miró si algún camino los rellena)

### A-17 · A · baja · E2 · dueño (por la API) — la corrección de RIF acepta el marcador reservado «PEND-…» (F) — SOSPECHA
DIMENSIÓN: MODO · PANTALLA: `POST /v1/companies/tax-id/correct` · PROMETE: con `PEND-` la empresa no tiene RIF (`apps/web/src/app/rif.ts:15-18`) · HACE: `cambiarRif` acepta cualquier texto (`company-profile.ts:203-221`), incluso con documentos emitidos: una empresa que factura quedaría con la capa fiscal oculta; la web no puede producirlo (quita los guiones) · EVIDENCIA: código · REPRODUCIR: `POST /v1/companies/tax-id/correct` con `{"tax_id":"PEND-X","reason":"…"}` · ¿SE NOTA?: termina en verde · ¿NECESITA DECISIÓN DEL DUEÑO?: no

### A-18 · A · baja · (todas) · fundador — el teclado en el asistente: la bienvenida y los grupos de opciones (S, E)
DIMENSIÓN: TECLADO · PANTALLA: registro · PROMETE: el asistente se usa sin ratón · HACE: se completa entero con teclado y el foco se ve siempre, pero «Empezar» es el último elemento enfocable (el primer Tab saca el foco de la página) y cada opción es una parada de Tab (7 Tabs para cruzar los rubros), no un grupo con flechas · EVIDENCIA: `.recorrido/…/A/054-*` a `065-*` (campo `foco`) · REPRODUCIR: el asistente con Tab · ¿SE NOTA?: la persona lo ve · ¿NECESITA DECISIÓN DEL DUEÑO?: no

### A-19 · A · baja · E1 · dueña — la primera subida de logo tras arrancar la API tardó ~8,5 s (S, C)
DIMENSIÓN: TIEMPO · PANTALLA: Mi empresa → logo · PROMETE: — · HACE: la primera subida después de arrancar el servidor tardó ~8,5 s; las siguientes, 0,29–1,2 s en la API (medido con el tiempo de la petición). Probablemente la carga en frío del procesado de imágenes · EVIDENCIA: `.recorrido/…/A/003-E1-logo-subido.json` (9,8 s en el guion, con 1,2 s de espera fija) y `075-logo2-al-aviso.json` (`api`: 1.192 ms) · REPRODUCIR: reiniciar la API y subir un logo · ¿SE NOTA?: la persona lo ve (espera) · ¿NECESITA DECISIÓN DEL DUEÑO?: no

### Lo que se comprobó y está bien
- Los tres registros quedan completos: tenant, empresa, depósito W1, owner + warehouse_ops (79 permisos, el catálogo entero), plan de cuentas (40 cuentas, 25 plantillas) y 2 listas de precios; la pantalla coincide con la base campo a campo (C).
- **Doble clic en «Crear mi negocio»**: tres altas simultáneas → 1 × 201 y 2 × 409, un solo tenant, cero huérfanos; la web además bloquea el segundo clic (C). Hueco de tests: el doble alta solo se prueba en secuencia (`e2e-onboarding.test.ts:123`, pgTAP 041), nunca simultáneo.
- Editar el perfil y cambiar el RIF se auditan con el valor anterior y el nuevo (S, C).
- Un usuario sin empresa: `GET /v1/companies` → `[]`; con el id de otra empresa → 404 idéntico al de un id inexistente (no filtra que existe) (C).
- El asistente con teclado de principio a fin, con foco visible; a 390 px y a 1024 px en oscuro, ninguna pantalla desborda (S, E).
- E1 sin capa fiscal en el menú (F); el marcador `PEND-` no aparece en ningún texto visible del bloque (E, F).
- Invariantes al cierre, E1/E2/E3: `stock_reconciliation`, `accounting_coverage_gaps`, `inventory_coverage_gaps`, `annulled_stock_gaps` = 0; `inventory_ledger_gap` = 0; sin asientos (C).
- Tiempos: onboarding 1,07 s; logo en caliente 0,29–1,2 s; lecturas < 200 ms (C, S).

### Descartado
- «El avatar queda en blanco tras “Logo actualizado”» (E): era un instante de carga; en `074`–`076-logo2-*` la imagen está cargada al aviso y 2 s después.
- E2/E3 sin régimen tras el alta como defecto de datos (C): la base y la pantalla coinciden; lo que queda es la promesa del texto (A-02).
- El aviso de consola «flushSync was called from inside a lifecycle method» (E): conocido y documentado como benigno (`apps/web/src/ui/toast.tsx:76-80`).

### Notas del entorno (no son hallazgos del producto)
- La API arrancó al principio sin almacenamiento de imágenes y sin el worker: fue la configuración de la sesión principal. Se relanzó con `SUPABASE_STORAGE_URL/KEY` y se arrancó el worker (el outbox, 14 eventos, se publicó entero).
- auditor-codigo creó una empresa de prueba («Auditoria Doble Clic») y dos usuarios para medir el doble clic y los permisos. No forma parte del escenario ni de ningún total.

### Cierre del bloque A (validador)
GATE verde (veredicto del último gate sobre el mismo código: el recorrido no cambia código y el gate no se re-corre porque su `db:reset` borraría el escenario) · invariantes en 0 para E1, E2, E3 y la empresa de prueba: `stock_reconciliation`, `accounting_coverage_gaps`, `inventory_coverage_gaps`, `annulled_stock_gaps`, `inventory_ledger_gap`, `trial_balance`, cola de asientos y outbox (nada pendiente ni muerto). Tiempos: ninguna petición del bloque pasa de 3 s en caliente (la más lenta, la subida del logo, 1,2 s; ver A-19 para la primera en frío).

## Bloque B · Primer día (/empezar)

**Qué se hizo.** Los cuatro pasos de /empezar en las tres empresas, como su dueño: un producto con
existencia y costo, las cuentas (E1: Caja de la bodega, Caja en dólares, Banesco · E2: Banco
Mercantil, Caja Bs, Caja USD · E3: Banesco, Caja Bs, Zelle), la tasa BCV y el paso 4. E1 recorre la
rama de recibos (ya lista desde el registro); E2 y E3 la de facturas: formas libres, E2 ordinario y
E3 **especial**, IVA 16 % aceptado por el dueño, talonario de imprenta (A y B, del 1 al 5000). En E2
se saltó el paso de productos y se entró a vender antes de terminar. **Por API** (anotado): se
repitió la aceptación del IVA de E2 con otro porcentaje para confirmar B-02 — dejó un acta con 15 %
en E2.

### B-01 · B · alta · E2 · dueño — «también se puede vender describiendo la venta»: no se puede (S, E, C)
PANTALLA: /empezar, paso 1 y tarjeta final → /vender
DIMENSIÓN: PROMESA
PROMETE: «Si prefieres, hazlo después: también se puede vender describiendo la venta» (`apps/web/src/pages/negocio/Empezar.tsx:275`) y «Puedes vender describiendo la venta y cargar tus productos después» (`:239`; el diseño lo dice en `:128`).
HACE: toda línea de venta exige un producto en las tres capas: esquema (`packages/schemas/src/sales.ts:64-71`, `:366`, `:463`, `product_id` obligatorio y `.strict()`), dominio (`packages/domain/src/sales.ts:811-824`, producto activo de la empresa) y base (`document_lines.product_id` NOT NULL). El POS sin productos solo dice «No hay productos activos para vender… Toca un producto para empezar».
EVIDENCIA: `capturas-recorrido/B/B-01-vender-sin-productos.png`; `.recorrido/…/B/015-*.json`
REPRODUCIR: E2 → /empezar → «Lo hago después» → /vender.
¿SE NOTA?: la persona lo ve (llega al mostrador y no puede vender nada)
¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿se construye la línea descrita o se quita la promesa de los tres sitios? (estratega-producto lo califica **crítica**: es la salida rápida del asistente)

### B-02 · B · alta · E2 · dueño o contador — aceptar el IVA otra vez con otro porcentaje deja un acta que no se aplica (C; reproducido por S)
PANTALLA: /empezar «El IVA que cobras» y la puesta a punto fiscal
DIMENSIÓN: DATOS
PROMETE: «Al aceptar queda registrado con tu usuario y la fecha de hoy» (`apps/web/src/pages/setup/ChecklistFiscal.tsx:449-450`).
HACE: la segunda aceptación no toca las reglas vigentes (el insert es `where not exists`, `apps/api/src/routes/fiscal-setup.ts:211-224`) pero escribe el acta con el porcentaje NUEVO sin condición (`:231-237`) y responde con él. La regex del esquema acepta además «0» como alícuota de gravado (`packages/schemas/src/sales.ts:847`).
EVIDENCIA: E2 tiene dos actas `fiscal.iva.accepted`: **0.16** (21:59:52) y **0.15** (22:11:54); `tax_rules` sigue en 0.16 y `GET /v1/fiscal/setup` dice 0.16. El test existente solo reacepta con la MISMA tasa (`apps/api/test/e2e-fiscal-setup.test.ts:191-208`).
REPRODUCIR: dueño de E2 → `POST /v1/fiscal/iva-general {"rate":"0.15"}` → acta 0.15, reglas en 0.16.
¿SE NOTA?: termina en verde
¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿rechazar, cerrar la vigencia y abrir otra, o dejar acta de que no se aplicó? ¿Es «0» aceptable como alícuota general?

### B-03 · B · alta · E2, E3 · dueño — el talonario nunca dice «número de control», y la factura no llevará los datos de la imprenta (F)
PANTALLA: /empezar «Tu talonario de la imprenta» → PDF de la factura
DIMENSIÓN: DOCUMENTOS
PROMETE: «Tus facturas vienen impresas con números. Dime el primero y el último del talonario, y de qué imprenta es» (`Empezar.tsx:847-849`).
HACE: por dentro, número de factura y número de control están separados y el PDF imprime los dos (`apps/api/src/routes/documents-pdf.ts:232-238`, ADR-0037). Pero la pantalla no nombra el número de control; de la imprenta solo pide un nombre libre (`printer_source`), no su RIF ni la providencia que la autoriza ni la fecha de elaboración; y el PDF no imprime el rango ni esos datos (PA 00071 art. 13 num. 4, 15 y 16). El PDF además se entrega por WhatsApp.
EVIDENCIA: `capturas-recorrido/B/B-03-talonario-sin-control.png`; `fiscal_number_ranges` de E2 y E3: `invoice A|B 1-5000 «Gráficas Lara, C.A.»`, `next_available` = 1.
REPRODUCIR: E2 → paso 4 → talonario → facturar (bloque E) → PDF sin rango ni datos de la imprenta.
¿SE NOTA?: termina en verde
¿NECESITA DECISIÓN DEL DUEÑO?: sí — qué datos de la imprenta se registran e imprimen · VALIDAR-SENIAT: ¿el PDF generado por sistema en forma libre, enviado por medio digital, es factura válida? Si lo es, ¿debe llevar rango, RIF y providencia de la imprenta y fecha de elaboración?

### B-04 · B · media · E2, E3 · dueño — la alícuota reducida, la adicional, lo exonerado y lo no sujeto se pueden elegir y no se pueden vender (F) — no construida
PANTALLA: /admin/productos «Clasificación tributaria» → /vender
DIMENSIÓN: MODO
PROMETE: «múltiples alícuotas configurables» (`docs/02_COMPLIANCE/IVA_SPEC.md:7`); la reducida y la adicional «la empresa las acepta en el asistente con su fuente» (`:36-38`).
HACE: aceptar el IVA crea solo `gravado_general` y `exento` (`fiscal-setup.ts:204-207`); no hay otro camino que escriba `tax_rules`. Pero el producto se puede clasificar como reducida, adicional, exonerado o no sujeto (`apps/web/src/pages/catalogo/Productos.tsx:233`, `:336`), y venderlo da 409 `TAX_RULE_MISSING` (probado para la adicional en `apps/api/test/e2e-sales.test.ts:270-284`). Falla ruidosa, nunca IVA en cero. Detalle: la regla `exento` sale con la fuente «ACEPTADA por el dueño» aunque nadie declaró nada de exentos.
EVIDENCIA: código; `tax_rules` de E2: solo gravado_general 0.16 y exento 0.
REPRODUCIR: E2 → clasificar un producto como «alícuota reducida» → venderlo → 409.
¿SE NOTA?: la persona lo ve (409)
¿NECESITA DECISIÓN DEL DUEÑO?: sí — dónde se aceptan las otras alícuotas · VALIDAR-TRIBUTARIO: alícuotas reducida y adicional vigentes (norma, artículo, Gaceta); ¿la adicional va sumada a la general?; ¿exonerado y no sujeto se facturan a 0 con «(E)»?

### B-05 · B · media · E2, E3 · dueño — cargar un talonario no deja acta (C)
PANTALLA: /empezar, talonario
DIMENSIÓN: CONTABILIDAD
PROMETE: CLAUDE.md regla 3: autor, origen y versión de reglas en lo fiscal.
HACE: `POST /v1/fiscal-number-ranges` inserta en el handler de la API, fuera de un caso de uso, y no escribe `audit_events` (`apps/api/src/routes/sales.ts:744-790`). La fila tiene `created_by`; no hay rastro de quién declaró qué números de control de qué imprenta. Régimen, IVA y tipo, hechos en el mismo asistente, sí dejan acta.
EVIDENCIA: 0 filas en `audit_events` para los dos rangos (21:59:54 y 22:00:37).
REPRODUCIR: registrar un talonario → consultar `audit_events`.
¿SE NOTA?: termina en verde
¿NECESITA DECISIÓN DEL DUEÑO?: no

### B-06 · B · media · (todas) · — — la «versión de reglas» es la misma cadena desde S0.5 (C) — confirma y amplía A-16
PANTALLA: todas
DIMENSIÓN: CONTABILIDAD
PROMETE: CLAUDE.md regla 3: todo documento fiscal y movimiento contable guarda la versión de reglas.
HACE: `RULES_VERSION = "domain-s0.5"` (`packages/domain/src/create-company.ts:27`), fijada por un test (`packages/domain/src/index.test.ts:32`), en todo `audit_event` y `journal_entry`, a pesar de 67 ADR de reglas. El campo nunca va vacío, pero no distingue nada.
EVIDENCIA: `select distinct rules_version from audit_events` → solo `domain-s0.5` (24 filas del bloque); igual en los asientos de apertura.
REPRODUCIR: la consulta.
¿SE NOTA?: termina en verde
¿NECESITA DECISIÓN DEL DUEÑO?: sí — qué versiona `rules_version` y cuándo sube (pide ADR)

### B-07 · B · media · E3 · dueño — «especial» rige desde que se guarda: sin fecha de notificación ni vigencia (C, F)
PANTALLA: /empezar «Tipo de contribuyente»
DIMENSIÓN: DATOS · MODO
PROMETE: CLAUDE.md regla 8: lo tributario es efectivo por fecha y fuente; la pantalla: «Aplica a las compras y retenciones que registres desde ahora» (`apps/web/src/components/capa-fiscal/TipoDeContribuyente.tsx:107-108`).
HACE: es una columna que se sobrescribe (`packages/domain/src/igtf.ts:204-208`); la pantalla no pide fecha. Solo queda el acta con anterior/nuevo. Una operación con fecha anterior registrada después se calcularía con el tipo nuevo (SOSPECHA: no se reprodujo un cálculo).
EVIDENCIA: acta `company.taxpayer_type.set` de E3 (22:00:33, anterior null); `companies.taxpayer_type_code` = especial.
REPRODUCIR: E3 → «Especial» → confirmar.
¿SE NOTA?: termina en verde
¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿el tipo lleva vigencia? · VALIDAR-TRIBUTARIO: desde qué fecha rige la condición de especial y de agente de retención (PA 000054)

### B-08 · B · media · E2, E3 · dueño — «Formatos libres» mezcla dos medios que la PA 00071 separa (F) — SOSPECHA de lectura normativa
PANTALLA: /empezar «Facturarás con formatos libres de imprenta autorizada»
DIMENSIÓN: DOCUMENTOS
PROMETE: el régimen `formatos_libres` (`Empezar.tsx:753`; `docs/02_COMPLIANCE/EMISION_FACTURAS.md:18`).
HACE: la PA 00071 separa **formatos** (art. 30: la imprenta preimprime número y serie) de **formas libres** (art. 31: solo número de control, RIF del emisor y datos de la imprenta; nunca el número del documento). Ladino funciona como forma libre (ADR-0037:33-35). Leyendo «formatos», alguien puede registrar como talonario los números de factura preimpresos.
EVIDENCIA: `capturas-recorrido/B/B-08-aviso-maquina-fiscal.png`
REPRODUCIR: E3 → paso 4.
¿SE NOTA?: la persona lo ve sin entender la diferencia
¿NECESITA DECISIÓN DEL DUEÑO?: sí — el nombre y el artículo del régimen · VALIDAR-SENIAT: ¿la factura impresa por sistema sobre papel con control preimpreso es forma libre (art. 31) o formato (art. 30)?

### B-09 · B · media · (todas) · dueño — la tasa: «Un toque al día» y «Se actualiza sola» en la misma pantalla (E)
PANTALLA: /empezar, paso 3
DIMENSIÓN: PROMESA · TEXTO
PROMETE: «Un toque al día y todos tus precios quedan al día» (`Empezar.tsx:138`) y, dos líneas más abajo, «Se actualiza sola cada día» (`:393-395`). El diseño (ADR-0064 §1, `:372-373`) dice que se actualiza sola.
HACE: dos frases contradictorias visibles a la vez sobre si hace falta una acción diaria.
EVIDENCIA: `capturas-recorrido/B/B-09-tasa-dos-promesas.png`
REPRODUCIR: cualquier empresa → paso 3.
¿SE NOTA?: la persona lo ve
¿NECESITA DECISIÓN DEL DUEÑO?: sí — cuál queda (el código apunta a que sobra la del título)

### B-10 · B · media · E2 · dueño — el asistente no recuerda en qué paso ibas (E, S)
DIMENSIÓN: ESTADOS · PANTALLA: /empezar · PROMETE: el asistente refleja el progreso · HACE: `useState(0)` sin URL ni almacenamiento (`Empezar.tsx:68`): E2 salió a /vender y al volver estaba en PASO 1, con cuentas y régimen ya hechos después · EVIDENCIA: `capturas-recorrido/B/B-10-vuelve-al-paso-1.png` · REPRODUCIR: avanzar al paso 2+ → ir a /vender → volver · ¿SE NOTA?: la persona lo ve (no pierde datos) · ¿NECESITA DECISIÓN DEL DUEÑO?: no

### B-11 · B · media · E2, E3 · dueño — «El porcentaje lo fija la ley, no Ladino»… y la ayuda dice «hoy 16 %» fijo en la interfaz (F)
DIMENSIÓN: TEXTO · MODO · PANTALLA: /empezar «El IVA que cobras» · PROMETE: el campo va vacío a propósito para que Ladino no sugiera la cifra (`Empezar.tsx:456-458`); CLAUDE.md regla 8 · HACE: la ayuda dice «(Ley de IVA; hoy 16 %)», fijo en un componente React (`apps/web/src/components/capa-fiscal/IvaQueCobras.tsx:43`), sin fuente ni vigencia · EVIDENCIA: `capturas-recorrido/B/B-13-iva-hoy-16.png` · REPRODUCIR: paso 4 → debajo de «Porcentaje (%)» · ¿SE NOTA?: la persona lo ve · ¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿se muestra una cifra de referencia, y de dónde sale?

### B-12 · B · media · E2, E3 · dueño — el paso 4 queda en blanco mientras carga (E) — SOSPECHA por código
DIMENSIÓN: ESTADOS · PANTALLA: /empezar paso 4 · PROMETE: cada estado con su pantalla · HACE: solo pinta con `fiscal.isError` o con datos (`Empezar.tsx:106`, `:205`, `:218`); mientras `/v1/fiscal/setup` responde no hay nada. En el recorrido respondió en 60-150 ms y no se ve · EVIDENCIA: código · REPRODUCIR: red lenta → paso 4 · ¿SE NOTA?: solo con red lenta · ¿NECESITA DECISIÓN DEL DUEÑO?: no

### B-13 · B · baja · E1, E2, E3 · dueño — el alta simple guarda como «hora de la tasa» el reloj del servidor (C)
DIMENSIÓN: DINERO · PANTALLA: /empezar «Tus productos» · PROMETE: ADR-0020: los campos del hecho monetario identifican la tasa usada · HACE: `rate_timestamp` = `new Date()` de Node (`packages/domain/src/products.ts:569` → `inventory.ts:141`), mientras la entrada normal copia el instante de la fila de tasa (`inventory.ts:489-490`). Resultado: la «hora de la tasa» (21:58:25.973) queda DESPUÉS del propio movimiento (21:58:25.802). La fuente sí queda bien · EVIDENCIA: `inventory_moves` frente a `exchange_rates` de E1, E2, E3 · REPRODUCIR: alta con costo en USD y existencia · ¿SE NOTA?: termina en verde · ¿NECESITA DECISIÓN DEL DUEÑO?: no

### B-14 · B · baja · (global) · sistema — la tasa BCV del día se guarda sin acta (C)
DIMENSIÓN: DINERO · PANTALLA: arranque de la API · PROMETE: cada operación deja `audit_event` · HACE: `apps/api/src/tasa-oficial.ts:80` inserta la tasa y solo registra una línea de log (`:110`); de ella salen todas las conversiones del día · EVIDENCIA: 0 filas en `audit_events` sobre tasas · REPRODUCIR: arrancar la API con la base limpia · ¿SE NOTA?: termina en verde · ¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿la tasa del sistema es operación auditable?

### B-15 · B · baja · E2, E3 · contador — la regla dice «ACEPTADA por el dueño» aunque la acepte el contador (C) — SOSPECHA
DIMENSIÓN: ROLES · PANTALLA: /empezar y puesta a punto fiscal · PROMETE: «Alícuota declarada y ACEPTADA por el dueño» (`fiscal-setup.ts:197`) · HACE: `tax.rules.manage` lo tienen owner y accountant; el acta sí guarda el usuario real · EVIDENCIA: `role_permissions` · REPRODUCIR: aceptar como contador (bloque N) · ¿SE NOTA?: la persona lo ve · ¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿el contador puede aceptar la alícuota?

### B-16 · B · baja · (todas) · encargado — el encargado puede crear productos pero no poner precio: el alta simple le falla (C) — SOSPECHA, se prueba en N
DIMENSIÓN: ROLES · PANTALLA: /productos «Agregar producto» · PROMETE: si se ofrece, funciona · HACE: store_manager tiene `product.manage` pero no `price_list.manage` (`packages/domain/src/products.ts:383` frente a `pricing.ts:111`): el alta con precio daría 403 · EVIDENCIA: `role_permissions` · REPRODUCIR: bloque N, como encargado · ¿SE NOTA?: la persona lo ve · ¿NECESITA DECISIÓN DEL DUEÑO?: no

### B-17 · B · baja · (todas) · dueño — el paso de cuentas promete «pago móvil» y el tipo no existe (E)
DIMENSIÓN: TEXTO · PANTALLA: /empezar paso 2 · PROMETE: «Dónde te pagan: efectivo, pago móvil, tu cuenta del banco» (`Empezar.tsx:137`) · HACE: los tipos son «Caja (efectivo)», «Banco» y «Billetera digital (Zelle, USDT…)» (`apps/web/src/pages/negocio/Dinero.tsx:121-125`); el pago móvil es una FORMA de pago sobre un banco, y la pantalla no lo explica · EVIDENCIA: código · REPRODUCIR: «Agregar cuenta» → «Tipo» · ¿SE NOTA?: la persona lo ve · ¿NECESITA DECISIÓN DEL DUEÑO?: no

### B-18 · B · baja · (todas) · dueño — el teclado en /empezar: diálogos sin Enter y grupos sin flechas (E)
DIMENSIÓN: TECLADO · PANTALLA: /empezar, «Nuevo producto», «Nueva cuenta» · PROMETE: se usa sin ratón · HACE: los dos diálogos no tienen `<form>`: Enter no guarda (`negocio/Productos.tsx`, `Dinero.tsx`); las opciones del paso 4 son `role="radio"` sueltos, sin flechas ni una sola parada de Tab (`Empezar.tsx:606-632`, `:667-694`, `:700-726`) — la misma familia que A-18 · EVIDENCIA: código (sin evidencia de teclado en este bloque) · REPRODUCIR: «Agregar cuenta» → nombre → Enter · ¿SE NOTA?: la persona lo ve · ¿NECESITA DECISIÓN DEL DUEÑO?: no

### B-19 · B · baja · E3 · dueño — el aviso de máquina fiscal parafrasea mal el art. 8 de la PA 00071 (F)
DIMENSIÓN: DOCUMENTOS · PANTALLA: /empezar «Un aviso importante» · PROMETE: «ventas del año pasado sobre 1.500 UT, ventas mayormente a consumidor final y actividad listada» (`Empezar.tsx:743-747`) · HACE: la norma habla de **ingresos brutos** y de **mayor número de operaciones** con quien no usa la factura como soporte (no de importe ni de «consumidor final»). La UT sí está documentada con fuente (`IVA_SPEC.md:39-42`) · EVIDENCIA: `.recorrido/…/B/043-*.json` · REPRODUCIR: E3 → «Mitad y mitad» → «No» · ¿SE NOTA?: la persona lo ve · ¿NECESITA DECISIÓN DEL DUEÑO?: no · VALIDAR-TRIBUTARIO: ¿la condición 2 del art. 8 se mide por número de operaciones o por monto?; ¿el umbral es sobre ingresos brutos del ejercicio anterior, a la UT de qué fecha?

### Lo que se comprobó y está bien
- El alta con existencia deja producto, precio (lista `detal` en USD, la predeterminada de la caja), movimiento de inventario con su costo en VES a la tasa del día (E1: 40 × 0,80 USD = 32 USD = 27.342,8384 Bs a 854,4637) y su **asiento n.º 1 posteado** (1.1.04 Inventario contra 3.1.04 Aportes en inventario); recalculado a mano, cuadra (C).
- Las 9 cuentas de dinero tienen su cuenta contable: las de Bs a 1.1.01, las de dólares y Zelle a 1.1.02 (C).
- Una sola tasa del día, global, con fuente y sin duplicados (C).
- Régimen, IVA (4 reglas con vigencia por día de Caracas) y tipo de contribuyente con sus actas (C). E3 se declara especial sin problema en el orden normal del asistente (después del régimen) (S).
- E1 en recibos: sin IVA, sin tipo de contribuyente, sin rastro fiscal en el paso 4 (F).
- La Gaceta del régimen (G.O. 39.795 del 08/11/2011) es correcta, aunque no está anotada en `docs/02_COMPLIANCE` (F).
- Permisos por paso (C): régimen y tipo solo owner; IVA owner y accountant; talonario y cuentas owner y back_office.
- Invariantes de E1, E2, E3: todos en 0; tiempos: 224 peticiones, ninguna pasa de 3 s (la más lenta, el alta simple, 1,05 s) (C).

### Descartado
- F2 en el alta simple (devolver `err` tras escribir): `withTransaction` revierte (C).
- F1 en la vigencia del régimen: se compara con instantes, no con fechas (C).
- «El POS abre sin productos ni cuentas»: abre, pero sin productos no hay nada que cobrar; lo que falla es la promesa de B-01.

### Cierre del bloque B (validador)
GATE verde (el del último gate sobre el mismo código) · invariantes en 0 para E1, E2, E3 (incluidos `treasury_reconciliation`, mayor contra `recompute_ledger`, cola y outbox); informes `backdated_stock_in` y `money_landing_gaps` en 0 · los tres asientos de apertura posteados y cuadrados (E1 27.342,8384 · E2 538.312,131 · E3 205.071,288 Bs) · regímenes correctos · 224 peticiones, ninguna por encima de 3 s.

## Bloque C · Productos y precios

**Qué se hizo.** Cada empresa pasó de 15 productos: E1 17 · E2 20 · E3 17. Hubo altas con foto,
código de barras y existencia (desde el diálogo de /empezar), servicios, importaciones CSV (en E2,
primero un archivo con errores a propósito y después el mismo archivo otra vez) y un producto por
kilo en cada empresa. En E2 se hizo además:
- lista «mayor» con tres precios;
- cambio de precio con su historial;
- la lista predeterminada de la caja, de ida y vuelta;
- editar un producto y pausar otro;
- «vender al mayor» activado y desactivado.

En E1 y E3, el precio por kilo y un cambio de precio.

**Por API** (anotado): `sells_wholesale` de E2 se activó, se desactivó y quedó activado, porque la
web no tiene interruptor (C-06).

**Errores del guion** (no son hallazgos):
- «Recarga telefónica» de E1 quedó como bien, porque el guion pulsó el texto del interruptor.
- La Harina de E2 tiene dos vigencias iguales, por dos reintentos del guion.
- El CSV de E3 traía una coma sin comillas, y Ladino lo explicó bien.

Para demostrar C-01 quedó en E3 un producto con precio y costo erróneos: «Arandela plana 1/4», a
500 USD, con 1 unidad valorada en 125 USD.

### C-01 · C · crítica · E1, E2, E3 · dueño — la importación lee «0.500» como 500 y «0.125» como 125 (C; reproducido por S)
PANTALLA: /admin/productos → Importar
DIMENSIÓN: DINERO
PROMETE: «Números con coma decimal («9,50») o punto — las dos valen» (`apps/web/src/components/importar.tsx:212`).
HACE: un importe con punto y exactamente tres decimales se toma por separador de miles (`apps/api/src/routes/products.ts:396-402`, `leerImporte`), y en .xlsx cualquier número con tres decimales cae ahí (`apps/api/src/csv.ts:117`). El producto queda a 500 USD y su existencia con un costo 1000 veces mayor. Hay kardex y asiento, y la fila cuenta como buena. Los invariantes siguen en cero porque kardex y mayor suben juntos: el error no lo ve ningún control.
EVIDENCIA: `capturas-recorrido/C/C-01-importa-0500-como-500.png` («Entraron 1 de 1. Listo») y `C-01-la-nota-dice-que-el-punto-vale.png`. En la base, E3 «Arandela plana 1/4»: precio **500,00** USD y movimiento de 1 unidad por **125,00** USD = **106.807,96 Bs**.
REPRODUCIR: E3 → Importar un CSV con `Arandela plana 1/4,0.500,USD,ARA-14,,Tornillería,1,0.125,USD,no`.
¿SE NOTA?: termina en verde
¿NECESITA DECISIÓN DEL DUEÑO?: sí — qué hacer con un formato ambiguo («2.500»): rechazar la fila o pedir confirmación

### C-02 · C · alta · (todas) · dueño — después del primer día, dar de alta un producto son cuatro pantallas (S, E)
PANTALLA: /productos → /admin/productos → /admin/precios → /admin/llego-mercancia → ficha del producto
DIMENSIÓN: PROMESA
PROMETE: el primer día, «Agregar producto» hace en una sola pantalla foto, precio, existencia, costo y precio al mayor (`apps/web/src/pages/negocio/Productos.tsx:381-737`).
HACE: ese diálogo solo vive en /empezar, que sale del menú al terminar la puesta a punto; /productos es de solo consulta (`:173-175`). En administración, «Nuevo producto» pide SKU, tipo, unidad y clasificación, **sin precio, existencia ni foto** (`apps/web/src/pages/catalogo/Productos.tsx:212-265`). Completarlo exige cuatro guardados en cuatro pantallas. El recorrido tuvo que entrar a /empezar escribiendo la URL.
EVIDENCIA: enlaces del menú en `.recorrido/…/C/056-*.json` (ya no aparece «Empezar»).
REPRODUCIR: E2, con la puesta a punto completa → buscar dónde agregar un producto con su precio y su existencia.
¿SE NOTA?: la persona lo ve
¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿es intencional que administración sea más limitada que el alta del primer día, o falta llevar ese atajo allí?

### C-03 · C · alta · E2 · cajero/dueño — un producto pausado sigue en /productos con precio y existencia (E; confirmado por S)
PANTALLA: /productos
DIMENSIÓN: ESTADOS
PROMETE: /productos es la consulta del mostrador: lo que se ve, se vende.
HACE: la consulta no filtra por activos y ni la tarjeta ni la fila muestran el estado (`apps/web/src/pages/negocio/Productos.tsx:131-134`, `:220-244`). «Cloro caja x12», pausado, aparece como «USD 15,00 · Bs. 12.816,96 · Quedan 25». En /vender, en cambio, «Nada con ese nombre o código».
EVIDENCIA: `capturas-recorrido/C/C-03-pausado-sigue-en-productos.png` y `C-03-pausado-no-esta-en-la-caja.png`
REPRODUCIR: E2 → /admin/productos → «Cloro caja x12» → Estado Inactivo → /productos: aparece; /vender: no.
¿SE NOTA?: la persona lo ve, tarde y sin explicación
¿NECESITA DECISIÓN DEL DUEÑO?: no

### C-04 · C · alta · (todas) · dueño — una importación grande agota el tiempo, dice «No se pudo leer el archivo» y sigue creando; al reintentar, duplica (C) — SOSPECHA
PANTALLA: /admin/productos → Importar
DIMENSIÓN: TIEMPO · DATOS
PROMETE: «Máximo 500 filas» (`importar.tsx:214`).
HACE: el bucle es secuencial, con una transacción por fila (`products.ts:414-510`), y cuesta ~200 ms por fila con existencia: 10-11 filas tardaron 2,2 s. Por encima de ~150 filas se pasa de los 30 s de la API (`apps/api/src/config.ts:132`): la persona recibe 504 y el aviso «No se pudo leer el archivo» (`importar.tsx:84`), mientras el servidor sigue creando productos con su kardex y su asiento (`apps/api/src/middleware/timeout.ts:5-7`). La ruta no lleva Idempotency-Key (`products.ts:335`) y no hay índice único por nombre: al reintentar, las filas sin «Código» se duplican con existencia y asiento.
EVIDENCIA: 200 ms por fila medidos (`node scripts/recorrido/tiempos.mjs C`); 500 filas ≈ 100 s es extrapolado y no se ejecutó (crearía cientos de productos).
REPRODUCIR: importar 300 filas sin código → 504 hacia los 30 s → contar productos → reimportar.
¿SE NOTA?: la persona ve un error falso; el duplicado termina en verde
¿NECESITA DECISIÓN DEL DUEÑO?: sí — bajar el tope, importar en segundo plano o deduplicar

### C-05 · C · media · E2 · dueño — la importación descarta en silencio la existencia de un servicio (y el costo de una fila sin existencia) (S, E, C)
PANTALLA: Importar
DIMENSIÓN: DATOS
PROMETE: «Las filas buenas entran; las malas se explican con su número» (`apps/web/src/pages/catalogo/Productos.tsx:154`).
HACE: con «Es servicio: sí» la existencia no se lee (`apps/api/src/routes/products.ts:449-454`) y la guarda del dominio que la rechazaría no llega a verla (`packages/domain/src/products.ts:427-432`). La fila cuenta como creada. Lo mismo pasa con el costo de una fila sin existencia. Los mensajes de las filas malas, en cambio, son claros y van numerados.
EVIDENCIA: `capturas-recorrido/C/C-05-importacion-con-errores.png`. «Transporte especial»: `kind=service` y 0 movimientos, aunque el CSV decía existencia 10.
REPRODUCIR: importar `Transporte especial,"50,00",USD,ERR-7,,Servicios,10,,,sí`.
¿SE NOTA?: termina en verde
¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿se rechaza la fila o se acepta con un aviso?

### C-06 · C · media · E2 · dueño — «vender al mayor» no tiene interruptor, y activarlo no cambia la caja (S, C)
PANTALLA: /empezar, /admin/configuracion, /admin/precios
DIMENSIÓN: PROMESA
PROMETE: el escenario del dueño («vender al mayor activado y desactivado»); /empezar pregunta «¿A quién le vendes principalmente? A negocios y empresas».
HACE:
- `sells_wholesale` solo se lee en la web (`Precios.tsx:55`, `negocio/Productos.tsx:415`). Se cambia por `PUT /v1/company-settings`, que exige `company.settings.manage` (solo el dueño).
- E2 contestó «A negocios y empresas» y siguió en `false`.
- Activarlo solo hace dos cosas: muestra el campo «Precio al mayor», que se guarda en la lista «mayor» (17 frente a 20 del detal), y pinta una etiqueta en la lista. La caja elige el precio por la lista del cliente o la predeterminada (`packages/domain/src/sales.ts:987-998`), no por este ajuste.
EVIDENCIA: `capturas-recorrido/C/C-06-precio-al-mayor.png`; activado y desactivado por API.
REPRODUCIR: buscar en la web dónde activar «vender al mayor».
¿SE NOTA?: la persona lo ve (no lo encuentra)
¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿dónde se activa, y qué debe cambiar en la caja cuando está activo?

### C-07 · C · media · (todas) · dueño — ningún producto puede llevar lote ni vencimiento: la parte de la llegada que los pide no se enciende nunca (S, C) — no construida
PANTALLA: /admin/productos; /admin/llego-mercancia
DIMENSIÓN: PROMESA
PROMETE: la llegada pide «Código del paquete» y «Se vence el» («El que trae impreso la caja: con él se avisa antes de que se venza») (`apps/web/src/pages/negocio/LlegoMercancia.tsx:849-890`). Existen los triggers de lote, FEFO e `inventory.expired`.
HACE: `CreateProductRequest` y `UpdateProductRequest` son `.strict()` y no traen `tracks_lots` ni `tracks_expiry` (`packages/schemas/src/products.ts:19-41`, `:50-55`), y ninguna ruta los escribe. De 53 productos hay 0 con lote y 0 con vencimiento, y 0 lotes.
EVIDENCIA: consulta a `products`; `PATCH /v1/products/:id {"tracks_lots":true}` → 400.
REPRODUCIR: intentar crear el producto del escenario «con lote y vencimiento».
¿SE NOTA?: la persona lo ve (no puede)
¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿se construye el interruptor o se quita la rama?

### C-08 · C · media · (todas) · encargado — el encargado ve «Importar» y «Nuevo producto» y todo le falla por no poder poner precios (C) — SOSPECHA, se comprueba en N (amplía B-16)
DIMENSIÓN: ROLES · PANTALLA: /admin/productos · PROMETE: el botón visible funciona · HACE: store_manager tiene `product.manage` pero no `price_list.manage`; toda fila importada lleva precio y falla en `setPrice` (`packages/domain/src/pricing.ts:111`): «Entraron 0 de N» · EVIDENCIA: `role_permissions` · REPRODUCIR: bloque N, como encargado · ¿SE NOTA?: la persona lo ve · ¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿el encargado pone precios o no ve el botón?

### C-09 · C · media · (todas) · cajero — la foto del producto se procesa y se guarda antes de comprobar el permiso (C) — SOSPECHA; mismo patrón que A-07 y A-14
DIMENSIÓN: ROLES · DATOS · PANTALLA: `POST /v1/products/:id/image` · PROMETE: «la limpieza es un job aparte» (`apps/api/src/routes/products.ts:319-320`) · HACE: la API procesa la imagen y sube tres objetos (`:245-304`) antes de comprobar `product.manage` y que el producto exista (`packages/domain/src/products.ts:331`, `:339`); con 403 o 404 quedan huérfanos, y el job de limpieza no existe (`apps/worker/src`) · EVIDENCIA: orden del código · REPRODUCIR: como cajero, subir foto a un id inventado → 404 y 3 objetos en el almacenamiento · ¿SE NOTA?: termina en verde · ¿NECESITA DECISIÓN DEL DUEÑO?: no

### C-10 · C · media · (todas) · dueño — la foto del producto no se puede arrastrar (S)
DIMENSIÓN: PROMESA · FORMA · PANTALLA: «Nuevo producto» · PROMETE: el escenario pide «alta con foto (arrastrar y cámara)»; el recuadro dice «Agregar foto» · HACE: solo el logo del registro acepta soltar un archivo (`apps/web/src/pages/registro/Registro.tsx:1039`); en el producto, la foto soltada no quedó. La cámara no se puede probar sin pantalla (el `input` omite `capture` a propósito para ofrecer cámara y galería) · EVIDENCIA: `capturas-recorrido/C/C-10-foto-arrastrada-no-queda.png` · REPRODUCIR: soltar una imagen sobre «Agregar foto» · ¿SE NOTA?: la persona lo ve · ¿NECESITA DECISIÓN DEL DUEÑO?: no

### C-11 · C · media · E1, E2 · dueño — el historial de precios enseña en Bs la conversión de HOY, también para los precios viejos (E) — SOSPECHA de comprensión
DIMENSIÓN: PROMESA · TEXTO · PANTALLA: /admin/precios · PROMETE: el texto lo dice con honestidad: «La columna en Bs es la conversión de hoy, como referencia… también para los precios anteriores» (`apps/web/src/pages/catalogo/Precios.tsx:70`, `:356-367`) · HACE: una fila vieja se ve igual que una de hoy; nada distingue «reconversión de hoy» de «lo que se cobró». Además toda lista es en USD, sin opción en Bs (`:186-188`, `:222`), también para una bodega que piensa en bolívares · EVIDENCIA: `capturas-recorrido/C/C-11-historial-de-precios.png` · REPRODUCIR: dos vigencias del mismo producto → comparar la columna Bs · ¿SE NOTA?: no se nota · ¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿anclar siempre en USD (ADR-0046) sigue siendo lo correcto para un negocio que piensa en bolívares?

### C-12 · C · baja · E2 · dueño — un precio programado a futuro impide cambiar el de hoy, con un mensaje que dice «período ya cerrado» (C) — SOSPECHA
DIMENSIÓN: DATOS · PANTALLA: /admin/precios · PROMETE: «Vigente desde» · HACE: el autocierre solo cierra una vigencia abierta que empezó antes (`supabase/migrations/20260825150000_create_price_lists.sql:161-166`); un precio para mañana más otro «ahora» choca con la exclusión, y el mensaje habla de período cerrado (`packages/domain/src/pricing.ts:162-168`) · EVIDENCIA: DDL · REPRODUCIR: cargar un precio para mañana y luego otro sin fecha · ¿SE NOTA?: la persona lo ve · ¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿qué hacer con los precios programados?

### C-13 · C · baja · E2 · dueño — la vigencia del precio empieza con el reloj del navegador o del servidor, no con el de la base (C)
DIMENSIÓN: TIEMPO · PANTALLA: /admin/precios · PROMETE: «Vacío = ahora mismo» · HACE: el instante sale del navegador (`Precios.tsx:412`) o de Node (`packages/domain/src/products.ts:636`, `:686`) y se consulta contra `now()` de la base (`apps/api/src/routes/products.ts:172-173`). Un navegador adelantado programa el precio sin decirlo, y la caja cobra el anterior hasta esa hora · EVIDENCIA: Aceite de E2: la vigencia empieza 127 ms después de insertarse la fila · REPRODUCIR: con el reloj del PC adelantado, cargar un precio y vender · ¿SE NOTA?: termina en verde · ¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿«ahora» lo fija el servidor?

### C-14 · C · baja · E2 · dueño — un reintento de «Cargar precio» abre otra vigencia igual (S, C)
DIMENSIÓN: DATOS · PANTALLA: /admin/precios · PROMETE: idempotencia en las operaciones · HACE: la clave de idempotencia se genera en cada intento (`Precios.tsx:416`), no por intención: la Harina a 22,00 tiene dos vigencias seguidas. Aguas abajo no hace daño (la exclusión deja una sola vigente), pero ensucia el historial y la auditoría · EVIDENCIA: lista «mayor» de E2 · REPRODUCIR: cargar el mismo precio dos veces · ¿SE NOTA?: termina en verde · ¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿rechazar un precio igual al vigente?

### Lo que se comprobó y está bien
- La importación va fila a fila en su propia transacción: una fila mala no se lleva las buenas. Los mensajes de las filas malas son de persona y van numerados. Reimportar el mismo archivo no duplica (repetidos rechazados por SKU). El CSV con «;» (Excel en español) se reconoce solo, según el código (`apps/api/src/csv.ts:17-29`, no probado en vivo) (S, E, C).
- Cada bien con existencia (del alta o importado) tiene su movimiento `inventario-inicial` y su asiento; los servicios y los bienes sin existencia, ninguno (C).
- Las vigencias de precio: el cierre es atómico, las vigencias no se solapan ni dejan huecos, y la vieja cierra en el mismo instante en que abre la nueva (28 → 29 del aceite). «Vigente desde» se interpreta en hora de Caracas (C, S).
- Pausar saca el producto de la caja. El precio al mayor va a la lista «mayor». Cambiar la lista predeterminada de la caja pide confirmación y avisa (S).
- Los productos por kilo se crean con unidad kg y su precio por kilo (S).
- Invariantes de E1, E2 y E3 en 0; 593 peticiones y ninguna pasa de 3 s (las importaciones, 2,2 s) (C).

### Descartado
- F2 en la importación (una fila que falla deja algo escrito): `withTransaction` revierte (C).
- Dos precios vigentes a la vez: los impide la exclusión (C).

### Pendiente para otros bloques
- El cliente marcado al mayor (lista preferida): bloque E.
- La cámara, sin pantalla: no se puede probar.

### Cierre del bloque C (validador)
GATE verde (el del último gate sobre el mismo código) · invariantes en 0 para E1, E2, E3 · un movimiento `inventario-inicial` por producto con existencia y sus asientos cuadrados · ninguna lista con dos precios vigentes del mismo producto · 628 peticiones, máximo 2,2 s (importar). **Nota:** los invariantes en cero no detectan C-01 — el kardex inflado y su asiento suben juntos; por eso C-01 «termina en verde».

## Bloque D · Llegada de mercancía

**Qué se hizo.** Se recorrieron los caminos de /admin/llego-mercancia (ADR-0066, «la única puerta»),
con la dueña o el dueño de cada empresa.

- **E2:**
  - con factura, en USD y a crédito: tres líneas, por unidad, por total y por kilo;
  - «Todavía no me la dan» (hoy), y después «Falta la factura» → «Ya llegó la factura»;
  - «No va a haber factura», pagada en efectivo de una caja vacía (sobregiro confirmado);
  - «Ya era mía».
- **E1:** «Ya era mía» por kilo. **Ninguna compra a proveedor fue posible (D-01).**
- **E3:** con factura, en USD y a crédito, para pagarla con retenciones en el bloque H.

Hubo que cambiar el plan en dos puntos:
- A los proveedores «sin RIF» del escenario se les puso una cédula (V-…), porque la pantalla los rechaza (D-04).
- La llegada fechada ayer no se pudo registrar (D-09).

**Pendiente para después**, porque no hay con qué probarlo todavía:
- la fecha hacia atrás CON ventas intermedias (tras el bloque E);
- el almacenista recibiendo (bloque N);
- el paso «¿A qué depósito?» con dos depósitos (bloque I).

### D-01 · D · crítica · E1 · dueña — una bodega sin RIF no puede registrar ninguna compra a un proveedor (S, E, C)
PANTALLA: /admin/llego-mercancia
DIMENSIÓN: PROMESA · MODO
PROMETE: ADR-0066: «una empresa sin RIF también recibe mercancía» y «el sistema deriva el asiento»; la tarjeta «No va a haber factura: entra al costo que pagaste».
HACE: el servidor rechaza cualquier compra a un proveedor, **también «No va a haber factura»**: «Falta el tipo de contribuyente de la empresa… Decláralo en Configuración → Mi empresa → Tipo de contribuyente» (`packages/domain/src/purchases.ts:855-861`). Lo exige antes de mirar si hay factura, y sin factura el IVA ni siquiera cuenta (`:869-871`). Para una empresa sin RIF, Mi empresa **no muestra** el tipo de contribuyente (`apps/web/src/pages/configuracion/MiEmpresa.tsx:228-267`): la salida que da el mensaje no existe. La API sí dejaría fijarlo (`PUT /v1/companies/taxpayer-type`, «ordinario» en cualquier modo, `packages/domain/src/igtf.ts:192-199`); entonces una empresa sin RIF podría registrar crédito fiscal.
EVIDENCIA: `capturas-recorrido/D/D-01-E1-no-puede-comprar.png`; `.recorrido/…/D/061-*.json` (422 con el mensaje completo)
REPRODUCIR: E1 → Llegó mercancía → proveedor (V-10999888) → Harina 40 por total 36.000 Bs → «No va a haber factura» → pagada en efectivo → registrar.
¿SE NOTA?: la persona lo ve, y no tiene salida
¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿una empresa sin RIF declara tipo de contribuyente, o el camino de proveedor no se lo pide? · VALIDAR-TRIBUTARIO: si una empresa sin RIF queda como «ordinario», ¿puede registrar crédito fiscal de una compra con factura?

### D-02 · D · alta · E2 · dueño — pagar en bolívares una factura en dólares es imposible, y la pantalla lo propone (S, E, C)
PANTALLA: /admin/llego-mercancia, «¿Ya la pagaste?»
DIMENSIÓN: DINERO · PROMESA
PROMETE: ADR-0067: «si hay más de una candidata se pregunta, y sin preseleccionar ninguna».
HACE: para una factura en USD pagada por transferencia, la única candidata fue «Banco Mercantil» (VES); la pantalla la usó sin preguntar, y el resumen solo dice «Ya está pagada». Al confirmar: «El pago es en USD y la cuenta «Banco Mercantil» vive en VES». El dominio exige que el pago vaya en la moneda de la factura y desde una cuenta de esa moneda (`packages/domain/src/purchases.ts:2009-2014`, `:2114-2119`). No hay pago cruzado: el propio código lo admite («mientras no exista el pago cruzado», `:2005-2008`). Pagar en bolívares a la tasa BCV una factura en dólares es de lo más común en Venezuela.
EVIDENCIA: `capturas-recorrido/D/D-02-usd-desde-banco-en-bs.png`
REPRODUCIR: E2 → con factura en USD → «Sí, ya la pagué» → Transferencia → registrar.
¿SE NOTA?: la persona lo ve, al final del recorrido
¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿se construye el pago cruzado USD↔Bs? Mientras tanto, ¿las candidatas se filtran por moneda?

### D-03 · D · alta · (todas) · dueño — tras un error, corregir y confirmar dice «ya se registró con otros datos», y no se registró nada (C; reproducido por S)
PANTALLA: /admin/llego-mercancia
DIMENSIÓN: ESTADOS · TEXTO
PROMETE: la clave nace al entrar «para que un doble clic o un reintento no creen dos llegadas» (`apps/web/src/pages/negocio/LlegoMercancia.tsx:39-40`).
HACE: la clave es fija para toda la pantalla (`:144`). Tras CUALQUIER error del servidor (tasa, tipo de contribuyente, moneda de la cuenta…), si la persona corrige un dato y confirma, el cuerpo cambia con la misma clave → 409 `IDEMPOTENCY_KEY_REUSED` (`apps/api/src/middleware/idempotency.ts:250`), y el aviso dice «Esa operación ya se registró con otros datos. Revisa si quedó hecha antes de repetirla». **No se registró nada**: la factura 000124 no está en la base. La única salida es salir de la pantalla y empezar de cero. Solo el sobregiro usa una clave aparte.
EVIDENCIA: `capturas-recorrido/D/D-03-corregir-dice-ya-se-registro.png`; `supplier_invoices` con número 000124 = 0. El mecanismo también lo reproduce el test existente `apps/api/test/e2e-llegada.test.ts:840-851`.
REPRODUCIR: E2 → factura 000124 en USD → pagada desde Banco Mercantil → error → «Atrás» → «No, quedo debiendo» → registrar.
¿SE NOTA?: la persona lo ve, y el mensaje le dice lo contrario de lo que pasó
¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿clave nueva cuando cambia el cuerpo, o reutilizar una reserva fallida?

### D-04 · D · alta · E1, E2 · dueño — «Cédula o RIF: puede quedar vacío», y sin RIF el proveedor no se guarda (S, E)
PANTALLA: /admin/llego-mercancia, «Nuevo» proveedor
DIMENSIÓN: PROMESA
PROMETE: «Cédula o RIF — Si te la dio. Puede quedar vacío.» (`LlegoMercancia.tsx:691`)
HACE: «No se pudo agregar el proveedor. Un proveedor nacional necesita RIF: sin él no se puede llevar al libro de compras ni practicarle retención». Pasó con dos proveedores informales del escenario, y para una compra «No va a haber factura», que no va al libro. Hubo que inventarles una cédula.
EVIDENCIA: `capturas-recorrido/D/D-04-proveedor-sin-rif-rechazado.png`
REPRODUCIR: Llegó mercancía → Proveedor → Nuevo → solo el nombre → Agregar.
¿SE NOTA?: la persona lo ve
¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿miente la ayuda, o sobra la regla para el proveedor informal sin factura?

### D-05 · D · alta · E2, E3 · dueño — la llegada suma el IVA a lo que la persona escribe, y en ningún momento enseña un importe (S, E, C)
PANTALLA: /admin/llego-mercancia, «¿Qué llegó?» y «¿Todo bien?»
DIMENSIÓN: DINERO · PROMESA
PROMETE: «¿Cuánto te costó cada una?», sin decir con o sin IVA; «¿Todo bien?» como confirmación.
HACE: el precio se trata como **neto** y el IVA se suma encima (`packages/domain/src/purchases.ts:1013-1023`): la persona escribió 18,00 y la factura quedó en 1.110,00 + 177,60 de IVA = 1.287,60 USD. Si copia del papel el precio con IVA incluido, el IVA se cuenta dos veces: deuda y crédito fiscal inflados. «¿Todo bien?» no enseña ningún importe, ni subtotal, ni IVA, ni total: «Queda debiendo: aparece en «Lo que debo»», sin decir cuánto.
EVIDENCIA: `capturas-recorrido/D/D-05-todo-bien-sin-importes.png`; factura 000123: 1.110,00 + 177,60 = 1.287,60 USD
REPRODUCIR: E2 → factura con 3 líneas → llegar a «¿Todo bien?»
¿SE NOTA?: termina en verde
¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿el precio se pide con o sin IVA, y lo dice la pantalla? ¿El resumen enseña el total que calcula el servidor?

### D-06 · D · alta · E2 · dueño — «Ya llegó la factura» no deja poner el precio de la factura: la revalorización que promete el código no se alcanza (S, E)
PANTALLA: /compras → «Falta la factura» → «Ya llegó la factura»
DIMENSIÓN: PROMESA
PROMETE: «Si el precio de la factura difiere del de la recepción, el servidor revaloriza el inventario (ADR-0060 §2)» (`apps/web/src/pages/negocio/Compras.tsx:942-947`).
HACE: el diálogo solo pide número de factura y de control (`:1006-1016`), y la mutación manda siempre el precio de la recepción (`:976-994`). Si el proveedor facturó otro precio, no hay cómo registrarlo. La diferencia de TASA entre recepción y factura sí se revaloriza (`packages/domain/src/purchases.ts:1257-1365`).
EVIDENCIA: `capturas-recorrido/D/D-06-ya-llego-la-factura-sin-precio.png`; «Factura registrada. Lo que recibiste ya está facturado» (La Montaña, LM-5501)
REPRODUCIR: E2 → «Todavía no me la dan» → Compras → «Falta la factura» → «Ya llegó la factura».
¿SE NOTA?: termina en verde
¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿se agrega el precio al diálogo o se descarta la revalorización por precio?

### D-07 · D · alta · E2, E3 · dueño — pagar otro día una factura en USD no reconoce el diferencial cambiario (C) — SOSPECHA, se prueba en H
PANTALLA: pago a proveedor
DIMENSIÓN: CONTABILIDAD · DINERO
PROMETE: en ventas el diferencial existe (`packages/domain/src/sales.ts:2334-2501`).
HACE: la plantilla `payment_made` tiene dos líneas (CxP contra caja, por el neto) y ninguna de diferencial (`packages/domain/src/purchases.ts:2248-2266`). La deuda se registró a 854,4637; si se paga con otra tasa, queda un residuo en Bs escondido en Cuentas por pagar, con el saldo en USD en cero. Ningún invariante lo ve.
EVIDENCIA: lectura del código y de las líneas de la plantilla de E2
REPRODUCIR: bloque H: pagar la factura 000123 con una tasa distinta
¿SE NOTA?: termina en verde
¿NECESITA DECISIÓN DEL DUEÑO?: sí · VALIDAR-CONTABLE: a qué cuenta va el diferencial cambiario de las compras

### D-08 · D · alta · (todas) · cualquiera — «Ya era mía» fechada hoy falla si se registra antes de las 08:00 de Caracas (C) — SOSPECHA, familia F1
PANTALLA: /admin/llego-mercancia, «Ya era mía»
DIMENSIÓN: TIEMPO
PROMETE: `packages/domain/src/inventory.ts:471-475`: «el default NO es el reloj… el CHECK `occurred_at <= created_at` lo rechaza — siempre».
HACE: `occurred_at = ${fecha}T12:00:00.000Z` (`packages/domain/src/arrivals.ts:259`; también `:300` y `:402`), las 08:00 de Caracas. Antes de esa hora, `occurred_at` queda después de `created_at` y el CHECK rechaza con un error genérico. Es la quinta aparición de la familia en CLAUDE.md §3: «si el test pasa a las tres de la tarde y falla a las 23:59, es este bug».
EVIDENCIA: el CHECK y el trigger; no se ejecutó a esa hora
REPRODUCIR: a las 07:30 de Caracas → «Ya era mía», 1 unidad
¿SE NOTA?: la persona lo ve (solo de madrugada)
¿NECESITA DECISIÓN DEL DUEÑO?: no

### D-09 · D · alta · E2 · dueño — la llegada de ayer no se puede registrar en una empresa nueva, y la pantalla lo sabe antes y no lo impide (S, E)
PANTALLA: /admin/llego-mercancia, «¿Qué día llegó?»
DIMENSIÓN: ESTADOS
PROMETE: el selector deja elegir hasta dos días atrás; «Si fue hace más de dos días, regístralo como ajuste de inventario».
HACE: con fecha de ayer, «¿Qué llegó?» avisa «No hay tasa del BCV para el 23/09/2026. Tráela en Mi dinero y vuelve.», pero «Seguir» no se bloquea, el resumen no lo repite y el registro falla al final (409 `EXCHANGE_RATE_MISSING`). En una empresa que empezó hoy no existe la tasa de ayer. ¿Se puede traer una tasa pasada en Mi dinero? Se comprueba en el bloque J.
EVIDENCIA: `capturas-recorrido/D/D-09-sin-tasa-de-ayer.png`; `.recorrido/…/D/040-*.json`
REPRODUCIR: E2 → llegada con fecha de ayer → registrar
¿SE NOTA?: la persona lo ve, pero solo al final
¿NECESITA DECISIÓN DEL DUEÑO?: no

### D-10 · D · media · E2 · dueño — el kardex queda desordenado: «Ya era mía» de hoy aparece antes que movimientos anteriores del mismo día (C) — familia F1
DIMENSIÓN: DATOS · PANTALLA: kardex · PROMETE: el orden del kardex es el del cálculo del costo · HACE: la misma `12:00Z` (`arrivals.ts:259`) coloca la entrada de las Galletas surtidas (saldo después: 30) antes del inventario inicial de las 22:22Z (saldo después: 20); leído por `occurred_at`, la cadena de saldos es incoherente. Las recepciones de proveedor van con `now()` y su `received_at` con 12:00Z: dos relojes para un mismo hecho · EVIDENCIA: `inventory_moves` de Galletas surtidas en E2, ordenado por `occurred_at` → 30 y luego 20 · REPRODUCIR: la consulta · ¿SE NOTA?: termina en verde · ¿NECESITA DECISIÓN DEL DUEÑO?: no

### D-11 · D · media · E2 · dueño — confirmar un sobregiro no queda auditado ni pide permiso (C)
DIMENSIÓN: CONTABILIDAD · ROLES · PANTALLA: «No alcanza el saldo» → «Registrarlo igual» · PROMETE: ADR-0062 §4 «se confirma, no se cuela»; regla 3 · HACE: el acta `ap.payment_made` no guarda la cuenta ni que se permitió el negativo (`packages/domain/src/purchases.ts:2222-2237`); basta con que el cuerpo lo pida (`packages/domain/src/treasury.ts:167`), sin permiso propio · EVIDENCIA: el acta del pago de E2 de las 23:04:08 · REPRODUCIR: sobregirar y leer el acta · ¿SE NOTA?: termina en verde · ¿NECESITA DECISIÓN DEL DUEÑO?: sí — ¿sobregirar exige un permiso?

### D-12 · D · media · E1 · dueña — a una empresa sin RIF se le ofrece «entra al libro de compras y da crédito fiscal» (E, S)
DIMENSIÓN: MODO · PANTALLA: «¿Tienes la factura?» · PROMETE: ADR-0066 §4: la puerta no lleva marca fiscal porque la empresa sin RIF también recibe · HACE: las tres tarjetas se filtran solo por el permiso del ROL (`LlegoMercancia.tsx:165-166`, `:971`), no por si la EMPRESA tiene RIF; E1 ve «Sí, aquí está: entra al libro de compras y su IVA cuenta como crédito fiscal» · EVIDENCIA: `capturas-recorrido/D/D-12-tarjetas-fiscales-a-E1.png` · REPRODUCIR: E1 → proveedor → «¿Tienes la factura?» · ¿SE NOTA?: la persona lo ve · ¿NECESITA DECISIÓN DEL DUEÑO?: no (sigue de D-01)

### D-13 · D · media · E2 · dueño — el aviso de sobregiro enseña «120000.00000000» (S, E)
DIMENSIÓN: TEXTO · DINERO · PANTALLA: «No alcanza el saldo» · PROMETE: los importes se formatean para la persona · HACE: el mensaje llega del servidor con 8 decimales (`packages/domain/src/treasury.ts:180`) y se pinta tal cual (`apps/web/src/components/sobregiro.tsx:45`): «“Caja Bs” tiene 0 VES y esta operación saca 120000.00000000» · EVIDENCIA: `capturas-recorrido/D/D-13-sobregiro-importe-crudo.png` · REPRODUCIR: pagar desde una caja vacía · ¿SE NOTA?: la persona lo ve · ¿NECESITA DECISIÓN DEL DUEÑO?: no

### D-14 · D · media · E2 · cualquiera — «¿A qué depósito?» atrapa al teclado: Enter elige pero no avanza, y no hay «Seguir» (E) — SOSPECHA, se prueba en I
DIMENSIÓN: TECLADO · PANTALLA: /admin/llego-mercancia, con dos depósitos · PROMETE: tarjetas `role="button"` que responden a Enter · HACE: `onClick` elige y avanza; `onKeyDown` solo elige (`LlegoMercancia.tsx:1108-1134`), y el paso no tiene botón «Seguir» · EVIDENCIA: código (no se dispara con un solo depósito) · REPRODUCIR: bloque I, con el segundo depósito de E2 · ¿SE NOTA?: la persona queda atascada · ¿NECESITA DECISIÓN DEL DUEÑO?: no

### D-15 · D · baja · E2, E3 · — — la línea de factura de proveedor mezcla la base sin IVA con el total con IVA (C)
DIMENSIÓN: DINERO · HACE: `amount_transaction_currency` guarda la base y `functional_amount` el total con IVA × tasa (`packages/domain/src/purchases.ts:1051-1053`); F-88771, línea 1: 80,00 × 854,4637 = 68.357,10, pero `functional_amount` = 79.294,23. Hoy nada lo lee · ¿SE NOTA?: termina en verde · ¿NECESITA DECISIÓN DEL DUEÑO?: no

### D-16 · D · baja · E2 · — — el pago a proveedor no enlaza su asiento; una categoría sin regla daría un error de JavaScript (C) — SOSPECHA
DIMENSIÓN: DATOS · HACE: el pago de E2 tiene `journal_entry_id` NULL aunque su asiento existe y apunta a él; `regla!.tax_rule_id` (`purchases.ts:1008`) lanzaría un TypeError sin traducir si `resolve_tax` no devuelve regla · ¿SE NOTA?: termina en verde / la persona lo ve · ¿NECESITA DECISIÓN DEL DUEÑO?: no

### D-17 · D · baja · E2 · dueño — «Se la compraste a Alimentos del Centro, C.A..» (S, E)
DIMENSIÓN: TEXTO · HACE: el punto final se agrega aunque la razón social ya termine en punto (`LlegoMercancia.tsx:1150-1155`) · ¿SE NOTA?: la persona lo ve · ¿NECESITA DECISIÓN DEL DUEÑO?: no

### D-18 · D · baja · (todas) · cualquiera — «No, quedo debiendo» con teclado pide un paso más que con el ratón (E)
DIMENSIÓN: TECLADO · HACE: `onKeyDown` elige pero no avanza (`LlegoMercancia.tsx:1041-1045`); hay «Seguir», así que es fricción, no bloqueo · ¿NECESITA DECISIÓN DEL DUEÑO?: no

### No construido (no son errores)
- Crear un producto «al vuelo» en la llegada: el selector de producto no ofrece crear (`apps/web/src/components/forms.tsx`, EntityPicker).
- Lote y vencimiento: ver C-07.
- Producto con receta: nada marca un producto como compuesto (bloque I).

### Lo que se comprobó y está bien
- La contabilidad de las compras cuadra al céntimo (C):
  - la recepción va a Inventario contra «Mercancía recibida por facturar»;
  - la factura, a esa cuenta más IVA crédito fiscal contra Cuentas por pagar;
  - «Mercancía recibida por facturar» vuelve a cero, también en la de «Falta la factura»;
  - la diferencia de tasa entre recepción y factura se revaloriza.
- El precio por total (Arroz 440 / 20 = 22,00) y por kilo (5,20/kg) quedan exactos. La compra sin factura va sin IVA, como exige la base (C).
- El kardex de E3 en VES es cómo se guarda (la moneda de captura va en la línea de recepción), no un error (C).
- El sobregiro se confirma con su diálogo propio y queda registrado; la caja y el mayor coinciden (S, C).
- Los mensajes de error están en lenguaje de persona, salvo el importe crudo de D-13 (E).
- Invariantes de E1, E2, E3 en 0. Hubo 293 peticiones, ninguna por encima de 0,6 s (S, C).

### Cierre del bloque D (validador)
GATE verde (el del último gate sobre el mismo código) · invariantes en 0 para E1, E2, E3 · «Mercancía recibida por facturar» de E2 en 0 y las facturas con soporte con su asiento cuadrado · 293 peticiones, ninguna por encima de 3 s (la más lenta, la llegada, 0,58 s).

---

## Bloque E · Vender

**Qué se hizo.** Todas las ventas en la caja (/vender), con la dueña o el dueño de cada empresa.

- **E1 (recibos):**
  - R-1 sin identificar, en efectivo Bs;
  - R-2 con lector de código de barras (arrastró líneas de pasadas fallidas del guion: error del GUION, no de Ladino);
  - R-3 con una segunda cuenta abierta;
  - R-4 a Luisa Pérez (V-18.222.333): 1,35 kg de queso más pan, por pago móvil;
  - R-5 a la misma, «Fiar todo»;
  - R-6 a Jean Pierre Dubois (E-84.111.222): mixto, 5 USD en efectivo más 3.000 Bs, con vuelto.
- **E2 (facturas serie A):**
  - A-1 a Abastos El Sol (J), por transferencia;
  - A-2 a la Alcaldía de Iribarren (G): 20.000 Bs por pago móvil y «Fiar lo que falta»;
  - A-3 a John Smith (pasaporte), en efectivo USD;
  - A-4 a Pedro Rivas (V): 2,5 kg de queso, por punto;
  - A-5 a Bodegón Mayorista Los Andes, cliente creado con lista preferida «mayor»;
  - una cotización y un pedido en /admin/ventas/nueva.
- **E3 (facturas):**
  - A-1 y A-2 en divisas **antes** de activar el IGTF;
  - A-3 y A-4 **después** de activarlo;
  - A-5 fiada a Inversiones Metálicas Lara, cliente especial, para cobrarla con retención en el bloque F.
- **De A:** en E2, ya con documentos, se probaron «Cambiar el RIF» y «Corregir RIF» con motivo, ida y vuelta.

Se bajó el PDF de los 26 documentos, con la COPIA de cada factura (`.recorrido/…/E/pdf/`); auditor-fiscal leyó 14.

**Hubo que cambiar el plan en dos puntos:**
- E3 no podía vender (E-01). Hubo que cargar a mano un rango de facturas en serie A.
- La percepción del IGTF de E3 hubo que activarla en /admin/igtf (E-02).

### E-01 · E · crítica · E3 · dueño — la caja factura siempre en serie A: con el talonario en serie B no vende, y la única salida es declarar un rango que no existe en papel (S, E, C, F)
PANTALLA: /vender · /admin/facturacion-fiscal · /empezar
DIMENSIÓN: MODO · DATOS · ESTADOS
PROMETE:
- /empezar pide el talonario con su «Serie (como aparece impresa)».
- La puesta a punto fiscal dice «Mientras un paso esté pendiente, emitir se detiene y te trae aquí».
- `docs/02_COMPLIANCE/EMISION_FACTURAS.md:18`: en forma libre, el número de control lo asigna la imprenta «por rango preasignado impreso en el papel».
HACE:
- La serie la decide el servidor: «A» en las facturas y «R» en los recibos (`packages/domain/src/sales.ts:1329`, `:1532`). Ninguna pantalla envía `series`, aunque el esquema lo admite (`packages/schemas/src/sales.ts:86`, `:442`).
- E3 registró su talonario en serie B, y todo cobro dio 409: «no hay rango de número de control disponible para invoice serie A en esta empresa: cárgalo o pide otro a la imprenta».
- La puesta a punto marca el paso 4 como completo para las facturas y solo pide los rangos de las notas. Comprueba que haya un rango por tipo de documento, pero no mira la serie (`apps/web/src/pages/setup/ChecklistFiscal.tsx:145-148`).
- La salida que se encuentra es cargar un rango A 5001-10000 en /admin/facturacion-fiscal. Ladino lo aceptó con solo el nombre de una imprenta en texto libre («Imprenta autorizada», sin RIF, providencia ni fecha) y emitió los controles 00005001 a 00005005, que no corresponden a ningún papel.
EVIDENCIA:
- `capturas-recorrido/E/E-01-caja-409-serie-A.png`, `E-01-puesta-a-punto-da-completo.png` y `E-01-rango-A-sin-papel.png`.
- `fiscal_number_ranges` de E3: «invoice B 1-5000», con next 1, sin usar; e «invoice A 5001-10000».
- Los cinco PDF de E3 dicen «N° de control: 0000500N».
REPRODUCIR: /empezar con el talonario en serie B → cobrar en la caja (409) → cargar un rango en serie A en /admin/facturacion-fiscal → cobrar.
¿SE NOTA?: la persona ve el 409. La salida que encuentra termina en verde, con controles inválidos.
¿NECESITA DECISIÓN DEL DUEÑO?: sí.
- ¿La serie de la caja la dicta el talonario registrado, o se elige en la caja?
- ¿Se prohíbe declarar un rango sin los datos de la imprenta?
- VALIDAR-SENIAT (auditor-fiscal, PA 00071 art. 13 num. 3, 4, 15 y 16): ¿es válida, y da crédito fiscal, una factura cuyo control impreso no coincide con el preimpreso? ¿Cómo se corrigen las cinco emitidas?

### E-02 · E · crítica · E3 · dueño — un contribuyente especial cobra en divisas sin percibir IGTF y nada lo avisa ni lo encuentra después (S, C, F)
PANTALLA: /vender · /admin/igtf · /empezar
DIMENSIÓN: MODO · DINERO · CONTABILIDAD
PROMETE:
- `docs/02_COMPLIANCE/IGTF_SPEC.md:29-30`: «La percepción es de la empresa clasificada como sujeto pasivo especial».
- El asistente (A-03) le dijo a E3 «percibes IGTF».
HACE:
- La percepción es un interruptor aparte, `igtf_enabled_at` (`packages/domain/src/igtf.ts:103-121`; `sales.ts:410`), que nace apagado. Ni /empezar ni la clasificación «especial» lo mencionan.
- E3 era especial desde las 22:00:33 y cobró por Zelle sin percibir:
  - A-1: 50 USD (al 3 %, 1,50 USD de IGTF);
  - A-2: 18,27 USD.
- Esos cobros no tienen fila en `igtf_perceptions` ni asiento a 2.1.91, y ningún informe, declaración ni invariante los encuentra. GET /v1/igtf/perceptions solo devuelve A-3 y A-4.
- Con el interruptor encendido, la percepción es correcta (ver «Lo que se comprobó»).
EVIDENCIA:
- `capturas-recorrido/E/E-02-igtf-apagado-siendo-especial.png` y `E-02-cobro-en-divisas-sin-igtf.png`.
- La consulta de pagos en divisa de empresas especiales sin percepción devuelve 2 filas (A-1 y A-2).
- `companies.igtf_enabled_at` de E3: 23:54:14.
REPRODUCIR: E3 especial desde /empezar → sin entrar a /admin/igtf → cobrar por Zelle en la caja.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: sí.
- ¿Marcarse especial activa la percepción, o bloquea los cobros en divisa hasta activarla?
- VALIDAR-TRIBUTARIO: ¿el agente responde por lo no percibido en A-1 y A-2? ¿Cómo lo regulariza?
- Hace falta un control «divisas cobradas por un especial sin percepción».

### E-03 · E · crítica · E3 · dueño — la factura no muestra el IGTF que la caja cobró (F)
PANTALLA: /vender → PDF de la factura
DIMENSIÓN: DOCUMENTOS
PROMETE: PA SNAT/2022/000013, art. 6: la factura del sujeto pasivo especial lleva la alícuota y el monto del IGTF percibido.
HACE:
- En A-4, la caja pidió 7,41 USD («Incluye IGTF USD 0,22»).
- El PDF dice «Total en dólares: USD 7,19» y no muestra el 3 % ni los 0,22.
- El generador no consulta la percepción: en `apps/api/src/routes/documents-pdf.ts:331-384` no aparece «igtf».
EVIDENCIA: `capturas-recorrido/E/E-03-la-caja-cobra-igtf.png` y `E-03-factura-A-4-sin-igtf.pdf`.
REPRODUCIR: E3 con el IGTF activado → cobrar por Zelle → Imprimir.
¿SE NOTA?: termina en verde: el cliente pagó 0,22 USD que ningún papel respalda.
¿NECESITA DECISIÓN DEL DUEÑO?: sí.
- ¿El IGTF va en la factura, o en un comprobante aparte?
- VALIDAR-SENIAT: cuando se percibe al cobrar una factura ya emitida (fiada o abonada después), ¿cómo se cumple el art. 6?
- VALIDAR-TRIBUTARIO: la PA 2022/000013 no está en REGULATORY_STATUS ni en IGTF_SPEC.

### E-04 · E · alta · E2, E3 · — — la factura no discrimina la base ni el IVA por alícuota, ni dice el porcentaje (F)
PANTALLA: PDF de factura
DIMENSIÓN: DOCUMENTOS
PROMETE: `EMISION_FACTURAS.md:79-80`: «estos elementos son de la 00071 y van ya». Pero la tabla de `:69-77` no mapea los numerales 13.4, 13.10, 13.11, 13.15 ni 13.16.
HACE: el pie dice «Subtotal:» e «IVA:», sin porcentaje, sin separar por alícuota y sin total exento (`apps/api/src/routes/documents-pdf.ts:333-334`). Pasa en las 10 facturas.
EVIDENCIA: `capturas-recorrido/E/E-04-E-10-factura-E2-A-1.pdf` («IVA: Bs. 53.318,52», sin «16 %»).
REPRODUCIR: cualquier factura → Imprimir.
¿SE NOTA?: la persona lo ve, si sabe mirarlo.
¿NECESITA DECISIÓN DEL DUEÑO?: no. Es requisito de la PA 00071, art. 13, num. 10 y 11; el diseño sigue bajo el VALIDAR-SENIAT #1 de EMISION_FACTURAS.

### E-05 · E · alta · E3 (toda factura cuyo IVA en USD no cae exacto) · — — el IVA en Bs no es el 16 % de la base en Bs (C, F)
PANTALLA: PDF de factura. El mismo `tax_amount` alimenta el libro de ventas y la declaración.
DIMENSIÓN: DINERO · DOCUMENTOS
PROMETE: ADR-0058 punto 4 y `docs/04_PLATFORM/MONEY_AND_ROUNDING_SPEC.md:231-234`: el IVA se redondea por línea en la moneda del documento, y el IVA en Bs es total menos subtotal (`sales.ts:1061-1083`).
HACE:
- El IVA en Bs es el IVA en USD ya redondeado, por la tasa.
- En la línea «Brocha» de A-3: 9,60 USD × 16 % = 1,536, que se redondea a 1,54 USD = 1.315,87 Bs. Pero 16 % de 8.202,85 Bs son 1.312,46.
- Las facturas de E2, con IVA exacto en USD, cuadran.

| Factura | Base Bs | 16 % | IVA impreso | Diferencia |
|---|---|---|---|---|
| E3 A-3 | 26.146,59 | 4.183,45 | 4.186,88 | +3,43 |
| E3 A-4 | 5.297,67 | 847,63 | 845,92 | −1,71 |
| E3 A-5 | 22.386,95 | 3.581,91 | 3.580,20 | −1,71 |
| E3 A-2 | 13.457,81 | 2.153,25 | 2.153,24 | −0,01 |

EVIDENCIA:
- `capturas-recorrido/E/E-05-factura-E3-A-3.pdf`.
- La consulta `subtotal_amount`, `tax_amount` y `round(subtotal*0,16, 2)` sobre `documents`.
- Los invariantes dan 0 porque miran total = base + IVA, no IVA = alícuota × base.
REPRODUCIR: E3 → 5 Tubo PVC + 4 Brocha → comparar el IVA con el 16 % del subtotal.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: sí, después del asesor.
- VALIDAR-TRIBUTARIO (ADR-0058 ya lo marca): en una venta en USD, ¿el débito fiscal en Bs de la factura, el libro y la declaración es alícuota × base en Bs, o la conversión del IVA ya redondeado en USD? ¿Qué diferencia se tolera?
- La pregunta concreta no está en PENDIENTES_ASESOR.

### E-06 · E · alta · E1, E2, E3 · cajero — no hay «compartir» ni WhatsApp de la factura o el recibo, y la documentación de cumplimiento lo da por construido (S, E)
PANTALLA: /vender, diálogo final «Venta registrada» (`apps/web/src/pages/negocio/Vender.tsx:1897-1982`)
DIMENSIÓN: PROMESA
PROMETE: `docs/02_COMPLIANCE/EMISION_FACTURAS.md:91`: «Entrega por medio digital | Construido — PDF por descarga y WhatsApp desde el POS».
HACE:
- El diálogo final solo tiene «Imprimir» y «Nueva venta».
- En `Vender.tsx` no hay compartir ni WhatsApp. WhatsApp existe solo para el estado de cuenta del cliente (`apps/web/src/pages/clientes/Clientes.tsx:884`).
EVIDENCIA: `capturas-recorrido/E/E-06-solo-imprimir.png`.
REPRODUCIR: cualquier venta, hasta el diálogo final.
¿SE NOTA?: la persona lo ve cuando necesita mandarlo. El documento de cumplimiento queda en verde falso.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Se construye compartir desde la caja, o se corrige EMISION_FACTURAS?

### E-07 · E · alta · E2 · cajero — la tarjeta del producto enseña el precio del mostrador y el carrito cobra el del cliente (S, E)
PANTALLA: /vender (`TarjetaPos`, `Vender.tsx:1022-1087`)
DIMENSIÓN: PROMESA · DINERO
PROMETE: la tarjeta enseña lo que se va a cobrar.
HACE:
- Con Bodegón Mayorista (lista «mayor») identificado, la tarjeta dice «Harina precocida caja x20 · USD 24,00 · Bs. 20.507,13».
- La misma línea en el carrito cuesta USD 22,00 · Bs. 18.798,20.
- La tarjeta pinta el precio de `/v1/products`, sin cliente. La cotización de la caja sí aplica la lista del cliente, y el cobro fue correcto, a 22,00.
EVIDENCIA: `capturas-recorrido/E/E-07-tarjeta-24-carrito-22.png`.
REPRODUCIR: E2 → identificar al J-40888777-6 → agregar la Harina caja → comparar la tarjeta con el carrito.
¿SE NOTA?: la persona lo ve, y no sabe por qué difieren.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿La cuadrícula cotiza por cliente, o se rotula «precio de mostrador»?

### E-08 · E · alta · (todas) · cajero — las cuentas abiertas son de la empresa: vuelven de la nube sin aviso, y cualquier cajero ve, cobra o borra las de otro (S, E, C)
PANTALLA: /vender (`Vender.tsx:244-312`; `packages/domain/src/pos-carts.ts:44-47`, `:88-95`, `:119-120`)
DIMENSIÓN: ESTADOS · ROLES
PROMETE: «cada cuenta se guarda sola… en la nube» (`Vender.tsx:75-82`). No promete avisar al recuperarla.
HACE:
- Al abrir la caja, las cuentas de la nube se agregan a la lista sin aviso. El guion encontró la cuenta de «Luisa Pérez» con 6 líneas de una pasada anterior, y tuvo que descartar cuentas antes de cada venta.
- `GET /v1/pos/carts` devuelve las de todos los usuarios de la empresa.
- El upsert pisa la cuenta de otro (gana la última escritura) y el borrado no mira quién la creó. `created_by` se guarda, pero no filtra ni se enseña.
- El worker las purga a los 30 días sin tocar (`apps/worker/src/reapers.ts:139-156`).
EVIDENCIA:
- `scripts/recorrido/e-vender.mjs:95-114`: la limpieza defensiva del guion.
- Código citado.
- Con dos cajeros reales no se ejecutó: queda como SOSPECHA de ejecución, para el bloque N.
REPRODUCIR: dejar una cuenta con líneas → abrir /vender en otra sesión de la misma empresa.
¿SE NOTA?: la persona ve la cuenta, pero no sabe de quién es ni de cuándo.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Cuentas por cajero o compartidas? ¿Se enseña quién la abrió? ¿Se avisa al recuperarla?

### E-09 · E · media · (todas) · cajero — el cajero puede fiar cualquier importe a cualquier cliente, incluido uno que acaba de crear (C)
PANTALLA: /vender, «Fiar todo» y «Fiar lo que falta» (`Vender.tsx:1801-1804`)
DIMENSIÓN: ROLES · DINERO
PROMETE: nada en la pantalla. El rol Cajero tiene `ar.read`, `customer.manage`, `sales.invoice.issue`, `sales.payment.register` y `sales.quote.manage`.
HACE:
- `quickSale` solo exige que el cliente esté identificado y no esté bloqueado (`packages/domain/src/sales.ts:3751-3771`).
- No hay permiso de crédito ni límite: `customers` no tiene columna de límite. Nadie aprueba el crédito.
EVIDENCIA: código y roles en la base. No se ejecutó como cajero@ (bloque N).
REPRODUCIR: como cajero@ → cliente V nuevo en la caja → «Fiar todo».
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Permiso de crédito, límite por cliente, o ambos?

### E-10 · E · media · E1, E2, E3 · — — en el papel, el total de la línea lleva IVA y el precio no, y el subtotal no es la suma de la columna (F)
PANTALLA: PDF de factura y recibo
DIMENSIÓN: DOCUMENTOS · DINERO
PROMETE: PA 00071, art. 13, num. 8: descripción con cantidad y monto.
HACE:
- La columna «Precio» va sin IVA y «Total» con IVA (`documents-pdf.ts:306-307`; `line_total` = `l.calc.total`, `sales.ts:1174`).
- En E2 A-1: 10 × 20.507,13 = 205.071,30, pero la columna dice 237.882,69.
- Hay desfases de céntimos porque el unitario se redondea en Bs:
  - R-1: 2 × 1.025,36 = 2.050,72, pero dice 2.050,71;
  - E2 A-4: 2,5 × 5.981,25 = 14.953,13, pero la base dice 14.953,11.
- Es el mismo patrón que D-15 en compras.
EVIDENCIA: `capturas-recorrido/E/E-04-E-10-factura-E2-A-1.pdf`.
REPRODUCIR: 10 Harina + 5 Arroz en E2 → Imprimir.
¿SE NOTA?: la persona lo ve: el cliente no puede rehacer la cuenta.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿La columna va sin IVA, o se añade el IVA por línea? VALIDAR-SENIAT (F).

### E-11 · E · media · (todas) · — — el mayor registra los cobros en divisas como bolívares, sin el importe en USD ni la tasa (C)
PANTALLA: contabilidad (asientos de `payment_received` e `igtf_perception`)
DIMENSIÓN: CONTABILIDAD
PROMETE: regla 3 de CLAUDE.md, y el bloque 4 de auditor-codigo: el movimiento guarda su moneda, su tasa y su fuente.
HACE:
- El débito a «1.1.02 Caja y bancos en divisas» del cobro de 5 USD de R-6 guarda `transaction_currency=VES`, 4.272,32, fx 1 y fuente «identidad».
- La cuenta 1.1.02 tiene `currency_code` NULL.
- El saldo en USD solo vive en tesorería, y el mayor no tiene con qué medir el diferencial cambiario de la caja en divisas.
EVIDENCIA: `journal_lines` de R-6, de E3 A-1 y del IGTF de A-3: todas VES/1/identidad.
REPRODUCIR: la consulta.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. VALIDAR-CONTABLE: ¿el mayor lleva la caja en divisas en su moneda, y cómo se revalúa? El mecanismo de revaluación es SOSPECHA: se mira en J y K.

### E-12 · E · media · (todas) · — — siete tablas con `tenant_id` dejan a la API ver todas las empresas: su aislamiento depende solo del WHERE (C)
PANTALLA: — (base de datos)
DIMENSIÓN: ROLES (aislamiento multi-tenant)
PROMETE: la segunda capa de ADR/RLS, que cumplen 74 tablas: `ladino_api` limitado por `platform.ladino_service_tenant_ids()`.
HACE: las políticas de `ladino_api` son `USING/WITH CHECK (true)` en siete tablas:
- `pos_carts` (`supabase/migrations/20260907203026_pos_open_carts.sql:70-77`);
- `igtf_perceptions`;
- `igtf_company_instruments`;
- `iva_period_results`;
- `supported_retention_receipts`;
- `company_fiscal_deadlines`;
- `inventory_ledger_cutovers`.
EVIDENCIA: `select tablename, cmd from pg_policies where schemaname='public' and 'ladino_api'=any(roles) and (qual='true' or with_check='true')`. La fuga explotable no se probó: SOSPECHA.
REPRODUCIR: la consulta.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: no. Es la regla de la familia: el test 006 mira el ancla, y ningún test mira esta capa.

### E-13 · E · media · (todas) · dueño — la caja nunca vende sin existencia, y el ajuste de empresa que diría lo contrario está muerto (S)
PANTALLA: /vender (`Vender.tsx:398-408`)
DIMENSIÓN: PROMESA · DATOS
PROMETE: `companies.block_sale_without_stock` existe, y vale `false` en las tres empresas.
HACE:
- La caja bloquea siempre («LA EXISTENCIA MANDA (orden del dueño, 2026-09-08)») y no lee el ajuste.
- La web no tiene interruptor para el ajuste.
EVIDENCIA: código y la columna en `companies`.
REPRODUCIR: en E1, tocar un producto agotado. El aviso «sin existencia» se ve por código; la captura quedó sucia (pendiente de verificarlo limpio).
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Se retira el ajuste, o se honra?

### E-14 · E · media · E2 · dueño/cajero — la lista preferida del cliente solo se elige al crearlo en /admin/clientes; la caja crea las J como «ordinario» sin preguntar (S, C)
PANTALLA: /admin/clientes («Editar») y /vender (alta de cliente, `Vender.tsx:1092-1097`)
DIMENSIÓN: DATOS · PROMESA
HACE:
- «Editar» no ofrece la lista preferida: un cliente creado en la caja no puede pasar nunca al mayor.
- La caja crea el J con clasificación «ordinario» sin preguntarla. Un especial creado en la caja queda mal clasificado, lo que afecta a las retenciones del bloque F.
EVIDENCIA: formulario de Editar; código citado.
REPRODUCIR: crear el cliente en la caja → Editar en /admin/clientes.
¿SE NOTA?: la persona lo ve cuando lo busca.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿La caja pregunta la clasificación de un J?

### E-15 · E · media · E2 · dueño — con documentos emitidos, «Cambiar el RIF» sigue diciendo «Sin documentos emitidos, el cambio es directo» y manda a «crear otra empresa», cosa que no se puede (S)
PANTALLA: /admin/configuracion → «Cambiar el RIF»
DIMENSIÓN: TEXTO · PROMESA
PROMETE: el subtítulo del diálogo dice «Sin documentos emitidos, el cambio es directo y queda auditado».
HACE:
- Con facturas emitidas, el diálogo sigue abriendo con ese subtítulo.
- Al guardar: «El RIF identifica a tu negocio ante el SENIAT y no se puede cambiar… crea otra empresa en Ladino y mantén esta con su historia». No hay forma de crear otra empresa (A-13).
- «Corregir RIF» con motivo sí funciona ida y vuelta, con su acta («Quedó el acta. Consulta con tu contador si algo ya facturado debe reemitirse»).
EVIDENCIA: `capturas-recorrido/E/E-15-sin-documentos-el-cambio-es-directo.png` y `E-15-crea-otra-empresa.png`. Confirma A-10 y A-13 con documentos.
REPRODUCIR: E2 con facturas → Configuración → «Cambiar el RIF» → J-40555123-7 → Guardar.
¿SE NOTA?: la persona lo ve, y la salida que se le da no existe.
¿NECESITA DECISIÓN DEL DUEÑO?: sí (la de A-13).

### E-16 · E · media · E3 · dueño — /admin/igtf ofrece «Marcarla como sujeto pasivo especial» a una empresa que ya lo es (S)
PANTALLA: /admin/igtf (`apps/web/src/pages/libros/Igtf.tsx:204-233`)
DIMENSIÓN: ESTADOS · TEXTO
PROMETE: «¿El SENIAT designó a esta empresa sujeto pasivo especial y aún no está marcada así en Ladino?»
HACE:
- El recuadro se pinta siempre que la percepción esté apagada, sin mirar la clasificación. E3 ya era especial (`taxpayer_type_code = especial`).
- La pantalla que debería decir «eres especial y no estás percibiendo» dice lo contrario. Suma a E-02.
EVIDENCIA: `capturas-recorrido/E/E-02-igtf-apagado-siendo-especial.png`.
REPRODUCIR: E3 especial → /admin/igtf.
¿SE NOTA?: la persona lo ve, y la confunde.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### E-17 · E · media · E3 · cualquiera — el 409 de numeración dice «invoice» y no da camino desde la caja (S, E)
PANTALLA: /vender, diálogo Cobrar (toast de `Vender.tsx:1606`)
DIMENSIÓN: TEXTO · ESTADOS
HACE:
- El mensaje del servidor sale tal cual: «no hay rango de número de control disponible para **invoice** serie A en esta empresa: cárgalo o pide otro a la imprenta».
- Es un toast rojo permanente, sin enlace a /admin/facturacion-fiscal.
- Un cajero sin permiso de Administración no tiene salida. No se comprobó con cajero@ (bloque N).
EVIDENCIA: `capturas-recorrido/E/E-01-caja-409-serie-A.png`.
REPRODUCIR: la de E-01.
¿SE NOTA?: la persona lo ve.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Enlace directo, o «avisa al encargado» según el permiso?

### E-18 · E · media · E2 · dueño — SOSPECHA: la cesta básica se facturó con IVA (F)
PANTALLA: catálogo (bloque C) → PDF de factura
DIMENSIÓN: DOCUMENTOS · MODO
HACE:
- E2 facturó harina precocida, arroz, café molido, azúcar y queso blanco con 16 % y sin «(E)».
- El PDF respeta la categoría fiscal del producto. `docs/02_COMPLIANCE` no trae la lista de exenciones de la LIVA, así que no se afirma que sean exentos.
EVIDENCIA: PDF de E2 A-1, A-2, A-4 y A-5.
¿SE NOTA?: termina en verde, si resultan exentos.
¿NECESITA DECISIÓN DEL DUEÑO?: sí.
- ¿Ladino propone la categoría fiscal de la cesta básica, o es solo dato del usuario?
- VALIDAR-TRIBUTARIO: ¿están exentos hoy, y con qué artículo?

### E-19 · E · baja · E1 · dueña — lo entregado y el vuelto no se guardan, y el diálogo rotula «Recibido» lo abonado (C)
DIMENSIÓN: DINERO · DATOS
HACE:
- En R-6, el pago en Bs se guarda neto (2.648,84). Lo entregado (3.000) y el vuelto (351,16) no quedan en la base ni en la auditoría (`sales.ts:3725-3739`).
- El diálogo dice «Recibido Bs. 6.921,16», cuando se recibió el equivalente de 7.272,32.
EVIDENCIA: `capturas-recorrido/E/E-19-recibido-vuelto.png` contra `payments` de R-6.
¿SE NOTA?: termina en verde: el cierre cuadra porque el neto es neto.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### E-20 · E · baja · — · — — `tax_amount` de la línea va en la moneda de la venta y el del documento en Bs, con el mismo nombre (C)
DIMENSIÓN: DATOS
HACE: en A-2, el IVA de las líneas es 12,80 + 12,48 USD, y el del documento 21.600,84 Bs. Sumar las líneas para cuadrar con el documento da 25,28 contra 21.600,84. No hay columna de IVA de línea en Bs.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### E-21 · E · baja · (todas) · — — SOSPECHA F1: la pantalla del IGTF muestra la regla de mañana desde las 20:00 de Caracas (C)
DIMENSIÓN: TIEMPO
HACE: `packages/domain/src/igtf.ts:70` compara `effective_from <= current_date`, con la fecha en UTC, mientras que el cobro usa `diaNegocio(fecha)` (`sales.ts:419`). Solo se nota el día de un cambio de norma.
EVIDENCIA: código. No se ejecutó a esa hora.
¿SE NOTA?: la persona lo ve: la tasa mostrada no es la cobrada.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### E-22 · E · baja · E1 · dueña — el recibo de una venta fiada parece un recibo pagado (F)
DIMENSIÓN: DOCUMENTOS · PROMESA
HACE: R-5, fiado entero, no dice «a crédito» ni el saldo pendiente. Por lo demás, el recibo cumple lo prometido (ver «Lo que se comprobó»).
EVIDENCIA: `capturas-recorrido/E/E-22-recibo-fiado-R-5.pdf`.
¿SE NOTA?: la persona lo ve.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿El recibo fiado dice «a crédito» y el saldo?

### E-23 · E · baja · (todas) · cajero — elegir la forma de pago es el único paso de la caja que exige ratón (E)
DIMENSIÓN: TECLADO
PROMETE: la cabecera de `Vender.tsx:84-85`: «Teclado, sin ratón: … F2 abre Cobrar → Enter cobra».
HACE: las formas de pago solo responden a `onClick` (`Vender.tsx:1560-1581` y `:1756-1778`). No hay atajo.
¿SE NOTA?: fricción, no bloqueo.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### E-24 · E · baja · — · — — la documentación cita la marca «(E)» y el adquirente un numeral corridos (F)
DIMENSIÓN: DOCUMENTOS
HACE: `EMISION_FACTURAS.md:74-75` y `documents-pdf.ts:297` sitúan la «(E)» en el num. 13.9. En la fuente consultada está en el num. 8, y el adquirente en el num. 7. El PDF cumple.
¿NECESITA DECISIÓN DEL DUEÑO?: no. VALIDAR-SENIAT: cotejar con la G.O. 39.795.

### Confirmaciones de hallazgos anteriores
- **A-11 / B-03:** las 10 facturas tienen dos carencias (F, E-F-07):
  - el pie dice «pendiente de homologación SENIAT (VALIDAR-SENIAT)» (`documents-pdf.ts:394`), aunque la PA 121 está derogada;
  - no imprimen el rango «desde… hasta…», los datos de la imprenta ni su fecha (PA 00071, art. 13, num. 4, 15 y 16).
- **P-21 (PENDIENTES_ASESOR):** la tasa se imprime sin fecha. E2 A-5 y E3 A-5, del 25/09, imprimen la misma «Tasa BCV: 854,4637» que las del 24/09 (F, E-F-09).
- **A-10 / A-13:** ver E-15.

### Lo que se comprobó y está bien
- **Cuatro documentos cruzados con la base (C).** R-6, E2 A-2, E2 A-5 y E3 A-3 coinciden con la pantalla en importes, pagos, asientos, kardex y tesorería:
  - la tasa, 854,4637, lleva su fuente;
  - el costo de venta es igual a la suma del kardex;
  - el céntimo de E3 A-3 (30.333,47 contra 35,50 × tasa = 30.333,46) es el residuo que define ADR-0058.
- **La percepción del IGTF, con el interruptor encendido, es correcta (S, C, E):**
  - la caja la explica antes de cobrar: «USD 7,41 con IGTF» e «Incluye IGTF USD 0,22»;
  - `igtf_perceptions` guarda la base, el 3 %, la tasa con su fuente y la política de redondeo;
  - el asiento acredita 2.1.91 «IGTF percibido por enterar».
- **Listas de precios (C, S):** la lista «mayor» se aplicó en el cobro de A-5 (22,00), en la línea y en el documento. El cajero no puede cambiar el precio ni elegir otra lista.
- **Recibos de E1 (F):** llevan «RECIBO R-…», sin RIF del emisor, sin IVA, sin control y con el pie «Documento no fiscal — no es una factura», con logo y la cédula del cliente.
- **Facturas de E2 (F):**
  - emisor, fecha, número, control y adquirente son conformes, también con pasaporte;
  - las copias llevan la leyenda «SIN DERECHO A CRÉDITO FISCAL»;
  - llevan la equivalencia en USD;
  - E2, ordinaria, no percibe IGTF.
- **Otros:**
  - `quickSale` revierte ante un `err` (el falso positivo F2 quedó descartado, C);
  - la cotización y el pedido se guardaron;
  - «Corregir RIF» con motivo funciona con su acta (S).
- **Invariantes y tiempos:** los invariantes de E1, E2 y E3 dan 0, con la cola de asientos y el outbox vacíos. Hubo 955 peticiones, ninguna por encima de 3 s; la más lenta, `POST /v1/pos/sales`, 2,05 s. **Esos ceros no cubren E-02, E-05 ni E-11**: ningún invariante mira percepciones faltantes, el IVA contra la base en Bs ni la moneda del mayor.

### Pendiente para otros bloques
- **Bloque N:**
  - E-08 y E-09, ejecutados con cajero@ y dos sesiones;
  - E-17, con un cajero sin Administración;
  - /vender a 390 y 1024 px y en oscuro: el guion de E corrió solo en escritorio (el estratega sospecha un diseño apretado a 1024).
- **Bloque L:** el libro de ventas de E3 frente a E-05; E-02 en la declaración del IGTF.
- **Bloques J y K:** la revaluación de la caja en divisas (E-11).
- **Bloque G:** los rangos de notas de crédito y débito de E2 y E3 (la puesta a punto los pide).
- **Sin repetir limpia:** la tarjeta «Agotado» con su aviso (E-13).

### Cierre del bloque E (validador)
GATE verde (el del último gate sobre el mismo código: 736 pasos, vitest 805 y pgTAP 1264, iguales a la línea base) · invariantes en 0 para E1, E2, E3, con la cola de asientos y el outbox vacíos · `backdated_stock_in` y `money_landing_gaps` sin filas · 955 peticiones, ninguna por encima de 3 s (la más lenta, `POST /v1/pos/sales`, 2,05 s).

---

## Bloque F · Cobros y deudas

**Qué se hizo.** Se cobró desde la ficha del cliente en /admin/clientes, con la dueña o el dueño de cada empresa.
- **E1:** abono de 1.500 Bs por pago móvil al fiado de Luisa Pérez (R-5); «Lo que me debe»; el WhatsApp del estado de cuenta; Mi dinero.
- **E2:** cobro de 150.000 Bs a la Alcaldía (A-2), rechazado por ser de más; corregido en el mismo diálogo a 50.000 (409); cobrado en un diálogo nuevo. Después, Cuentas por cobrar.
- **E3:**
  - comprobante de retención de Inversiones Metálicas (cliente especial, A-5 fiada): no se pudo cargar (F-01);
  - abono de 10 USD por Zelle a esa factura fiada, con IGTF, y el resto por transferencia;
  - venta fiada nueva el mismo día (A-6) y su comprobante: ese sí entró.
- **Por la API:** una factura de E2 fechada hace 40 días, para producir antigüedad.

La tasa del 25/09 (855,6625) entró a las 11:38 de Caracas, en mitad del bloque. Las facturas de origen son del 24/09 (854,4637).

**No se pudo probar:**
- **El paso del tiempo.** La factura hacia atrás da 409 «La empresa no tiene régimen fiscal vigente a esa fecha» (régimen y alícuota desde el 24/09). Los tramos 31–60, 61–90 y 90+ y sus colores quedan sin ver.
- **El saldo a favor aplicado.** Un pago de más no crea saldo a favor (F-10); se probó en el bloque G, con el saldo que dejó una devolución.

### F-01 · F · crítica · E3 · dueño — el comprobante de retención no se puede cargar en una factura en dólares si la tasa cambió desde la emisión (S, C, E)
PANTALLA: /admin/declaraciones → «Retenciones que nos hicieron» → «Cargar un comprobante»
DIMENSIÓN: CONTABILIDAD · DINERO · TEXTO
PROMETE:
- «Al guardarlo, su factura queda abonada por el importe retenido.»
- `packages/domain/src/declarations.ts:125`: «registra el diferencial cambiario si la factura vive en divisa».
HACE:
- En E3 A-5 (USD, 854,4637), con la tasa 855,6625 ya vigente, la carga da 422: «La plantilla de payment_received/ar.retention_applied produce un asiento descuadrado: débitos 2685.15000000 contra créditos 2681.39000000, diferencia 3.76000000. Revisa el mapeo.»
- La causa: la retención, que está en Bs, va por la rama «cobro en otra moneda» (`sales.ts:2367-2419`, `:2487`). El crédito a cuentas por cobrar va a la tasa de emisión, pero la plantilla `ar.retention_applied` solo tiene 1.1.07 / 1.1.03, sin línea de diferencial (`supabase/migrations/20260908233319_declarations_and_igtf.sql:557-568`). El cobro normal sí la tiene (4.1.02).
- Falla siempre que |retención × (1 − tasa de emisión / tasa de hoy)| llega a 0,005 Bs, es decir, con casi cualquier cambio de tasa. Lo normal es que el comprobante llegue días después. En una factura en VES no falla.
- El mismo día y con la misma tasa, entra: A-6, comprobante 20260900000124, 2.688,92.
- Además, una factura ya pagada no admite el comprobante: «Solo se cobra una factura emitida; esta está en paid» (`sales.ts:2026-2031`).
- En el escenario, el especial terminó pagando el total, con el IVA incluido, y su retención ya no puede entrar a la declaración.
- El único E2E de retención usa precios en VES (`apps/api/test/e2e-fiscal-declarations.test.ts:131`).
EVIDENCIA: `capturas-recorrido/F/F-01-retencion-descuadrada.png` y `F-01-F-09-mismo-dia-entra-y-no-se-ve.png`. 2.685,15 × 854,4637 / 855,6625 = 2.681,39.
REPRODUCIR: factura fiada en USD → cambia la tasa → cargar el comprobante.
¿SE NOTA?: la persona lo ve, con un mensaje de programador, y no tiene salida.
¿NECESITA DECISIÓN DEL DUEÑO?: sí.
- VALIDAR-CONTABLE: ¿la retención abona la deuda a la tasa de emisión, o lleva diferencial? Pregunta para PENDIENTES_ASESOR: «¿Una retención de IVA soportada sobre una factura en USD se imputa contra la cuenta por cobrar a la tasa de la factura o a la del día del comprobante?»
- ¿Qué pasa con un comprobante que llega cuando la factura ya se pagó entera?

### F-02 · F · alta · E2 · — — una factura pagada vuelve a deber cuando el BCV publica tarde la tasa del día (C)
PANTALLA: /admin/cuentas, /admin/clientes (`platform.document_balance_transaction`, usada por `document_debt_today`)
DIMENSIÓN: DINERO · TIEMPO
HACE:
- El saldo de un documento en USD valora cada cobro en Bs con la tasa del día del cobro, que cambia si esa tasa se carga después. No usa la tasa que valía al cobrar.
- E2 A-5 se cobró entera, 21.805,91 Bs, a las 15:14 UTC, cuando solo existía la tasa del 24/09. La del 25/09 entró a las 15:38.
- Hoy A-5 dice «Pagada» y debe 30,60 Bs (0,0358 USD), sin asiento y sin forma de cobrarla. En el mayor, ese documento da 0.
EVIDENCIA: `document_debt_today` de A-5 = 30,60 con `status = paid`.
REPRODUCIR: cobrar en Bs antes de que el BCV publique la tasa del día → traer la tasa → ver el estado de cuenta.
¿SE NOTA?: termina en verde, con una cifra fantasma en el estado de cuenta.
¿NECESITA DECISIÓN DEL DUEÑO?: no. Es pariente de la familia F1, con el tiempo como variable escondida.

### F-03 · F · alta · E2 · dueño — corregir un cobro rechazado y volver a registrar da «ya se registró», y no registra nada (S, C, E)
PANTALLA: diálogo de cobro (`apps/web/src/components/CobrarDocumento.tsx`)
DIMENSIÓN: ESTADOS · TEXTO
PROMETE: `CobrarDocumento.tsx:39-41`: «un rechazo (4xx) se corrige y se reintenta con la misma llave».
HACE:
- Tras el 422 de cobrar de más, se corrige el importe a 50.000 y se pulsa «Registrar cobro». Responde 409 `IDEMPOTENCY_KEY_REUSED` y no hay cobro en `payments`.
- El middleware compara el cuerpo antes de mirar si la clave quedó `failed` (`apps/api/src/middleware/idempotency.ts:250` frente a `:257`).
- En una empresa con RIF, el diálogo pinta el texto técnico: «Esta clave ya se usó con un cuerpo distinto» (`apps/web/src/pages/ventas/comunes.tsx:81`). La frase para personas también miente: «Esa operación ya se registró con otros datos».
- La única salida es cerrar el diálogo y abrir otro, y nada lo dice.
- Es la misma familia que D-03. Según C, alcanza también al diálogo de devolución (F-08).
EVIDENCIA: `capturas-recorrido/F/F-03-F-10-cobro-de-mas-rechazo.png` y `F-03-corregido-409.png`.
REPRODUCIR: E2 A-2 → Cobrar 150.000 → 422 → corregir a 50.000 → Registrar.
¿SE NOTA?: la persona lo ve, y el mensaje le dice lo contrario de lo que pasó.
¿NECESITA DECISIÓN DEL DUEÑO?: no. Es un defecto del middleware, sistémico.

### F-04 · F · alta · (todas) · dueño — la misma deuda enseña cuatro cifras distintas, y una sale por WhatsApp al cliente (S, C, E)
PANTALLA: /admin/clientes, ficha, /admin/cuentas, /dinero, resultado del cobro, WhatsApp
DIMENSIÓN: DINERO · TEXTO · PROMESA
PROMETE: cada cifra dice ser «lo que me debe» el cliente.
HACE: hay cuatro fórmulas en juego, y ninguna cuadra con el mayor (1.1.03 = saldo en USD × tasa de emisión, sin revaluación):
- **«Deuda» de /admin/clientes, «Debe hoy» de la ficha, fila «Saldo» de /admin/cuentas y «Lo que me deben» de /dinero:** `document_debt_today`, el saldo en USD × la tasa de hoy (`customers.ts:80-84`, `negocio.ts:190-194`, `sales.ts:650`).
- **Tarjeta «Saldo pendiente» y total del WhatsApp:** `total_outstanding`, que suma también los documentos pagados y sus residuos (`apps/api/src/routes/sales.ts:661-667`).
- **Antigüedad:** `platform.ar_aging`, que resta total − Σ `functional_amount`. Mezcla unidades, y un documento en USD cobrado en Bs a una tasa más alta puede desaparecer de ella.
- **«Saldo restante» del resultado del cobro:** `document_balance` (`sales.ts:2427`, `:2600`), la misma cifra mezclada.

Así se ve en el escenario:
- **Luisa (E1):**
  - ficha 1.837,08; tarjeta 1.837,07; antigüedad 1.832,41; mayor 1.834,51;
  - R-4, «Pagada», con saldo «−Bs. 0,01»: un residuo del viaje Bs→USD a 8 decimales, que queda para siempre y crece con la tasa;
  - el WhatsApp dice «Recibo R-5: Bs. 3.337,09 · Total: Bs. 3.337,08».
- **Alcaldía (E2):** «Total 156.606,11 · Cobrado 70.000,00 · Saldo 86.797,76», con la antigüedad en 86.606,11. Total − Cobrado ≠ Saldo, y nada lo explica.
- **E3 A-5, tras el abono de 10 USD:** «Saldo restante Bs. 17.410,52». La ficha decía 17.446,96, y con esa cifra se cerró la factura. Quien pague 17.410,52 deja 0,04 USD vivos.
EVIDENCIA: `capturas-recorrido/F/F-04-luisa-saldos-distintos.png`, `F-04-alcaldia-saldo-vs-antiguedad.png` y `F-04-F-05-saldo-restante-e-igtf-ademas.png`.
REPRODUCIR: cualquier fiado en USD con un abono después de un cambio de tasa.
¿SE NOTA?: la persona lo ve y no sabe cuál decir. El WhatsApp lo lleva al cliente.
¿NECESITA DECISIÓN DEL DUEÑO?: sí.
- El modelo del dueño dice «fiados anclados en USD»: ¿cuál es LA cifra, y cómo se muestra la revaluación?
- VALIDAR-CONTABLE: ¿se revalúa CxC en el mayor?

### F-05 · F · alta · E3 · dueño — en la ficha, el IGTF se cobra «además» de lo que el cliente pagó, y la cuenta registra más dinero del que entró (S)
PANTALLA: diálogo de cobro desde la ficha, forma Zelle
DIMENSIÓN: DINERO · PROMESA
PROMETE:
- «¿Cuánto pagó?», con 10 USD escritos: el diálogo no menciona el IGTF antes de registrar.
- En la caja (bloque E), lo recibido incluye el IGTF: «entrega 20 USD = 19,42 abonados + 0,58 de IGTF».
HACE:
- Tras registrar: «Se cobró además USD 0,30 de IGTF (Bs. 256,70)».
- El pago abona 10 USD a la factura y la percepción suma 0,30. La cuenta Zelle de E3 registra 10,30 USD (saldo 105,98 = Σ pagos + Σ IGTF).
- Si el cliente mandó 10 USD, la cuenta queda 0,30 por encima de lo real. La caja y la ficha tienen dos modelos opuestos para el mismo impuesto.
EVIDENCIA: `capturas-recorrido/F/F-05-zelle-sin-aviso-de-igtf.png` (antes) y `F-04-F-05-saldo-restante-e-igtf-ademas.png` (después). Saldo de «Zelle» en `company_account_balances`.
REPRODUCIR: E3 → ficha de un cliente con deuda → Cobrar → Zelle 10 → Registrar.
¿SE NOTA?: termina en verde. Se nota al cerrar la caja o conciliar el Zelle.
¿NECESITA DECISIÓN DEL DUEÑO?: sí.
- ¿«¿Cuánto pagó?» es lo que entregó el cliente (IGTF dentro), como en la caja?
- VALIDAR-TRIBUTARIO (del bloque E): ¿la base es 10 o 9,70?

### F-06 · F · alta · (todas) · quien cobra — un importe escrito a la venezolana, con punto de miles, deja el botón apagado sin decir por qué (E)
PANTALLA: todo campo `MoneyInput`: cobro, cierre de caja, mover plata (`apps/web/src/components/forms.tsx:59`, `:96-104`)
DIMENSIÓN: FORMA · TEXTO
HACE:
- `value.trim().replace(",", ".")` cambia solo la primera coma. «26.003,58» pasa a «26.003.58» y falla la expresión de importe.
- El campo se pone con borde rojo, pero `CobrarDocumento` no pasa `error` a sus `FormField`: no hay texto, y «Registrar cobro» queda apagado.
- El importe que propone el diálogo sale con punto decimal («3337.09»), distinto del resto de la pantalla, que usa coma.
EVIDENCIA: código. El guion tecleó sin punto de miles y no cayó en la trampa: confirmado por lectura, no por ejecución.
REPRODUCIR: cualquier `MoneyInput` → «26.003,58» → salir del campo.
¿SE NOTA?: la persona ve un botón apagado y no sabe qué corregir.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### F-07 · F · alta · (todas) · — — SOSPECHA: el cobro «que cierra» sobrescribe el importe y deja la caja corta y un residuo en CxC (C)
DIMENSIÓN: DINERO · CONTABILIDAD
HACE: en un cobro en USD de un documento en USD con otra tasa, si la diferencia cae dentro de la tolerancia de cierre, `sales.ts:2080-2093` sobrescribe el funcional del cobro con el saldo a tasa de emisión, y además asienta el diferencial.
- Caso aritmético: factura de 3,00 USD cobrada al día siguiente → Dr caja 2.563,39 / Cr CxC 2.559,79 / Cr ganancia 3,60.
- Salta con montos pequeños, justo los fiados de bodega.
EVIDENCIA: aritmética sobre el código. No hay caso en la base.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### F-08 · F · alta · (todas) · dueño — SOSPECHA: la devolución con reembolso repite F-03, y «confirmar el sobregiro» no puede funcionar (C)
DIMENSIÓN: ESTADOS
HACE: el diálogo de devolución reusa `llaveCrear` y `llaveReembolso` con cuerpos distintos tras un 4xx (`DetalleFactura.tsx:873-875`, `:956`, `:962`, `:975`, `:1144`). El reembolso forzado añade `allow_negative_balance: true` bajo la misma llave. La corrección de fbdfd36 (`${clave}:sobregiro`) solo se aplicó en la llegada de mercancía (`LlegoMercancia.tsx:404`).
EVIDENCIA: código. El mecanismo está confirmado en F-03; esta ruta no se ejecutó.
¿SE NOTA?: la persona lo ve.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### F-09 · F · media · E3 · dueño — «Comprobante cargado», y la lista de abajo dice «Ningún comprobante en este período» (S, E)
PANTALLA: /admin/declaraciones (`Declaraciones.tsx:113-120`, `mesAnterior()`)
DIMENSIÓN: ESTADOS
HACE: la pantalla abre en agosto (01/08–31/08), en una empresa creada en septiembre. Tras cargar un comprobante con fecha de hoy, el aviso confirma el éxito y la lista sigue en agosto: «Ningún comprobante en este período».
EVIDENCIA: `capturas-recorrido/F/F-01-F-09-mismo-dia-entra-y-no-se-ve.png` (GET con `from=2026-08-01&to=2026-08-31` justo después del POST).
¿SE NOTA?: la persona lo ve, y puede volver a cargarlo.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿La lista salta al período del comprobante recién cargado?

### F-10 · F · media · E2 · dueño — el cobro de más se rechaza en USD con punto decimal, y manda a hacer una nota de crédito (S, C, E)
PANTALLA: diálogo de cobro (`sales.ts:2148`)
DIMENSIÓN: TEXTO · DINERO
HACE:
- El diálogo dice «Saldo pendiente: Bs. 136.797,77». El rechazo dice «El cobro supera lo pendiente: quedan 159.87 USD por cobrar… si el cliente pagó de más, regístralo como saldo a favor con una nota de crédito».
- No existe anticipo ni saldo a favor por pago de más: el saldo a favor solo nace de una nota de crédito o de una devolución (`sales.ts:2855`, `:3224`). Una nota de crédito es un documento fiscal que reduce la venta.
EVIDENCIA: `capturas-recorrido/F/F-03-F-10-cobro-de-mas-rechazo.png`.
¿SE NOTA?: la persona lo ve.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Cómo se registra un pago de más, y en qué moneda habla el mensaje?

### F-11 · F · media · (todas) · — — cargar un comprobante de retención lo puede hacer el cajero y no el contador (C)
DIMENSIÓN: ROLES
HACE:
- `declarations.ts:61` exige solo `sales.payment.register`: lo tienen dueño, administrador, encargado y cajero; el contador, no.
- Cobrar cualquier factura de la empresa desde la ficha exige ese mismo permiso, sin más condición (`sales.ts:2006`).
EVIDENCIA: `role_permissions` en la base.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: sí (separación de funciones).

### F-12 · F · media · (todas) · — — ningún invariante cruza las cuentas por cobrar por documento con la cuenta 1.1.03 del mayor (C)
DIMENSIÓN: CONTABILIDAD
HACE: los 12 controles dan 0 en las tres empresas mientras E2 tiene una factura pagada que debe 30,60 (F-02) y E3 un −0,01 en el mayor (F-15). Es la pregunta de CLAUDE.md §3: ¿qué invariante cruza este módulo con los anteriores, y quién lo mira? Nadie.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### F-13 · F · media · (todas) · dueño — no hay dónde ver quién me debe: «Cuentas por cobrar» pide elegir un cliente, y «Ver quién me debe» lleva a la lista entera de clientes (S, E)
PANTALLA: /admin/cuentas sin cliente; /dinero → «Ver quién me debe» → /admin/clientes
DIMENSIÓN: PROMESA · ESTADOS
HACE:
- Sin cliente, la pantalla entera es «Elige un cliente». No hay cartera ordenada por monto ni por antigüedad.
- Desde Mi dinero no se cobra: el enlace lleva a todos los clientes, con y sin deuda.
EVIDENCIA: `capturas-recorrido/F/F-13-cuentas-sin-cliente.png`.
¿SE NOTA?: la persona tiene que abrir cliente por cliente.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Una vista de cartera?

### F-14 · F · baja · E1 · dueña — la bodega sin RIF lee «Cuentas por cobrar», «Antigüedad de saldos» y «Abonada» (E)
DIMENSIÓN: TEXTO
HACE: `Cuentas.tsx` no cambia de vocabulario con `useConFacturas`, a diferencia de `Clientes.tsx`.
EVIDENCIA: `capturas-recorrido/F/F-04-luisa-saldos-distintos.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿El glosario simple llega a esta pantalla?

### F-15 · F · baja · E3 · — — una factura pagada deja −0,01 para siempre en la cuenta 1.1.03 del mayor (C)
DIMENSIÓN: CONTABILIDAD
HACE: el diferencial se redondea cobro por cobro, sin política de residuo (`sales.ts:2394-2400`, `:2438-2445`). E3 A-5: 25.967,15 − 8.544,64 − 17.422,52 = −0,01.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### F-16 · F · baja · (todas) · — — SOSPECHA F1: la antigüedad cuenta un día de más desde las 20:00 de Caracas (C)
DIMENSIÓN: TIEMPO
HACE: `apps/api/src/routes/sales.ts:617`, `:651` y `:675-679` usan `current_date` y `issued_at::date` de la sesión, no `platform.caracas_day`.
EVIDENCIA: código. No se verificó el TimeZone de la sesión de la API.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### F-17 · F · baja · (todas) · quien cobra — SOSPECHA: a 390 px, la ficha y el diálogo de cobro apilados pueden verse como uno solo (E)
DIMENSIÓN: FORMA
HACE: los dos diálogos usan la misma regla de ancho en móvil (`apps/web/src/ui/dialog.tsx:32`). No hay captura a 390 px: se mira en el bloque N o en el P.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### Lo que se comprobó y está bien
- **Cobros desde la ficha (S):** el abono en Bs funciona. El diálogo propone el saldo y dice «Puede ser un abono». El WhatsApp arma el estado de cuenta con el teléfono del cliente.
- **Cobro en USD de una factura en USD (S, C):**
  - percibe el IGTF de un especial al cobrar una factura fiada: base 10 USD, 3 % = 0,30, con fila y asiento a 2.1.91;
  - enseña la «Ganancia cambiaria Bs 11,99» con las dos tasas;
  - la pregunta de E-03 (el IGTF en una factura ya emitida) tiene aquí su caso real.
- **La retención del mismo día (S, C):** Dr 1.1.07 / Cr 1.1.03 por 2.688,92, cuadrado, y abona la factura.
- **Invariantes y tiempos:** los invariantes de E1, E2 y E3 dan 0, con la cola y el outbox vacíos. Hubo 200 peticiones, ninguna por encima de 3 s; la más lenta, la retención, 615 ms. **Esos ceros no cubren F-02, F-04, F-12 ni F-15.**

### Cierre del bloque F (validador)
GATE verde (el del último gate sobre el mismo código: 736 pasos, vitest 805 y pgTAP 1264, iguales a la línea base) · invariantes en 0 para E1, E2, E3, también con los documentos del bloque G ya creados; cola de asientos y outbox vacíos · `backdated_stock_in` y `money_landing_gaps` sin filas · 200 peticiones, ninguna por encima de 3 s (la más lenta, `POST /v1/fiscal-declarations/supported-retentions`, 0,62 s) · documento con F-01..F-17 y sus capturas.

---

## Bloque G · Corregir una venta

**Qué se hizo.** Se corrigieron ventas desde el detalle del documento (/admin/ventas/:id), con la dueña o el dueño de cada empresa.
- **E2:**
  - factura fiada nueva (A-6), anulada;
  - A-1 cobrada: el botón «Anular» no aparece, y por la API da 409;
  - rangos de notas de crédito (A 1-500, que se solapa con el de facturas A 1-5000) y de notas de débito (A 5001-5500);
  - devolución de 2 Harina de A-1 con saldo a favor (NC A-2);
  - nota de crédito directa sobre A-4 (NC A-1: 0,5 kg de queso);
  - nota de débito sobre A-3 (ND A-1);
  - saldo a favor de Abastos aplicado a su factura fiada A-7. Es lo que F no pudo probar.
- **E1:** devolución de 1 Café de R-6, con el dinero desde la caja: recibo de devolución D-1.
- **E3:**
  - rango de notas de crédito (A 10001-10500);
  - devolución total de A-4, cobrada por Zelle con IGTF (NC A-1);
  - nota de débito sin rango de notas de débito.

Se bajó el PDF de las notas y del recibo de devolución (`.recorrido/…/G/pdf/`).

**Error del guion.** En la primera pasada, las devoluciones no se confirmaron: el botón se llama «Confirmar la devolución». La segunda pasada lo hizo todo. La «devolución sin rango» de E2 no se pudo repetir porque E2 ya tenía el rango; la sustituye la nota de débito sin rango de E3.

### G-01 · G · crítica · E2 · dueño — dos documentos fiscales con el mismo número de control: Ladino acepta un rango de notas de crédito que se solapa con el de facturas (S, F, E, C)
PANTALLA: /admin/facturacion-fiscal → «Cargar rango» · PDF de las notas
DIMENSIÓN: DOCUMENTOS · DATOS
PROMETE: «La imprenta autoriza un rango por cada clase: facturas, notas de crédito y notas de débito» (`apps/web/src/pages/setup/ChecklistFiscal.tsx:648`). ADR-0037 modela un rango por empresa, clase y serie.
HACE:
- Se cargó un rango de notas de crédito A 1-500 junto al de facturas A 1-5000, y Ladino lo aceptó («Rango cargado Notas de crédito»).
- La NC A-1 lleva control 00000001 y la NC A-2 control 00000002: los mismos que las facturas A-1 y A-2.
- El índice único es `documents_control_uidx (company_id, kind, series, control_number)`: incluye la clase.
- `fiscal_number_ranges` no impide solapes, ni entre clases ni dentro de la misma (`apps/api/src/routes/sales.ts:777-786`). Dos rangos solapados de la misma clase acabarían en un 23505 en plena emisión.
- Es **crítica** porque la PA 00071, art. 44, fija un control consecutivo y **único por emisor**, y en forma libre la imprenta no imprime la clase del documento (art. 31). Una empresa con un solo talonario tenderá a cargar el mismo rango en las tres clases, que es justo lo que invita a hacer el formulario. El control impreso tampoco lleva el identificador de dos dígitos del art. 44 (`documents-pdf.ts:238`).
EVIDENCIA:
- `capturas-recorrido/G/G-01-rango-nc-solapado-aceptado.png` y `G-01-G-02-nc-A-1-control-1.pdf`.
- `select kind, control_number from documents where company_id=E2 and control_number in (1,2)` devuelve invoice 1, credit_note 1, invoice 2 y credit_note 2.
REPRODUCIR: E2 → cargar un rango de notas de crédito A 1-500 → emitir dos notas.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Un correlativo de control por empresa, o rangos por clase que no se solapen?
- VALIDAR-SENIAT (F): «En formas libres (arts. 31 y 44), ¿puede el emisor destinar tramos distintos de su único correlativo a cada clase de documento, sin solaparse? ¿El control impreso lleva el identificador de dos dígitos?»

### G-02 · G · alta · E2, E3 · — — las notas de crédito y de débito no mencionan la factura que corrigen (F)
PANTALLA: PDF de nota de crédito y de débito
DIMENSIÓN: DOCUMENTOS
PROMETE: `documents-pdf.ts:18-27`: el PDF cumple el art. 13.
HACE: ninguna de las cuatro notas (E2 NC A-1 y A-2, E2 ND A-1, E3 NC A-1) lleva el número, la fecha, el control ni el monto de la factura de origen. El dato existe (`source_document_id`, `sales.ts:3401`), pero la consulta del PDF no lo lee (`documents-pdf.ts:120-149`).
EVIDENCIA: `capturas-recorrido/G/G-01-G-02-nc-A-1-control-1.pdf` y `G-02-G-09-nd-A-1-sin-factura-ni-motivo.pdf`.
¿SE NOTA?: la persona lo ve: quien recibe la nota no sabe qué factura corrige.
¿NECESITA DECISIÓN DEL DUEÑO?: no. La PA 00071, art. 23, exige la fecha, el número y el monto de la factura. VALIDAR-SENIAT: ¿también el número de control, como pide el art. 24 para máquina fiscal?

### G-03 · G · alta · E1 · dueña — el recibo de devolución de una bodega sin RIF sale con un RIF inventado, desglose de IVA y cita de la providencia (F)
PANTALLA: PDF del recibo de devolución D-1
DIMENSIÓN: MODO · DOCUMENTOS
PROMETE: `documents-pdf.ts:213-214`: «el recibo no lleva RIF del emisor… un documento no fiscal no finge campos de factura». `EMISION_FACTURAS.md:32-37`: el modo recibos no lleva RIF ni IVA.
HACE: el PDF dice:
- título «RECEIPT_RETURN D-00000001», con el tipo en inglés;
- «**RIF: P-END01A0D5479C**»: el marcador «sin RIF» (PEND-01A0D5479C) impreso como si fuera un RIF de pasaporte;
- «Subtotal», «IVA: Bs. 0,00», «Base imponible en dólares»;
- «Tasa BCV … (art. 13.14, PA 00071)»;
- el pie de factura en forma libre, en lugar de «Documento no fiscal — no es una factura».

La causa: `esRecibo = doc["kind"] === "receipt"` (`documents-pdf.ts:202`) deja fuera `receipt_return`, y `KIND_TITULO` (`:35-42`) no tiene esa clase. SOSPECHA: `?copia=1` también se sirve (`:170`). El logo sí sale, así que A-06 queda confirmado.
EVIDENCIA: `capturas-recorrido/G/G-03-recibo-devolucion-con-rif-inventado.pdf`.
¿SE NOTA?: la persona lo ve: el cliente se lleva un papel que aparenta ser fiscal.
¿NECESITA DECISIÓN DEL DUEÑO?: no para el arreglo. La leyenda sigue en P-16.

### G-04 · G · alta · E2 · dueño — el estado de cuenta enseña la nota de crédito con saldo positivo, como si el cliente la debiera (S, E, C)
PANTALLA: /admin/cuentas (Pedro Rivas) · `apps/api/src/routes/sales.ts:644-655`
DIMENSIÓN: DINERO · PROMESA
HACE:
- La pantalla dice «Saldo pendiente Bs. 0,00 · Saldo a favor disponible: Bs. 3.469,12».
- En Documentos: «Nota de crédito A-00000001 · Emitida · Total 3.469,12 · Cobrado 0,00 · **Saldo 3.473,99**», en naranja de advertencia.
- `document_debt_today` trata la nota como si fuera una factura y revalúa su total en USD (4,06) a la tasa de hoy. La nota nunca recibe cobros, así que queda así para siempre.
- La NC A-2 enseña 47.643,29, cuando su saldo a favor restante es 29.710,31.
EVIDENCIA: `capturas-recorrido/G/G-04-nc-con-saldo-positivo.png`.
¿SE NOTA?: la persona lo ve, y es la fila más llamativa de la tabla.
¿NECESITA DECISIÓN DEL DUEÑO?: no. Una nota de crédito no es deuda.

### G-05 · G · alta · (todas) · dueño — la deuda en dólares se revalúa cada día, pero el saldo a favor de devolver esa misma factura queda fijo en bolívares (S, E, C)
PANTALLA: diálogo de devolución / nota de crédito · `sales.ts:2854-2859`, `:3223-3228`
DIMENSIÓN: DINERO
PROMETE: el diálogo explica el costo del inventario («al costo con que salió»), pero no dice en qué moneda queda el saldo a favor.
HACE:
- La nota hereda la moneda y la tasa del origen (`sales.ts:3315-3317`), pero el saldo a favor se guarda en VES, sin tasa ni fuente. `customer_credits` no tiene columnas de tasa, fuente ni importe funcional, contra la regla 3.
- NC A-2: 55,68 USD × 854,4637 = 47.576,54 Bs. A la tasa de hoy serían 47.643,29: el cliente pierde 66,75 Bs si lo aplica hoy.
- El recibo de devolución de E1 reembolsa 2,50 USD de café a la tasa de ayer.
EVIDENCIA: `capturas-recorrido/G/G-05-devolucion-saldo-fijo-en-bs.png`; `customer_credits` (todos en VES).
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿El saldo a favor se ancla en USD, como los fiados, o en Bs?

### G-06 · G · alta · E3 · dueño — la devolución de una venta cobrada con IGTF deja el impuesto como «percibido» de una venta que ya no existe (S, F, C)
PANTALLA: devolución de E3 A-4
DIMENSIÓN: MODO · CONTABILIDAD
HACE:
- A-4 se cobró 7,41 USD (7,19 más 0,22 de IGTF). La devolución total deja un saldo a favor de 6.143,59 Bs (7,19 USD sin IGTF).
- La percepción sigue «percibido | 0,22 | 187,98», y el asiento a 2.1.91 no tiene contrapartida.
- La rama de reintegro de la anulación (`sales.ts:1967-1983`) no se ejecuta nunca: el IGTF solo existe si hubo cobro, y con cobro no se puede anular.
- `createReturn` y `confirmReturn` no tocan `igtf_perceptions`.
EVIDENCIA: `igtf_perceptions` de A-4.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: sí, con el asesor. VALIDAR-TRIBUTARIO (F, PA 2022/000013 art. 4): «¿Esa percepción pasa a ser "indebida" y se restituye y reintegra, o se entera igual porque el pago ocurrió? ¿La nota debe mostrar el IGTF?» Amplía P-9, que hoy solo cubre la anulación.

### G-07 · G · alta · (todas) · cajero — el cajero no tiene ningún camino para una devolución (E, C)
PANTALLA: menú, /clientes, /vender
DIMENSIÓN: ROLES · PROMESA
HACE:
- El rol Cajero (5 permisos) no tiene `sales.return.manage` ni `sales.invoice.annul`.
- El menú esconde Ventas y Cuentas por cobrar, y el enlace «Para cobrar una deuda…» de /clientes también desaparece.
- Desde la caja no se llega al detalle de un documento.
- La devolución, la NC directa y el reembolso los hacen back_office y el dueño. La nota de débito también el cajero y el encargado.
EVIDENCIA: código y `role_permissions`. Se ejecuta con cajero@ en el bloque N.
¿SE NOTA?: el camino no existe, y eso es más difícil de notar que un botón apagado.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿El cajero inicia devoluciones simples, o se le dice en pantalla a quién pedírselo?

### G-08 · G · alta · (todas) · administrativo — SOSPECHA: el rol administrativo ve «Anular», pero la anulación falla al final por un permiso contable (C)
DIMENSIÓN: ROLES
HACE: back_office tiene `sales.invoice.annul`, pero no `accounting.entry.reverse`, que se exige antes de reversar el asiento (`packages/domain/src/accounting.ts:580`, desde `sales.ts:1939-1947`). Toda anulación que haga ese rol terminaría en un 4xx `VALIDATION_FAILED` que no es 403, y el rollback lo desharía todo.
EVIDENCIA: la cadena está comprobada en el código y en `role_permissions`. No se ejecutó: se prueba en el bloque N con administrativo@.
¿SE NOTA?: la persona lo ve.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### G-09 · G · media · E2, E3 · — — en el papel de las notas falta el porcentaje de IVA, la nota de débito no describe el ajuste y ninguna trae el motivo (F)
DIMENSIÓN: DOCUMENTOS
HACE:
- El IVA sale sin porcentaje: «IVA: Bs. 478,50» (`documents-pdf.ts:331-336`).
- La ND A-1, por «diferencia de precio», dice solo «1 · Pasta caja x20 · 1.708,93»: parece una venta nueva.
- El motivo se guarda en `notes` y no se imprime.
- Además, la columna de total por línea lleva IVA (E-10).
EVIDENCIA: `capturas-recorrido/G/G-02-G-09-nd-A-1-sin-factura-ni-motivo.pdf`.
¿NECESITA DECISIÓN DEL DUEÑO?: no, en cuanto al porcentaje (art. 13, num. 9 a 11). VALIDAR-SENIAT sobre el motivo.

### G-10 · G · media · E2 · dueño — anular o nota de crédito: la norma no dice cuándo, y el libro de ventas trata la anulada distinto que el de compras (F)
DIMENSIÓN: DOCUMENTOS · MODO
HACE:
- La anulación de A-6 funciona y conserva el correlativo, pero no pregunta si el original ya se entregó ni si se recuperaron las copias (PA 00071, art. 36).
- El libro de ventas lista la anulada con sus importes completos (`supabase/migrations/20260916170000_fiscal_amounts_in_bolivars.sql:166`), mientras que en compras R-2 fijó «anulada = importes en cero».
¿NECESITA DECISIÓN DEL DUEÑO?: sí. VALIDAR-TRIBUTARIO (F): «¿Cuándo procede anular (art. 36) y cuándo la nota es obligatoria (art. 22)? ¿La anulada va en el libro con importes en cero?»

### G-11 · G · media · E2, E3 · — — las notas del 25/09 imprimen la tasa de la factura del 24/09, sin decir de dónde sale (F)
DIMENSIÓN: DOCUMENTOS · DINERO
HACE: toda nota usa la tasa del origen (`sales.ts:3403`, `fxRate: tasaOrigen`), también la ND, que es un cargo nuevo. El papel dice «Tasa BCV: 854,4637» sin fecha y sin citar la factura (G-02).
¿NECESITA DECISIÓN DEL DUEÑO?: sí. VALIDAR-TRIBUTARIO (F): «¿Una NC o ND sobre una factura en USD de otro día va a la tasa de la factura o a la del día de la nota?» Relacionada con P-20 y P-21.

### G-12 · G · media · E1, E2 · — — un documento pagado exacto queda con saldo de ±0,01 para siempre (C)
DIMENSIÓN: DINERO
HACE:
- `platform.document_balance_transaction` convierte el cobro en Bs a USD con 8 decimales, contra un total ya redondeado a 2. Deja un resto de ~1e-5 USD que `document_debt_today` multiplica por la tasa del día.
- E2 A-1, «Pagada», saldo 0,01; E1 R-4, −0,01.
- A-7, pagada con saldo a favor, dará 0,01 cuando la tasa pase de ~1.425.
- El mayor no lo tiene. Amplía F-04.
EVIDENCIA: `document_balance_transaction` de A-1 = 0,00000922.
¿SE NOTA?: la persona lo ve.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### G-13 · G · media · (todas) · — — cargar un talonario fiscal no deja acta, y la regla vive en la API, no en el dominio (C)
DIMENSIÓN: DATOS
HACE: `POST /v1/fiscal-number-ranges` inserta directamente desde el handler (`apps/api/src/routes/sales.ts:757-788`), sin `audit_event`, contra la regla 3 y `apps/api/CLAUDE.md`. La puerta de contingencia sí audita (`contingency.ts:78-89`).
EVIDENCIA: E2 tiene 3 rangos y 0 actas.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### G-14 · G · media · E2 · dueño — en una factura cobrada, «Anular» desaparece sin decir por qué ni que el camino es «Devolución» (E)
DIMENSIÓN: ESTADOS · TEXTO
HACE: la explicación («Solo se anula un documento sin cobros…») está dentro del diálogo de Anular, que no se puede abrir.
EVIDENCIA: `capturas-recorrido/G/G-14-cobrada-sin-anular-ni-explicacion.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### G-15 · G · media · E2 · dueño — un saldo a favor que ya existe no se puede devolver en dinero (S)
DIMENSIÓN: PROMESA · DINERO
HACE: el reembolso solo existe dentro del diálogo de devolución. El saldo de Pedro Rivas (3.469,12, de una NC directa) solo se puede aplicar a una compra futura. /admin/cuentas lo lista sin ninguna acción.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Reembolso de un saldo a favor existente?

### G-16 · G · media · E3 · dueño — «no hay rango… para debit_note serie A», dos veces (S, E)
DIMENSIÓN: TEXTO
HACE: el tipo de documento sale en inglés, con minúscula al inicio, en DOS avisos: dentro del diálogo y en un toast. El segundo sí trae «Ir a la puesta a punto fiscal», que la caja no trae (E-17).
EVIDENCIA: `capturas-recorrido/G/G-16-debit-note-dos-avisos.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### G-17 · G · baja · E2 · — — «saldo a favor», en minúsculas, como forma de pago (E)
DIMENSIÓN: TEXTO
HACE: `saldo_a_favor` no está en `ETIQUETA_FORMA` (`apps/web/src/components/formas-de-pago.ts:105-112`) y sale el código crudo con espacios. Es la reaparición del defecto que la función dice haber corregido (QA 2026-09-15, h. 39). Merece un test de familia: todo `payments.instrument` en uso está en `ETIQUETA_FORMA`.
EVIDENCIA: `capturas-recorrido/G/G-17-saldo-a-favor-minusculas.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### G-18 · G · baja · (todas) · — — SOSPECHA: una nota de crédito sobre una factura fiada no baja su deuda (C)
DIMENSIÓN: DINERO
HACE: la nota siempre crea un saldo a favor aparte (`sales.ts:2854`, `:3223`), y la deuda de la factura sigue entera hasta que alguien aplique el crédito a mano. En el recorrido, las tres NC fueron sobre facturas pagadas.
¿NECESITA DECISIÓN DEL DUEÑO?: sí.

### G-19 · G · baja · E2 · — — la reversa de una anulación queda como asiento «manual» (C)
DIMENSIÓN: CONTABILIDAD
HACE: E2#43 lleva `source_kind = manual`, sin `source_id`. Solo `is_reversal_of` lo ata a la factura (`accounting.ts:636-642`).
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### G-20 · G · baja · (todas) · — — SOSPECHA: la misma persona devuelve, reembolsa y confirma el sobregiro, sin aprobación (C)
DIMENSIÓN: ROLES
HACE: `sales.ts:1708` y `:1750-1756`: con `sales.return.manage` basta para todo. No hay separación de funciones.
¿NECESITA DECISIÓN DEL DUEÑO?: sí.

### G-21 · G · baja · E2 · — — «Este factura ya tiene cobros…» (S, E, C)
DIMENSIÓN: TEXTO
HACE: la plantilla del mensaje es `Este ${nombre}` (`sales.ts:1865`). En la pantalla solo se ve si hay una carrera, porque el botón se esconde; por la API sale siempre.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### Confirmaciones de hallazgos anteriores
- **A-06** (el logo en el PDF del recibo de devolución): sí sale (F).
- **A-11, B-03 y E-F-07:** el pie «pendiente de homologación SENIAT» sale también en las siete notas. Cita un procedimiento que derogó la PA SNAT/2026/00084 (F).
- **F-16** queda confirmada por código y por zona horaria (`show timezone` = UTC): el estado de cuenta usa `current_date` de UTC (C).

### Lo que se comprobó y está bien
- **Contabilidad de cada corrección (C):** todos los asientos cuadran.
  - La anulación de A-6 crea un asiento nuevo de reversa y no toca las líneas del original (regla 2).
  - Los tres reingresos de mercancía van al costo unitario exacto de la salida. Por ejemplo, la devolución de A-1: 2 × 15.380,3466.
  - La NC reversa el IVA débito y la ND lo suma.
  - La aplicación del saldo a favor a A-7 va sin diferencial, que es lo correcto: misma tasa.
- **Anular sin cobro (S):** conserva el correlativo, repone el kardex y reversa el asiento, con un mensaje claro. Con cobro, el servidor lo impide. Captura: `capturas-recorrido/G/G-anulada-conserva-correlativo.png`.
- **Devolución (S, E):** el diálogo bifurca bien entre «dejar saldo a favor» y «devolver desde una caja». El reembolso de E1 salió de una caja en Bs y lo valida `sales.ts:1728`.
- **Invariantes y tiempos:** los ocho invariantes dan 0 en E1, E2 y E3, `annulled_stock_gaps` incluido, con la cola y el outbox vacíos. Hubo 372 peticiones, ninguna por encima de 3 s; la más lenta, `GET /v1/documents/:id`, 0,5 s. **Esos ceros no cubren G-01, G-04, G-05, G-06 ni G-12.**

### Cierre del bloque G (validador)
GATE verde (el del último gate sobre el mismo código: 736 pasos, vitest 805 y pgTAP 1264 en 70 ficheros, iguales a la línea base) · invariantes en 0 para E1, E2, E3 (`annulled_stock_gaps` incluido), también con el bloque H ya en marcha; cola de asientos y outbox vacíos · 372 peticiones, ninguna por encima de 3 s (la más lenta, 0,5 s) · documento con G-01..G-21 y sus capturas.

---

## Bloque H · Compras y gastos

**Qué se hizo.**
- **E2:**
  - gasto de «Luz» en Bs, recurrente y con foto del recibo;
  - gasto de «Flete» de 5 USD;
  - historial de gastos, compras a proveedores y «Lo que debo» en Mi dinero;
  - abono de 20 USD en efectivo a la factura 000123 (en USD, del 24/09), con la tasa de hoy: la prueba de D-07;
  - «Hacer un pedido» a Alimentos del Centro;
  - nota de crédito del proveedor sobre LM-5501.
- **E3 (contribuyente especial):**
  - regla de retención de IVA del 75 %, citando la PA SNAT/2025/000054 (fuente en `RETENTIONS_SPEC.md:50`);
  - compra nueva en Bs con factura, a crédito (F-89002);
  - intento de pagarla entera desde Banesco;
  - abono de 50 USD por Zelle a F-88771.

**Error del guion.** La primera pasada se cortó en la nota de crédito, porque «Cuentas por pagar» pide elegir el proveedor antes de enseñar nada (H-11). La segunda pasada lo hizo.

### H-01 · H · crítica · E3 · dueño — un contribuyente especial nunca retiene IVA desde la web, aunque tenga la regla cargada, y nada lo dice (S, E, F, C)
PANTALLA: /admin/llego-mercancia · /compras («Ya llegó la factura») · /admin/compras («Registrar factura…», «Reglas de retención», «Pagar la factura»)
DIMENSIÓN: MODO · PROMESA · CONTABILIDAD
PROMETE:
- La pantalla de reglas: «Sin regla vigente no se retiene — la factura se detiene con RETENTION_RULE_MISSING diciendo qué falta» (`apps/web/src/pages/compras/Compras.tsx:1494-1496`).
- El pago: «Si hay retención calculada, se aplica solo al cancelar la factura entera y el proveedor cobra el neto».
- ADR-0039 §2: la resolución falla, nunca devuelve cero. El ADR rechaza expresamente «retener siempre cero».
HACE:
- El servidor retiene solo si el cuerpo trae `retention_concepts` (`packages/domain/src/purchases.ts:1095`). `arrivals.ts:356-358` lo pasa solo si llega.
- **Ninguna pantalla lo envía**: el campo aparece 0 veces en `apps/web` y `apps/mobile`. El servidor tampoco mira si la empresa es especial.
- F-89002 (IVA 30.400 Bs), con la regla vigente, quedó con retención 0. Debió retener 22.800 Bs, que la empresa debe ahora al fisco sin saberlo. F-88771 (del bloque D) quedó igual.
- El «¿Todo bien?» de la llegada no menciona la retención.
- No sale RETENTION_RULE_MISSING, porque solo se lanza si llegan conceptos.
- Ningún invariante cruza «empresa especial + regla vigente + factura sin retención».
- Los E2E de retención van por `supplier-invoices` enviando el campo (`e2e-purchases.test.ts:504-636`). No hay ninguno desde la llegada.
EVIDENCIA: `capturas-recorrido/H/H-01-regla-75-cargada.png`, `H-01-todo-bien-sin-retencion.png` y `H-01-H-04-sin-comprobantes.png`. `supplier_invoices.retention_total = 0` y `supplier_retentions` vacía.
REPRODUCIR: E3 → cargar la regla del 75 % → Llegó mercancía con factura en Bs → registrar.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿La retención se aplica sola cuando la empresa es agente y el proveedor nacional, o la elige la persona? Si el servidor la infiere, es un cambio de contrato.
- Por COT arts. 27 y 115 (F), el agente que no retiene responde solidariamente y tiene multa.
- VALIDAR-TRIBUTARIO: ¿cómo se regulariza F-88771, que se registró antes de cargar la regla?

### H-02 · H · alta · E2, E3 · — — D-07 confirmado: pagar otro día una factura en dólares no reconoce el diferencial, y la cuenta por pagar queda descuadrada para siempre (C)
PANTALLA: pago a proveedor (`purchases.ts:2085`, `:2248-2264`)
DIMENSIÓN: CONTABILIDAD · DINERO
HACE: el pago resta de 2.1.01 lo convertido a la tasa del PAGO, no a la de registro. No hay línea de diferencial ni fila en `exchange_gain_loss`. En ventas sí existe (`sales.ts:2327-2501`).
- **E2, 000123:** registrada a 854,4637 (2.1.01 H 1.100.207,46). El abono de 20 USD a 855,6625 hace D 2.1.01 17.113,25 / H 1.1.02, sin más líneas. Queda 23,976 Bs de menos frente a 1.267,60 USD × 854,4637, que es 20 × 1,1988.
- **E3, F-88771:** el abono de 50 USD deja 59,94 Bs de menos.
- Cuando la factura se cancele entera pasará a `paid`, y el residuo se queda en 2.1.01.
- Ningún invariante compara la cuenta por pagar en Bs con el saldo en divisa.
- La NC de proveedor usa la tasa de su propia fecha: SOSPECHA de lo mismo.
EVIDENCIA: asiento 53 de E2 y asiento 46 de E3. Mayor de 2.1.01 contra Σ(saldo × tasa de registro).
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. VALIDAR-CONTABLE: a qué cuenta va el diferencial cambiario de las compras.

### H-03 · H · alta · E2 · dueño — la nota de crédito de un proveedor es imposible desde la web, y los E2E pasan porque mandan un campo que la pantalla no pide (S, E, F, C)
PANTALLA: /admin/compras → Cuentas por pagar → «NC…»
DIMENSIÓN: DOCUMENTOS · ESTADOS
HACE:
- El diálogo pide número, fecha, motivo y líneas. El servidor responde 422: «La nota de crédito necesita número de control o referencia del documento origen» (`purchases.ts:1809-1813`).
- El cuerpo no lleva `supplier_control_number` ni `supplier_document_ref` (`Compras.tsx:1914-1931`). Los dos E2E los envían (`e2e-purchases.test.ts:737`, `:988`): un test en verde por algo que la web no hace.
- SOSPECHA (C): aunque se arregle, las líneas de la web no llevan `tax_amount` y la nota tendría IVA 0 (`purchases.ts:1855`), sin revertir el crédito fiscal.
- El crédito fiscal del período se deduce de más.
- F: la norma (PA 00071, art. 23) exige el número de control. El servidor tiene razón, y falla la pantalla.
EVIDENCIA: `capturas-recorrido/H/H-03-nc-proveedor-sin-control.png` y `H-03-nc-proveedor-422.png`.
¿SE NOTA?: la persona lo ve, sin salida.
¿NECESITA DECISIÓN DEL DUEÑO?: no para la pantalla. VALIDAR-TRIBUTARIO (F): ¿una NC de proveedor nacional sin control puede ir al libro? Hoy el servidor acepta la referencia en su lugar.

### H-04 · H · alta · E3 · — — el comprobante de retención no existe como documento (F, C)
DIMENSIÓN: DOCUMENTOS
PROMETE: ADR-0039 §5 y `RETENTIONS_SPEC.md:39`: «se emite y numera al pagar».
HACE:
- Solo se emite con `issue_retention_receipt: true` y cancelando la factura entera (`purchases.ts:2167`, `:2173`). Ninguna pantalla envía ese campo; solo un test.
- Lo que se guarda es una fila con serie, número, período y total. No tiene la máscara AAAAMM + 8 dígitos, ni fecha de entrega, ni domicilio del proveedor. No hay PDF ni generador.
- Una factura a crédito pagada en partes no tendría comprobante nunca.
- F: ADR-0039 y la spec atribuyen la máscara de 14 dígitos a la PA 102. Según la reproducción consultada, la define el art. 16 de la PA 000054.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: sí: el momento de emisión (P-26) y si es uno por factura o uno por período. VALIDAR-SENIAT (F) sobre el art. 16.

### H-05 · H · alta · E3 · dueño — pagar al proveedor desde /admin/compras sin saldo en la cuenta: el mensaje dice «confirma que quieres registrarlo igual» y no hay con qué (S, E, C)
PANTALLA: /admin/compras → «Pagar la factura» (`Compras.tsx:2092-2251`)
DIMENSIÓN: ESTADOS · TEXTO
HACE:
- 409 «“Banesco” tiene 111369.61000000 VES y esta operación saca 220400.00000000: quedaría en negativo… o confirma que quieres registrarlo igual». No hay botón.
- El diálogo de /compras (`negocio/Compras.tsx:826`), la llegada y Mi dinero sí lo tienen.
- El importe se prellena crudo, «220400.00000000», con ocho decimales en el campo (`Compras.tsx:2105`). Lo mismo en /compras.
- Hay dos diálogos para pagar al mismo proveedor, con comportamientos distintos.
EVIDENCIA: `capturas-recorrido/H/H-05-pago-sin-confirmar-sobregiro.png`.
¿SE NOTA?: la persona lo ve, y no puede salir desde esa pantalla.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Cuál de los dos diálogos manda?

### H-06 · H · alta · E2 · dueño — el pedido nace en bolívares y el precio no dice en qué moneda va: 15 cajas «a 18» quedaron en 270 Bs (S, E, C)
PANTALLA: «Hacer un pedido» (`apps/web/src/components/HacerPedido.tsx:61`, `:213-259`)
DIMENSIÓN: FORMA · DINERO
HACE:
- La moneda nace en «VES» fija y su selector está debajo de las líneas. El campo «Precio c/u» no enseña la moneda.
- La persona escribió 18 pensando en dólares, que es lo que costó esa harina en D, y el pedido quedó en 270,00 VES.
- Al recibirlo, se valoraría a 18 Bs la caja (SOSPECHA de C; no se recibió).
- SOSPECHA (C): el servidor no valida que la moneda de la llegada o de la factura coincida con la del pedido. Por la API, un pedido de VES 18 recibido en USD valora a 18 USD (`arrivals.ts:168-178`).
EVIDENCIA: `capturas-recorrido/H/H-06-pedido-en-bs.png`. En la base, `purchase_orders`: 270,00 VES.
¿SE NOTA?: termina en verde, con el dato mal.
¿NECESITA DECISIÓN DEL DUEÑO?: no para reordenar el formulario. Sí para la moneda por omisión (el precio de referencia del dueño es USD).

### H-07 · H · alta · E2 · dueño — «Se paga todos los meses: para recordártelo cuando toque», y no hay recordatorio (E, C)
PANTALLA: /compras → Registrar gasto (`negocio/Compras.tsx:678-690`)
DIMENSIÓN: PROMESA
HACE:
- `is_recurring` solo se guarda y se muestra en la lista. Ningún job ni worker lo lee.
- SOSPECHA (C): el gasto de Luz quedó con `is_recurring = false` aunque el guion pulsó el interruptor. En la captura se ve apagado. Puede ser el switch dentro de un `<label>`, o que el clic del guion no llegara: se repite a mano.
EVIDENCIA: `capturas-recorrido/H/H-07-H-09-gasto-recurrente-sin-iva.png`.
¿SE NOTA?: termina en verde: la persona confía en un aviso que no llega.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Se construye el recordatorio, o se retira el texto?

### H-08 · H · media · (todas) · — — el comprobante del gasto: no se adjunta con teclado, se guarda como «.img» y cualquier miembro lo lee (E, C)
DIMENSIÓN: TECLADO · ROLES · DATOS
HACE:
- El `input type="file"` está `hidden` y el label que lo envuelve no es alcanzable con teclado (`negocio/Compras.tsx:691-700`). SOSPECHA por código (E).
- Toda imagen se guarda con extensión «.img»; el PNG quedó como `…/receipts/muh62dvz-45de2833.img`.
- El bucket `receipts` no tiene límite de tamaño ni de tipos. No se verificó el límite de 6 MB que promete el comentario (`apps/api/src/routes/treasury.ts:77`).
- La política de lectura solo mira la pertenencia a la empresa: un cajero lee todos los comprobantes (C).
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Quién ve los comprobantes de gastos?

### H-09 · H · media · E2 · dueño — un gasto con factura e IVA (la luz) no da crédito fiscal ni entra al libro, y la pantalla no lo avisa (F)
DIMENSIÓN: MODO
HACE: el gasto no tiene campos de factura, RIF ni IVA. El crédito del período sale solo de `supplier_invoices`. La factura de proveedor exige un producto por línea. Sigue abierta P-5.
¿NECESITA DECISIÓN DEL DUEÑO?: sí, resolver P-5. VALIDAR-TRIBUTARIO (F): ¿la factura de un servicio gravado da crédito y va al libro? ¿Qué datos mínimos hay que capturar?

### H-10 · H · media · (todas) · dueño — «Lo que debo → Ver qué debo» lleva a los gastos, no a lo que se debe (S, E)
DIMENSIÓN: PROMESA
HACE: el enlace lleva a /compras, que abre en la pestaña «Gastos» (`negocio/Compras.tsx:143-145`), y no en «Compras a proveedores».
EVIDENCIA: `capturas-recorrido/H/H-10-ver-que-debo-lleva-a-gastos.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### H-11 · H · media · (todas) · dueño — «Cuentas por pagar» no enseña nada hasta elegir un proveedor (S, E)
DIMENSIÓN: ESTADOS · PROMESA
HACE: no hay lista de a quién y cuánto se debe. Es el mismo patrón que F-13 en cuentas por cobrar.
EVIDENCIA: `capturas-recorrido/H/H-11-cxp-sin-proveedor-vacia.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Una vista de cartera?

### H-12 · H · media · E3 · — — SOSPECHA: el libro de compras no identifica el comprobante de retención (F)
DIMENSIÓN: DOCUMENTOS
HACE: `platform.purchases_book` devuelve el importe retenido, pero no el número ni la fecha del comprobante (`supabase/migrations/20260918120000_the_purchase_with_no_fiscal_document.sql:152-157`). No se puede reproducir, porque no hay retenciones (H-01).
¿NECESITA DECISIÓN DEL DUEÑO?: no. VALIDAR-SENIAT (F).

### H-13 · H · baja · E2 · — — la compra sin factura sale como «Factura» en /compras (S, E, F)
DIMENSIÓN: TEXTO
HACE: «Mercado Mayorista Informal · Factura», sin número (`negocio/Compras.tsx:363`). En lo fiscal no hay brecha: el libro la excluye y su IVA es 0.
EVIDENCIA: `capturas-recorrido/H/H-13-sin-factura-dice-factura.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### H-14 · H · baja · (todas) · — — SOSPECHA: el pago a proveedor no tiene aprobación, y el dueño crea el proveedor y aprueba su cuenta bancaria (C)
DIMENSIÓN: ROLES
HACE:
- Un solo back_office registra la factura y la paga.
- El dueño tiene `supplier.manage` y `supplier.bank_account.approve`. No se verificó si el servidor exige que quien crea no sea quien aprueba.
- Cargar reglas de retención es del contador y del dueño. Emitir el comprobante, de back_office y el dueño.
¿NECESITA DECISIÓN DEL DUEÑO?: sí (separación de funciones).

### H-15 · H · media · E2 · dueño — registrar un gasto tardó 3,9 s (validador)
DIMENSIÓN: TIEMPO
HACE: `POST /v1/expenses` tardó 3.862 ms, la única de las 206 peticiones del bloque por encima de 3 s. Fue el gasto de «Flete» en USD, sin foto, que el validador midió en el paso 005. Le siguen `GET /v1/me/permissions` con 1,3 s y `POST /v1/purchase-orders` con 1,3 s. No se diagnosticó la causa (¿la tasa del día?, ¿el asiento?).
EVIDENCIA: `.recorrido/…/H/005-E2-historial-gastos.json`, campo `api`.
¿SE NOTA?: la persona lo ve: el botón tarda casi 4 s.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### Confirmaciones de hallazgos anteriores
- **D-07:** confirmado con cifras (H-02).
- **E-11:** también en compras y gastos. Toda línea de asiento se escribe en VES, con tasa 1 y fuente «identidad» (`packages/domain/src/journal-generator.ts:449-453`): el pago de 20 USD, el de 50 USD y el flete de 5 USD no guardan su moneda. Si es diseño, necesita un ADR (C).
- **D-13:** el importe crudo con ocho decimales vuelve en el aviso de sobregiro de /admin/compras (H-05).

### Lo que se comprobó y está bien
- **Gastos (S, C):** la luz entró con D 5.1.05 / H 1.1.01 por 1.850, y el flete con D 5.1.05 por 4.278,31 (5 USD × 855,6625) / H 1.1.02. El historial los lista a los dos. La foto quedó guardada.
- **La regla de retención** exige citar la norma para cargarse: «Una regla sin norma citada es una retención inventada» (S, F).
- **La compra en Bs con factura** entra al libro con su crédito fiscal (F, C).
- **Sin registros huérfanos:** `quickSale` y `registerSupplierPayment` revierten ante un `err`, y la cola de asientos quedó vacía (C).
- **Invariantes y tiempos:** los corre el validador al cerrar el bloque. C no llegó a correrlos.

### Cierre del bloque H (validador)
GATE verde (el del último gate sobre el mismo código: 736 pasos, vitest 805 y pgTAP 1264, iguales a la línea base) · invariantes en 0 para E1, E2, E3, también con el bloque I en marcha; cola de asientos y outbox vacíos · `backdated_stock_in` y `money_landing_gaps` sin filas · 206 peticiones, **una por encima de 3 s**: `POST /v1/expenses`, 3,86 s (H-15) · documento con H-01..H-15 y sus capturas.

---

## Bloque I · Inventario

**Qué se hizo.**
- **E2:**
  - /inventario;
  - segundo depósito «Depósito Centro»;
  - traslado de 5 Harina caja de Principal a Centro;
  - conteo del queso: ajuste de −0,8 kg;
  - merma de 2 Galletas y vencido de 1 Café por «Salida»: fallaron las dos (I-01). La merma se registró después **por la API y sin motivo**, para entender el fallo, y es un dato creado fuera de la interfaz;
  - el kardex de la harina;
  - dos umbrales de reposición: Harina a 50 no dispara porque hay 66; Café a 30 sí, porque hay 23;
  - la pestaña de recetas;
  - el paso «¿A qué depósito?» de la llegada, con teclado (D-14).
- **E1:** tocar un producto agotado en la caja (E-13).

### I-01 · I · alta · (todas) · dueño — ninguna «Salida» de inventario (merma, consumo, regalo, vencido) se puede registrar desde la web (S, E, C)
PANTALLA: /admin/inventario → «Salida»
DIMENSIÓN: DATOS · PROMESA
PROMETE: el formulario exige «Motivo: merma, consumo interno, regalo…». El diálogo de confirmación dice «Registrar la salida».
HACE:
- La pantalla exige el motivo y lo envía como `reason` (`apps/web/src/pages/inventario/Inventario.tsx:494-496`, `:516`). El esquema lo acepta (`packages/schemas/src/inventory.ts:107-108`) y el dominio lo escribe (`packages/domain/src/inventory.ts:1082`).
- La base lo prohíbe: `inventory_moves_reason_chk CHECK ((kind IN ('ajuste','revaluacion')) = (reason IS NOT NULL))` (`supabase/migrations/20260827225113_drop_redundant_landed_cost_column.sql:58-61`).
- Toda salida muere con un 23514, que cae en el mapeo genérico: 422 «Los datos enviados no son válidos» y «Algo en el formulario no está bien. Revisa los campos marcados», sin ningún campo marcado (I-09).
- El commit `236e86d` (2026-09-15, «screen QA batch 1») añadió el motivo en la pantalla, el esquema y el dominio, sin migración. Es otra vez la regla de CLAUDE.md §3: un arreglo que introdujo el defecto siguiente.
- La salida posible hoy es un Ajuste con delta negativo.
EVIDENCIA:
- `capturas-recorrido/I/I-01-I-09-salida-422-sin-campo-marcado.png`.
- Por la API, `repro-salida.mjs`: con `reason` responde 422; sin él, 201.
- La definición viva del CHECK.
REPRODUCIR: Administración → Inventario → Salida → cualquier producto, cantidad y motivo → Registrar.
¿SE NOTA?: la persona lo ve, y no sabe qué corregir.
¿NECESITA DECISIÓN DEL DUEÑO?: sí, en cuanto al diseño: ¿la salida guarda su motivo, cambiando el CHECK, o lo lleva en `note`? VALIDAR-CONTABLE (C): ¿la merma y el vencido van a una cuenta propia y no a 5.1.04 (I-11)?

### I-02 · I · alta · (todas) · — — los cuatro tests de «Salida» están en verde porque no mandan el motivo que la web siempre manda (C)
DIMENSIÓN: DATOS (antitest)
HACE:
- Ninguno lleva `reason`: `apps/api/test/e2e-inventory.test.ts:171-177`, `e2e-inventario-en-el-mayor.test.ts:291-298`, `e2e-purchases.test.ts:394-400` y `packages/domain/test/inventory.test.ts:95`.
- El commit `236e86d` sumó 224 líneas de `e2e-qa-pantalla-lote1.test.ts` y ninguna prueba una salida con motivo.
- Es la familia de CLAUDE.md §3 «un test que pasa gracias a un bug». Pasa lo mismo con la NC de proveedor (H-03).
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### I-03 · I · alta · E2 · cualquiera — D-14 confirmado: con dos depósitos, «¿A qué depósito?» atrapa al teclado (S, E)
PANTALLA: /admin/llego-mercancia (`apps/web/src/pages/negocio/LlegoMercancia.tsx:1108-1134`)
DIMENSIÓN: TECLADO
HACE:
- El foco en la tarjeta más Enter elige el depósito, pero no avanza. Tab más Enter tampoco.
- El paso no tiene botón «Seguir», solo «Atrás». `onClick` hace `setDeposito` y `avanzar()`; `onKeyDown` solo `setDeposito`.
- La tarjeta del Principal se lee «Principal Principal».
EVIDENCIA: `capturas-recorrido/I/I-03-a-que-deposito-enter-no-avanza.png`, idéntica antes y después de Enter.
¿SE NOTA?: la persona queda atascada, sin ningún error.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### I-04 · I · alta · (todas) · dueño — las recetas existen en pantalla y son inalcanzables: ningún producto puede volverse compuesto (E, C)
PANTALLA: /admin/inventario → Recetas
DIMENSIÓN: PROMESA
HACE:
- «Consumo por receta» y «Definir receta…» buscan compuestos, y la búsqueda da «Sin resultados».
- `is_composed` solo se lee (`packages/schemas/src/products.ts:85`). El alta y la edición de producto no lo tienen, y el único test del consumo crea el compuesto con un UPDATE directo (`apps/api/test/e2e-inventory-extensions.test.ts:101`).
- SOSPECHA (C): aunque existiera un compuesto, venderlo no descontaría los ingredientes (`sales.ts:928`, `:942`), contra lo que promete el mensaje de la base.
EVIDENCIA: `capturas-recorrido/I/I-04-recetas-sin-compuestos.png`.
¿SE NOTA?: la persona lo ve, y no hay dónde aprender a crear uno.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Se construye la mitad que falta, o se retira la pestaña?

### I-05 · I · media · E2 · dueño — un producto inactivo con existencia desaparece de «qué tengo» y su mercancía queda congelada (S, E, C)
PANTALLA: /inventario · catálogo (inactivar)
DIMENSIÓN: ESTADOS · DATOS
HACE:
- «Cloro caja x12», pausado en el bloque C, tiene 25 unidades por Bs 213.615,93.
- /inventario lo oculta (`only_active=1`, `negocio/Inventario.tsx:82`) y no lo cuenta en «Con existencia». Administración → Inventario sí lo lista.
- No se puede vender, sacar, ajustar ni trasladar: el trigger LAD38 rechaza mover un producto inactivo.
- Inactivar un producto con existencia no avisa (`packages/domain/src/products.ts:204-206`). Desactivar un depósito sí lo comprueba.
- Su valor sigue en el mayor (1.1.04).
EVIDENCIA: `capturas-recorrido/I/I-05-inventario-sin-el-inactivo.png`.
¿SE NOTA?: termina en verde: el número de «Con existencia» es menor de lo real.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Inactivo significa «no se vende» o «no existe»? ¿Se avisa al inactivar?

### I-06 · I · media · E2 · dueño — el kardex mezcla los saldos de los dos depósitos y enseña tipos crudos (S, E, C)
PANTALLA: /admin/inventario → Kardex (`Inventario.tsx:321`, `:372-381`)
DIMENSIÓN: DATOS · TEXTO
HACE:
- El kardex pide solo `product_id`, aunque la fila es por depósito y el endpoint admite `warehouse_id`.
- Una sola columna «Saldo» da 5 (Centro) y luego 66 (Principal), sin columna de depósito. `quantity_after` es por posición (ADR-0034).
- El tipo se lee «transferencia_in» y «transferencia_out».
EVIDENCIA: `capturas-recorrido/I/I-06-kardex-dos-depositos-tipos-crudos.png`.
¿SE NOTA?: la persona lo ve, y no lo puede leer.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### I-07 · I · media · (todas) · dueña — «¿contaste mercancía?» lleva a un ajuste que pide la diferencia calculada a mano (S, E)
PANTALLA: /inventario → Administración → Inventario → Ajuste
DIMENSIÓN: PROMESA
HACE: el enlace dice «¿Llegó, salió o contaste mercancía?», pero no hay dónde escribir lo contado. El Ajuste pide «Delta (con signo)»: «Ej. -3 para faltante». Un error de signo entra igual de válido, sin ningún aviso. Otros sistemas capturan la cantidad contada (E: Loyverse).
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Un verbo «conteo»?

### I-08 · I · media · (todas) · — — mover y ajustar el inventario están separados solo de nombre (C)
DIMENSIÓN: ROLES
HACE: `inventory.adjust` se describe como «(supervisor)», pero todo rol con `inventory.move` tiene también `inventory.adjust`: back_office, store_manager y warehouse_ops. El almacenista, además, tiene `inventory.negative`. Puede sacar mercancía y cuadrar el faltante con un ajuste negativo, sin supervisor.
EVIDENCIA: `role_permissions`.
¿NECESITA DECISIÓN DEL DUEÑO?: sí.

### I-09 · I · media · (todas) · — — «Revisa los campos marcados», y ningún campo se marca (E)
DIMENSIÓN: TEXTO · ESTADOS
HACE: los diálogos de movimiento no marcan campos: solo tienen un `MensajeError` al pie (`Inventario.tsx:655-659`). Cualquier 422 futuro de esta pantalla repetirá la promesa vacía. Además, en la salida salen dos avisos a la vez: uno en la confirmación y otro detrás.
EVIDENCIA: `capturas-recorrido/I/I-01-I-09-salida-422-sin-campo-marcado.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### I-10 · I · baja · E2 · dueño — «Ajuste registrada» (S, E)
DIMENSIÓN: TEXTO
HACE: el toast es `${etiqueta} registrada`, siempre en femenino, aunque el código sabe que «ajuste» es masculino (`OPERACION.ajuste.articulo = "el"`).
EVIDENCIA: `capturas-recorrido/I/I-10-ajuste-registrada.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### I-11 · I · baja · E2 · — — el asiento de una salida no lleva el motivo, que era la razón de pedirlo (C)
DIMENSIÓN: CONTABILIDAD
HACE: la merma (por API) se asentó D 5.1.04 «Ajuste de inventario» / H 1.1.04, con la descripción «Salida de existencias» (`inventory.ts:1103-1106`). El ajuste sí lleva el motivo en la descripción, y el traslado no tiene asiento, que es lo correcto con un solo 1.1.04.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. VALIDAR-CONTABLE: ¿una cuenta propia para faltantes y mermas (ADR-0060:83)?

### I-12 · I · baja · (todas) · — — SOSPECHA: «Por agotarse» daría siempre en alerta los productos llevados por lotes, y cuenta los inactivos (C)
DIMENSIÓN: DATOS
HACE: `platform.low_stock_products` une con `stock_balances` en `lot_id is null` y no filtra por `status`. Hoy es latente: no hay productos con lote (C-07). Es la misma función en /inventario y en Inicio, con el umbral por depósito.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### Confirmaciones de hallazgos anteriores
- **D-14:** confirmado con dos depósitos (I-03).
- **E-13:** el aviso de la tarjeta «Agotado» sí se ve: «Recarga telefónica: sin existencia · Registra la entrada de mercancía antes de venderlo» (`capturas-recorrido/I/I-E13-agotado-avisa.png`).
- **C-07:** «Por vencer (0)» existe, pero ningún producto lleva lotes.

### Lo que se comprobó y está bien
- **Depósito y traslado:** el depósito nuevo se crea con su código, y el binding del dueño a ese depósito se crea solo. El traslado sale y entra al mismo costo (15.380,3466), sin asiento, que es lo correcto (S, C).
- **Ajuste con motivo:** va a 5.1.04 con el motivo en la descripción (C).
- **Umbral:** «Por reponer (1) · CAF-12 faltan 7», con el mismo cálculo en /inventario y en Inicio (S, C).
- **Inactivo:** la caja no puede vender el producto inactivo; no hay fuga (C).
- **Invariantes y tiempos:** los invariantes de E1, E2 y E3 dan 0. Hubo 201 peticiones, ninguna por encima de 3 s; la más lenta, la salida que falla, 0,78 s (C).

### Cierre del bloque I (validador)
GATE verde (el del último gate sobre el mismo código: 736 pasos, vitest 805 y pgTAP 1264, iguales a la línea base) · invariantes en 0 para E1, E2, E3, también con el bloque J en marcha; cola de asientos y outbox vacíos · `backdated_stock_in` y `money_landing_gaps` sin filas · 201 peticiones, ninguna por encima de 3 s (la más lenta, `POST /v1/inventory/issues`, 0,78 s) · documento con I-01..I-12 y sus capturas.

---

## Bloque J · Mi dinero

**Qué se hizo.**
- **E1 (/dinero):**
  - «Traer del BCV»;
  - intento de cargar una tasa de ayer, a mano, por la API;
  - cierre de «Caja de la bodega» sin diferencia;
  - cierre de «Caja en dólares» con diferencia: faltó 1 USD;
  - forma de pago nueva, «Pago móvil Banesco → Banesco»;
  - «Mover plata» de la caja al banco.
- **E2:** cierre de «Caja Bs», que estaba en −120.000 por el sobregiro confirmado del bloque D.

### J-01 · J · crítica · (todas) · dueño — «Mover plata» entre dos cuentas de la misma moneda falla siempre con un error del servidor (S, E, C)
PANTALLA: /dinero → «Mover plata» (`apps/web/src/pages/negocio/Dinero.tsx:604-725`)
DIMENSIÓN: DINERO · ESTADOS · PROMESA
PROMETE:
- «Esto no gasta ni cobra nada: la misma plata cambia de sitio».
- La pantalla lo ofrece como el remedio del dinero en «Sin asignar»: «Muévelos con “Mover plata”» (`Dinero.tsx:374`).
- ADR-0062 §3: «Si las dos cajas mapean a la misma cuenta contable, el asiento se posta igual».
HACE:
- 500 «Algo salió mal de nuestro lado». En Postgres: `ON CONFLICT DO UPDATE command cannot affect row a second time`.
- En las tres empresas, toda cuenta en Bs apunta a 1.1.01 y toda cuenta en USD a 1.1.02: las cuentas creadas desde la web nunca reciben una cuenta contable propia.
- El asiento de la transferencia tiene un débito y un crédito sobre la misma cuenta. `platform.apply_ledger_balance` las mete en un solo `INSERT … ON CONFLICT (company_id, account_id, period_id)` (`supabase/migrations/20260827233538_create_accounting.sql:698-727`), y Postgres lo rechaza entero.
- No depende del día ni de la moneda, solo de que las dos cuentas compartan cuenta contable. Con la configuración de fábrica, eso es siempre.
- **Antitest:** el E2E `apps/api/test/e2e-mover-dinero.test.ts:172-191` crea a propósito dos cuentas contables distintas (1.1.91 y 1.1.92), así que nunca prueba el caso por omisión.
- SOSPECHA (C): cualquier otro asiento con dos líneas sobre la misma cuenta daría el mismo 500.
EVIDENCIA:
- `capturas-recorrido/J/J-01-mover-plata-500.png`.
- `company_accounts.ledger_account_id` repetido en las tres empresas.
- La repetición por la API con 10 Bs da el mismo 500. `treasury_transfers` sigue vacía.
REPRODUCIR: cualquier empresa → Mi dinero → una caja en Bs → Mover plata → otra cuenta en Bs.
¿SE NOTA?: la persona lo ve, sin salida. El E2E termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: no para el arreglo. Sí para el diseño: ¿cada cuenta de tesorería nace con su subcuenta contable, o el asiento agrupa las líneas de la misma cuenta?

### J-02 · J · alta · E2 · dueño — cerrar una caja en sobregiro convierte en ganancia el dinero que la dueña puso de su bolsillo (S, E, C)
PANTALLA: /dinero → «Cerrar la caja» (`packages/domain/src/treasury.ts:704-714`, `:770-784`)
DIMENSIÓN: CONTABILIDAD · TEXTO
PROMETE: «si no coincide, quedará anotado con tu motivo». Los ejemplos de «¿De dónde sale la diferencia?» son todos de faltante.
HACE:
- «Caja Bs» estaba en −120.000. Se contó 0, y el cierre dijo «**Sobraron** Bs. 120.000,00».
- El asiento fue D 1.1.01 120.000 / H 5.1.06 «Faltantes y sobrantes de caja» 120.000, en una cuenta de resultado: la ganancia sube 120.000 Bs.
- El motivo guardado dice «el pago del café salió de mi bolsillo», es decir, un aporte de la dueña, y el sistema no tiene cómo registrarlo así. ADR-0062 §4 justifica el sobregiro («el dinero que ya existía no se ha cargado»), pero no dice cómo se salda.
EVIDENCIA: `capturas-recorrido/J/J-02-caja-en-negativo-al-cerrar.png` y `J-02-sobraron-120000.png`. El asiento «Cierre de caja Caja Bs: sobrante».
¿SE NOTA?: la persona ve «Sobraron», pero no la consecuencia contable. Termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: sí.
- VALIDAR-CONTABLE: ¿contrapartida en aporte del socio, en una cuenta por pagar al socio o en saldo inicial?
- ¿El cierre de una caja con saldo negativo pregunta de dónde salió el dinero?

### J-03 · J · alta · (todas) · encargado — el «cierre de caja» del servidor acepta cualquier cuenta, también el banco, y revela su saldo a quien no debería verlo (C)
DIMENSIÓN: ROLES · DATOS
HACE:
- `treasury.ts:670` exige solo `cash.close` y lee la cuenta sin filtrar por tipo (`:678-688`). Solo la pantalla lo limita a las cajas.
- El encargado (`store_manager`) tiene `cash.close` sin `treasury.read`. Por ADR-0048 solo ve LA CAJA, pero por la API puede:
  - leer el saldo del banco en el mensaje «el sistema esperaba X»;
  - con un motivo, dejar el banco en 0: el faltante se asienta a 5.1.06 y el saldo se ajusta.
EVIDENCIA: un cierre de «Banesco» (tipo banco) por la API da 422 «Contaste 0.00 y el sistema esperaba 10130.09». Llegó al cálculo, así que no hay filtro. No se escribió nada. No se ejecutó con un encargado real: se mira en N.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### J-04 · J · media · E2 · dueño — «Lo que debo» y la caja en dólares no cuadran con el mayor, y ningún invariante lo mira (S, E, C)
PANTALLA: /dinero («Lo que debo») · mayor 2.1.01 y 1.1.02
DIMENSIÓN: DINERO · CONTABILIDAD
HACE:
- «Lo que debo Bs. 1.288.114,33» es la deuda en USD a la tasa de hoy (`supplier_debt_today`, ADR-0047). El mayor 2.1.01 dice 1.286.285,68.
- La diferencia es 1.804,67 no realizados, sin asiento de revaluación, más los 23,98 realizados de H-02.
- En la caja en divisas de E1, 1.1.02 vale 3.416,66 por 4 USD; a la tasa de hoy serían 3.422,65.
- En Bs, tesorería y mayor cuadran. En USD nadie lo mira: falta un invariante «cajas en divisas = 1.1.02» y otro «deuda de proveedores a tasa de registro = 2.1.01».
- Es el lado de las deudas de F-04. La pantalla no dice que la cifra es «a la tasa de hoy».
EVIDENCIA: `capturas-recorrido/J/J-04-lo-que-debo-revaluado.png`.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. VALIDAR-CONTABLE: ¿se revalúa? ¿Una nota «a la tasa de hoy»?

### J-05 · J · baja · (todas) · dueño — el motivo del cierre se guarda, pero la pantalla no lo enseña (C)
DIMENSIÓN: ESTADOS
HACE: el motivo está en `cash_closings.reason` y en el acta, y `GET /v1/cash-closings` lo devuelve. «Últimos cierres» solo enseña la fecha, la cuenta y «Sobraron…» (`Dinero.tsx:419-426`).
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### Confirmaciones de hallazgos anteriores
- **D-09 y el paso del tiempo (F):** la tasa de un día pasado no se puede cargar. La pantalla no tiene campo, y la API responde 409 `RATE_ONLY_FROM_BCV` «Solo se usa la tasa del BCV y ya no se escribe a mano». Es el diseño de ADR-0064.
- **H-02 (D-07):** C lo confirma otra vez con los 23,98 Bs del abono a 000123.
- **E-11:** las 14 líneas de 1.1.02 de la base están en VES. Desde el mayor no se sabe cuántos dólares hay en la caja.

### Lo que se comprobó y está bien
- **Tasa (C):** «Traer del BCV» no duplica la tasa del día (`exchange_rates_day_key`) y exige `fx.rate.manage`. Si el BCV no responde, sale `UPSTREAM_UNAVAILABLE`.
- **Cierres y formas de pago (S):** el cierre sin diferencia dice «Cuadró exacta», y el de USD, «Faltaron USD 1,00», con el faltante a 855,66 en 5.1.06 (`capturas-recorrido/J/J-cierre-usd-faltaron-1.png`). La forma de pago nueva queda enlazada a su cuenta.
- **Roles (C):** cerrar caja lo hacen el dueño, el administrador y el encargado, no el cajero. Mover plata y crear cuentas o formas de pago, el dueño y el administrador.
- **Invariantes y tiempos:** los invariantes de E1, E2 y E3 dan 0, `treasury_reconciliation` incluido. Hubo 124 peticiones, ninguna por encima de 3 s; la más lenta, 451 ms. **Esos ceros no cubren J-02 ni J-04.**

### Cierre del bloque J (validador)
GATE verde (el del último gate sobre el mismo código: 736 pasos, vitest 805 y pgTAP 1264, iguales a la línea base) · invariantes en 0 para E1, E2, E3, también con el bloque K en marcha; cola de asientos y outbox vacíos · `backdated_stock_in` y `money_landing_gaps` sin filas · 124 peticiones, ninguna por encima de 3 s (la más lenta, `GET /v1/negocio/resumen`, 0,45 s) · documento con J-01..J-05 y sus capturas.

---

## Bloque K · Contabilidad con el contador

**Qué se hizo.** En E2, con el contador (contador@): se creó su cuenta y el dueño lo agregó con el oficio «Contador»; aterriza en Contabilidad (`capturas-recorrido/K/K-contador-aterriza.png`). Con él:
- plan de cuentas y diario;
- asiento manual descuadrado: la pantalla no deja guardar, y la API responde 409;
- asiento cuadrado entre cuentas de resultado (5.1.06 / 5.1.05), guardado como borrador y posteado;
- un asiento por la API fechado el 20/08, antes de que existiera la empresa;
- mayor de CxC con y sin fecha «desde»;
- comprobación de hoy y del 24/09;
- estados financieros;
- cierre de agosto;
- intento de postear en agosto cerrado;
- reapertura con motivo.

**Errores del guion.**
- En la primera pasada no posteó ni pulsó «Generar»: en el diario, los borradores sin número quedan en la última página.
- En la segunda no pudo cerrar agosto, porque tenía un borrador: con borradores el botón está deshabilitado, que es la regla.
- La tercera pasada completó el cierre.

### K-01 · K · crítica · (todas) · contador — ningún período cerrado se puede reabrir, y el único test de reapertura está en verde gracias al defecto (S, E, C)
PANTALLA: /admin/contabilidad → Cierre → «Reabrir»
DIMENSIÓN: CONTABILIDAD · PROMESA
PROMETE: el botón «Reabrir el período» pide un motivo obligatorio. El 409 de postear en un mes cerrado dice «Reabrirlo exige permiso y motivo escrito».
HACE:
- `reopenFiscalPeriod` pone `status='reopened'` y no limpia `closed_at` ni `closed_by` (`packages/domain/src/accounting.ts:782-787`).
- El CHECK `fiscal_periods_closed_chk`, `(status='closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL)`, lo rechaza siempre (`supabase/migrations/20260827233538_create_accounting.sql:162-163`).
- El 23514 cae en el mapeo genérico: 422 «Los datos enviados no son válidos… Revisa los campos marcados».
- Los dos CHECK y el estado nacieron juntos. El defecto está en el caso de uso desde el principio.
- **Antitest:** el pgTAP `supabase/tests/025_accounting_test.sql:110-116` es la única prueba de reapertura. Usa un motivo corto y espera 23514, que también saltaría con un motivo válido por el otro CHECK: pasa por la razón equivocada. No hay E2E de reapertura.
EVIDENCIA: `capturas-recorrido/K/K-01-reabrir-periodo-422.png`. En Postgres: `violates check constraint "fiscal_periods_closed_chk"`.
REPRODUCIR: cerrar un mes → Reabrir → motivo de 10 o más caracteres → Reabrir el período.
¿SE NOTA?: la persona lo ve, y el mensaje le hace creer que escribió algo mal.
¿NECESITA DECISIÓN DEL DUEÑO?: no para el arreglo. Ver K-02.

### K-02 · K · alta · (todas) · contador — SOSPECHA: aun arreglando K-01, volver a cerrar un período reabierto también violaría un CHECK: el modelo solo admite un ciclo (C)
DIMENSIÓN: CONTABILIDAD
HACE: `closeFiscalPeriod` (`accounting.ts:744-748`) no limpia `reopened_*`, y `fiscal_periods_reopened_chk` rechazaría `status='closed'` con `reopened_at` puesto. Limpiarlo borraría el motivo de la reapertura.
EVIDENCIA: deducción del texto del CHECK; no se ejecutó.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿La historia de reaperturas vive en `audit_events` o en una tabla propia?

### K-03 · K · alta · (todas) · contador — SOSPECHA: el cierre del ejercicio es imposible si diciembre ya está cerrado (C)
DIMENSIÓN: CONTABILIDAD
HACE:
- `executeYearEndClose` postea el 31/12 en el período de diciembre (`accounting.ts:846-847`, `:910-943`). Si diciembre está cerrado, que es el orden normal, el trigger LAD61 lo rechaza, y diciembre no se puede reabrir (K-01).
- No comprueba antes el estado de diciembre ni si hay borradores.
- El comentario dice que el resultado pasa por «Resultado del ejercicio», pero el código lee `year_result` y no lo usa: va directo a utilidades acumuladas.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Cierre anual antes de diciembre, o un período 13 de ajustes?

### K-04 · K · alta · E2 · dueño — SOSPECHA: una factura de proveedor que llega tarde, de un mes cerrado, no se puede registrar con su fecha (C)
DIMENSIÓN: CONTABILIDAD · MODO
HACE: compras asienta en la fecha de la factura (`purchases.ts:1205`), el gasto en la suya (`:1749`) y la NC en la suya (`:1931`). Con el mes cerrado, LAD61 revienta la transacción y la factura no entra (409). Con K-01, la factura de agosto que llegó tarde (el motivo que escribió el contador) no se puede registrar nunca.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. VALIDAR-CONTABLE / VALIDAR-TRIBUTARIO: ¿en su fecha, reabriendo, o en el período en curso? ¿En qué libro de compras entra?

### K-05 · K · media · E2 · contador — cualquier fecha entre el año 2000 y el 2200 crea su período sin preguntar; el asiento de agosto entró antes de que existiera la empresa (S, C)
DIMENSIÓN: DATOS · TIEMPO
HACE:
- `platform.period_for_date` crea el período `open` (`create_accounting.sql:555-579`), sin tope por el alta de la empresa ni por el ejercicio.
- El período 2026-08 de E2 nació junto con el asiento n.º 58, fechado el 20/08. La empresa se creó el 24/09.
- Un borrador en un período cerrado se crea (201) y solo falla al postearlo.
- Ventas no se puede fechar hacia atrás (`diaNegocio`). Compras sí, por fecha de factura, nota o gasto (SOSPECHA).
EVIDENCIA: `capturas-recorrido/K/K-05-agosto-nacio-solo-y-cerrado.png`. En la base, `fiscal_periods` de E2.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Límite inferior de fechas? ¿Rechazar el borrador en un período cerrado ya al crearlo?

### K-06 · K · media · E2 · contador — «postéalos o descártalos», pero un borrador no se puede descartar: el de agosto queda zombi (C)
DIMENSIÓN: ESTADOS
HACE: el cierre pide «Postéalos o descártalos» (`accounting.ts:730`), pero no hay endpoint de descarte (`apps/api/src/routes/accounting.ts`: solo crear, postear y reversar). El borrador del 21/08, en agosto cerrado, no se puede postear, ni reabrir su período, ni descartar.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### K-07 · K · alta · E2 · contador — el mayor sin fecha «desde» enseña un saldo inicial falso, igual al final (S, E, C)
PANTALLA: /admin/contabilidad → Mayor (`apps/api/src/routes/accounting.ts:369-402`)
DIMENSIÓN: CONTABILIDAD
HACE:
- Sin `from`, `null::date - 1` da null, y `recompute_ledger` devuelve el saldo total. Sale «inicial Bs. 88.658,52 · final Bs. 88.658,52», con dieciséis movimientos en medio.
- Con «desde 25/09» sale bien: 136.606,11 → 88.658,52.
- Además, `running_balance` (apertura + acumulado) cuenta los movimientos dos veces: la última fila vale el doble del saldo (177.317,04). La web no pinta esa columna; está en el contrato de la API.
EVIDENCIA: `capturas-recorrido/K/K-07-mayor-inicial-igual-final.png`.
¿SE NOTA?: termina en verde: el saldo se ve razonable.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### K-08 · K · media · E2 · contador — los estados financieros enseñan cuatro y seis decimales, porque los importes funcionales de compras e inventario no se redondean al céntimo (S, E, C)
DIMENSIÓN: DINERO · TEXTO
HACE:
- Los importes funcionales de compras e inventario se guardan como total × tasa a 8 decimales (política `purchases:document:8:HALF_UP`). La factura 000123 queda en 1.100.207,46012 Bs de CxP.
- Los reportes suman eso. `formatMoney` se niega a redondear, y la web cae a `exactoVestido` (`apps/web/src/money.ts:25-42`): «Bs. 7.303.138,712408», «Bs. 414,3475», y el resultado en 211.461,809058.
- El saldo de CxP en Bs no se puede liquidar exacto con un pago de dos decimales.
EVIDENCIA: `capturas-recorrido/K/K-08-estados-seis-decimales-y-sobrante.png`. En E2 hay 62 líneas de asiento con más de dos decimales.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. VALIDAR-CONTABLE: ¿qué política de redondeo tiene el importe funcional, y a dónde va el residuo?

### K-09 · K · media · (todas) · persona invitada — quien se registra para que lo agreguen a un negocio ajeno cae en «Vamos a montar tu negocio» (E)
PANTALLA: `/` sin empresa (`apps/web/src/pages/registro/Registro.tsx:455-473`)
DIMENSIÓN: PROMESA · ESTADOS
HACE: toda cuenta sin empresa ve «Vamos a montar tu negocio en Ladino. Te toma menos de dos minutos.» y «Empezar». No hay «me van a agregar a un negocio», y la única otra salida es «Salir». Le pasa al contador, y en N le pasa a cualquier rol invitado. SOSPECHA: si pulsa «Empezar», funda una empresa fantasma.
EVIDENCIA: `capturas-recorrido/K/K-09-contador-vamos-a-montar-tu-negocio.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Una rama «te invitaron»?

### K-10 · K · media · E2 · contador — la miga «Inicio» lleva al contador a un callejón sin salida (E)
DIMENSIÓN: ESTADOS
HACE: la miga «Inicio» se pinta en todo `/admin/*` sin mirar permisos (`apps/web/src/app/shell.tsx:608-610`). Para el contador, `/v1/negocio/resumen` da 403: «No se pudo cargar cómo va el negocio» y «Reintentar», que no puede funcionar. `SinAcceso` existe y no se usa ahí.
EVIDENCIA: SOSPECHA de la ruta completa. El 403 del endpoint para este rol está confirmado.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### K-11 · K · media · E2 · contador — SOSPECHA: el contador ve «Nuevo cliente» e «Importar», y el servidor lo rechaza (C)
DIMENSIÓN: ROLES
HACE:
- En /admin/clientes los botones no miran el permiso (`apps/web/src/pages/clientes/Clientes.tsx:189-194`, `:246`), y el servidor exige `customer.manage`.
- El contador tiene 22 permisos, sin `sales.*`, `customer.manage`, `product.manage`, `inventory.*`, `purchase.*` ni `treasury.read`.
- El menú le abre Ventas, CxC, Clientes, Precios, Inventario, Productos, Compras y Facturación fiscal. En esas otras pantallas las acciones sí están condicionadas.
EVIDENCIA: lectura del código. No se reprodujo en pantalla (bloque N).
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### K-12 · K · baja · E2 · contador — «Borrador creado · Asiento 01a0d990»: un pedazo del id en lugar de algo que se pueda buscar (S, E)
DIMENSIÓN: TEXTO
HACE: `Contabilidad.tsx:1155` usa `r.id.slice(0, 8)`, porque el borrador todavía no tiene número. El diario no filtra por ese texto.
EVIDENCIA: `capturas-recorrido/K/K-12-asiento-id-en-vez-de-numero.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### K-13 · K · baja · E2 · contador — «el período 2026-8 está CERRADO» (S, E)
DIMENSIÓN: TEXTO
HACE: el mensaje de `PERIOD_CLOSED` empieza en minúscula, lleva el mes sin cero y «CERRADO» en mayúsculas.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### K-14 · K · baja · E2 · contador — el diario no cabe a 1366 px: la columna de débitos se corta (S, E)
DIMENSIÓN: FORMA
EVIDENCIA: `capturas-recorrido/K/K-14-diario-no-cabe.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### K-15 · K · baja · E2 · contador — cada pantalla del contador pide `/v1/treasury/accounts` y recibe 403 (S, C)
DIMENSIÓN: ROLES
HACE: `useEmpezarPendiente` (`shell.tsx:113-125`) lo pide al montar y cada 60 s, sin mirar el permiso. Se traga el error y no rompe nada: es ruido en la consola y en la red.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### Confirmaciones de hallazgos anteriores
- **J-02:** el estado de resultados de E2 da «5.1.06 Faltantes y sobrantes de caja −Bs. 119.000,00», el «sobrante» de la caja en negativo menos la reclasificación. El resultado del ejercicio, 211.461,81, está inflado en 120.000.
- **E-11:** las catorce combinaciones de origen del diario de E2 están en VES, con tasa 1 y fuente «identidad». Si es diseño o defecto lo decide el dueño (ADR-0020).

### Lo que se comprobó y está bien
- **Partida doble (S):** la pantalla no deja guardar un asiento descuadrado (`capturas-recorrido/K/K-descuadrado-no-deja-guardar.png`), y la API lo rechaza con 409 `ENTRY_UNBALANCED` y la diferencia. Postear exige un paso aparte y lo hace inmutable.
- **Comprobación y cierre (S):**
  - la comprobación cuadra, a hoy y a una fecha pasada;
  - el cierre de un mes con borradores está bloqueado, y sin borradores cierra;
  - un asiento en un mes cerrado no se postea (409 `PERIOD_CLOSED`);
  - la reapertura exige un motivo de al menos 10 caracteres.
- **Estados financieros (S):** el balance cuadra, activo = pasivo + patrimonio.
- **Roles (C):** el contador no puede emitir, anular ni cobrar, y en el detalle de factura los botones están condicionados por permiso.
- **Invariantes y tiempos:** los corre el validador al cerrar el bloque. C no llegó a correrlos.

### Cierre del bloque K (validador)
GATE verde (el del último gate sobre el mismo código: 736 pasos, vitest 805 y pgTAP 1264, iguales a la línea base) · invariantes en 0 para E1, E2, E3, con la cola de asientos y el outbox vacíos · 196 peticiones, ninguna por encima de 3 s (la más lenta, 1,69 s) · documento con K-01..K-15 y sus capturas.

**Un rojo que resultó ser del guion, no de Ladino.** El validador vio `ledger_balances vs recompute_ledger = 4` en E2, en las cuentas 5.1.05 y 5.1.06. La consulta del guion (`scripts/recorrido/invariantes.sql`) comparaba cada fila de `ledger_balances`, que es una por cuenta y período, con el total histórico de `recompute_ledger(…, null, null)`. Con el asiento de agosto, esas dos cuentas pasaron a tener movimientos en dos períodos. Sumando los períodos por cuenta, la diferencia es **0** en las tres empresas. La consulta quedó corregida para los bloques siguientes.

---

## Bloque L · Libros y declaraciones

**Qué se hizo.**
- **Libros de septiembre:** ventas y compras de E2 y E3, y retenciones de IVA de E3, cada uno con su conciliación con el mayor y sus generaciones.
- **Exportación:** el libro de ventas de E2 se exportó en «CSV con las columnas de PA 071 y PA 102», NO OFICIAL, con hash 0039793d…
- **Declarar IVA:** agosto y septiembre de E2 y E3.
- **Otros:** vencimientos e IGTF de la quincena de E3.

**Error del guion.** En la primera pasada, el guion buscaba el botón de exportar en la pestaña equivocada. La segunda pasada exportó.

**No se pudo probar** el encadenamiento real de dos meses con datos: la empresa nació el 24/09 (ver F).

### L-01 · L · crítica · E2, E3 · contador — el libro de ventas suma las notas de crédito en vez de restarlas, y el CSV que se entrega al contador infla el débito fiscal (S, E, F, C)
PANTALLA: /admin/libros → Libro de ventas · exportación
DIMENSIÓN: DOCUMENTOS · DINERO
PROMETE: «El libro se calcula desde los documentos cada vez: por eso cuadra con ellos».
HACE:
- Las NC salen con base e IVA **positivos**, en pantalla y en el CSV. `platform.sales_book` toma `d.tax_amount` sin signo según el tipo (`supabase/migrations/20260916170000_fiscal_amounts_in_bolivars.sql:148-149`).
- La conciliación (`platform.book_ledger_reconciliation`, `20260831173150_create_fiscal_books.sql:452-457`) suma esas filas tal cual y da **«NO cuadra»**:
  - E2: libro 93.105,79 contra mayor 79.024,23, diferencia **14.081,56 = 2 × (478,50 + 6.562,28)**;
  - E3: diferencia **1.691,84 = 2 × 845,92**.
- La declaración sí resta (`recompute_iva_period`, `case … 'credit_note' then -1`). Libro y declaración divergen, contra el art. 72 del Reglamento LIVA.
- En compras, la NC va en negativo, por el criterio R-1 del dueño (`20260918120000_the_purchase_with_no_fiscal_document.sql:112`). En ventas no.
- Si el contador declara desde el libro o desde el CSV, declara de más. En E2 el excedente bajaría de 100.754,93 a 86.673,37: crédito perdido, recuperable solo con una sustitutiva.
- Llevar el libro sin sus formalidades es ilícito formal (COT art. 102).
EVIDENCIA: `capturas-recorrido/L/L-01-libro-ventas-nc-en-positivo.png`, `L-01-L-06-conciliacion-no-cuadra-E2.png`, `L-01-conciliacion-no-cuadra-E3.png` y `L-01-L-07-libro-ventas-E2-exportado.csv` (filas de las NC en positivo).
REPRODUCIR: E2 → Libros → Libro de ventas → septiembre → Conciliación · Exportar.
¿SE NOTA?: la conciliación dice «NO cuadra», con un diagnóstico falso (L-06). El CSV termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: no para el signo, que ya está resuelto en R-1 y en la planilla. VALIDAR-TRIBUTARIO (F): ¿sanción, y basta corregir el libro?

### L-02 · L · alta · — · — — los tests no pueden ver L-01: el que cruza libro y declaración aplica el signo él mismo, la conciliación nunca se probó con una NC y nadie la corre (C)
DIMENSIÓN: DATOS (antitest)
HACE:
- `supabase/tests/046_declarations_igtf_test.sql:170` hace `case when b.kind='credit_note' then -b.iva_debito`, justo lo que la conciliación no hace.
- Los tests de conciliación (pgTAP 027:340-410 y `apps/api/test/e2e-fiscal-books.test.ts:350-370`) no tienen ninguna NC.
- La conciliación «libro = mayor + cola» cruza fiscal con contabilidad, pero no está en ningún gate ni en la tabla de invariantes de CLAUDE.md §3. Es la pregunta de §3: ¿quién la mira? Nadie.
- El guion del recorrido la mira desde este bloque, como informe.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### L-03 · L · alta · E3 · — — el TXT de retenciones de IVA no sigue el orden de campos del instructivo publicado del SENIAT (F)
DIMENSIÓN: DOCUMENTOS
HACE:
- El instructivo reproducido (RI_DRIVA2020-IT01V3_0_0) pide 16 campos separados por tabulador, con la fecha en AAAA-MM-DD.
- `packages/domain/src/fiscal-books.ts:284-302` emite 17: mete un campo 4 que el instructivo no tiene y corre todo lo demás. La fecha sale en dd/mm/aaaa (`:260-263`) y el RIF con guiones.
- Las aserciones del test fijan el orden actual (`packages/domain/test/declarations.test.ts:36-45`): cambiarlas requiere la aprobación del dueño.
- El comentario de `:276` atribuye la máscara del comprobante a la PA 102; es de la PA 2025/000054, art. 16 (lo mismo que H-04).
- Hoy sale vacío, por H-01.
¿NECESITA DECISIÓN DEL DUEÑO?: sí, con el asesor. VALIDAR-SENIAT: ¿versión vigente del instructivo, formato de fecha y de RIF, y cómo se expresa la quincena? Amplía P-7.

### L-04 · L · alta · E3 · contador — el contribuyente especial declara IVA por quincena y la pantalla le propone el mes (F)
PANTALLA: /admin/declaraciones (`Declaraciones.tsx:115`, `mesLocalAnterior`)
DIMENSIÓN: MODO
HACE: la planilla de E3 se generó mensual. El servidor acepta cualquier rango, pero nada guía al especial a su quincena. La PA SNAT/2020/00057 (quincenal para los especiales) no está citada en docs/02_COMPLIANCE.
EVIDENCIA: `capturas-recorrido/L/L-04-L-05-iva-mensual-y-excedente-mezclado-E3.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. VALIDAR-SENIAT: ¿sigue vigente en 2026? ¿En qué quincena se imputan los créditos y las retenciones?

### L-05 · L · alta · E3 · contador — el excedente que pasa al período siguiente mezcla crédito fiscal y retenciones no absorbidas en una sola cifra (F)
DIMENSIÓN: DOCUMENTOS · DINERO
HACE:
- «Excedente que pasa al período siguiente Bs. 37.356,224768» = 34.667,30 de crédito fiscal + 2.688,92 de retención no absorbida (`20260917120000:327-330`).
- La PA 2025/000054, arts. 7 y 8, acumula aparte el remanente de retenciones (Forma 99030), que es lo único recuperable. Mezclarlo quita esa vía y descuadra la Forma 30.
- P-3 queda con fuente, y la respuesta apunta a llevarlos separados.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. VALIDAR-TRIBUTARIO (P-3).

### L-06 · L · media · E2, E3 · contador — la conciliación culpa a «un asiento que ningún documento respalda», que no existe, y no lleva a ningún documento (S, E, C)
DIMENSIÓN: TEXTO · ESTADOS
HACE:
- Ante L-01 dice «Hay un asiento que ningún documento respalda (o al revés)» (`Libros.tsx:485`). Es falso: `accounting_coverage_gaps` da 0.
- El concepto sale crudo, «iva_debito_fiscal», y no hay enlace ni pista hacia qué documento mirar.
EVIDENCIA: `capturas-recorrido/L/L-01-L-06-conciliacion-no-cuadra-E2.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿La conciliación enlaza a los documentos?

### L-07 · L · media · E2 · contador — la factura anulada va en el libro de ventas y en el CSV con todos sus importes (F, C)
DIMENSIÓN: DOCUMENTOS
HACE: A-6 figura con base 30.803,85 e IVA 4.928,62. La conciliación y la declaración la excluyen; el CSV no. Sumando la columna salen 98.034,41. En compras, el criterio R-2 la pone en cero (`20260916170000:164-166` frente a `20260918120000:109-124`). Completa G-10.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. VALIDAR-TRIBUTARIO: ¿R-2 vale también para las emitidas anuladas?

### L-08 · L · media · E2, E3 · contador — el libro no separa la base por alícuota ni trae el resumen mensual (F)
DIMENSIÓN: DOCUMENTOS
HACE: `base_gravada` suma todo lo gravado sin distinguir la tasa, y el libro no tiene fila de resumen (Reglamento LIVA, arts. 72 y 76). El desglose por alícuota solo existe en la planilla. En el escenario solo hay 16 %, así que la mezcla no se reprodujo.
¿NECESITA DECISIÓN DEL DUEÑO?: no. VALIDAR-SENIAT sobre el texto vigente.

### L-09 · L · media · E3 · dueño — el calendario de los contribuyentes especiales de 2026 no está cargado, y el motivo para no cargarlo ya no existe (F)
DIMENSIÓN: MODO
HACE:
- Vencimientos: «No hay vencimientos cargados. Pídele a tu contador la providencia del año».
- PENDIENTES_ASESOR P-10 frenó la carga porque «las fuentes discrepan en el número de gaceta». Es una reimpresión (G.O. 43.273 y 43.283), no un conflicto.
¿NECESITA DECISIÓN DEL DUEÑO?: sí (ADR-0052). VALIDAR-SENIAT: contrastar las fechas con la G.O. 43.283.

### L-10 · L · media · E2, E3 · contador — el selector de formatos del libro de ventas ofrece el TXT de retenciones (E, F)
DIMENSIÓN: PROMESA
HACE: `Libros.tsx:369-380` lista el catálogo entero sin filtrar por libro. El servidor rechaza la combinación, pero solo al final (`fiscal-books.ts:373-377`).
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### L-11 · L · baja · (todas) · — — la pantalla de libros cita la fuente equivocada: «Obligación de PA 071 y PA 102» (F)
DIMENSIÓN: TEXTO
HACE: el contenido de los libros lo regulan los arts. 70 a 78 del Reglamento LIVA; la PA 00071 regula la factura. Pasa en el texto de la pantalla y en el catálogo de formatos. No hay ninguna providencia que fije un modelo de libro (art. 74): el NO OFICIAL es correcto.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### L-12 · L · baja · E3 · contador — «Retenciones de IVA» (las practicadas) y «Retenciones que nos hicieron» (las soportadas) no se distinguen por el nombre (E)
DIMENSIÓN: TEXTO
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Un calificador corto?

### L-13 · L · baja · E2 · contador — «Generaciones» enseña el formato crudo («csv_columnas_legales»), y el mismo dato se llama «Hash» en Libros y «Huella» en Declaraciones (E)
DIMENSIÓN: TEXTO
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### L-14 · L · baja · (todas) · — — la pantalla pide el libro con el rango al revés mientras se escribe la fecha (S, C)
DIMENSIÓN: ESTADOS
HACE: el `useQuery` no tiene `enabled` (`Libros.tsx:245-248`). Sale un 422 «El período termina antes de empezar» que no se ve en pantalla. El servidor rechaza bien.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### L-15 · L · baja · E3 · — — la quincena del IGTF la calcula la web: una regla fiscal en el cliente (F)
DIMENSIÓN: MODO
HACE: `apps/web/src/fechas.ts:95-103` define la quincena, contra CLAUDE.md §7 (cero reglas tributarias en la web).
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### Confirmaciones de hallazgos anteriores
- **G-01:** el CSV del libro repite los números de control 1 y 2 en facturas y NC (F).
- **G-06:** «A enterar esta quincena: Bs. 940,27» incluye los 187,98 del IGTF de A-4, cuya venta se devolvió entera. La percepción sigue «percibido» y solo la anulación la manda a reintegro. F: se ajusta a la letra (el pago ocurrió), pero el reembolso en divisa no está previsto. Sigue abierto (VALIDAR-TRIBUTARIO). Captura: `capturas-recorrido/L/L-G06-igtf-de-venta-devuelta.png`.
- **H-01:** el libro de retenciones de IVA de E3 da «0 renglones · Sin movimientos». Captura: `capturas-recorrido/L/L-H01-libro-retenciones-vacio.png`.
- **K-08:** los ocho decimales de las compras llegan al libro («Bs. 151.752,75312») y al excedente de la declaración de E2 («Bs. 100.754,93248»), que se guarda y se arrastra. VALIDAR-CONTABLE y VALIDAR-TRIBUTARIO: ¿con qué redondeo se declaran el crédito y el excedente? (C).
- **F-11:** una retención soportada baja la cuota de la declaración, y la puede cargar un cajero (C).

### Lo que se comprobó y está bien
- **Declarar IVA (C, F):** resta las NC, excluye la anulada y su débito coincide con el mayor (E2 79.024,23 sobre una base de 493.901,61; E3 30.458,10). El orden débito − crédito − excedente anterior − retenciones soportadas es correcto como concepto. Captura: `capturas-recorrido/L/L-iva-septiembre-E2.png`.
- **Exportar (C):** deja una fila en `fiscal_book_runs` con hash sha256, acta y outbox. Todos los formatos van marcados NO OFICIAL, y no se inventa ningún layout.
- **Recibos de E1 (F):** no entran al libro de ventas ni a la declaración.
- **Crédito fiscal:** el libro de compras cuadra con el mayor (179.779,16 en E2).
- **Invariantes y tiempos:** los invariantes de E1, E2 y E3 dan 0; la conciliación de libros es aparte (L-01). Hubo 152 peticiones, ninguna por encima de 3 s; la más lenta, 433 ms (C).

### Cierre del bloque L (validador)
GATE verde (el del último gate sobre el mismo código: 736 pasos, vitest 805 y pgTAP 1264, iguales a la línea base) · invariantes en 0 para E1, E2, E3, también con el bloque M en marcha; cola de asientos y outbox vacíos · informe «conciliación libro-mayor de septiembre»: 0 en E1, **1 en E2 y 1 en E3** (L-01) · 152 peticiones, ninguna por encima de 3 s (la más lenta, 0,43 s) · documento con L-01..L-15 y sus capturas.

## Bloque M · De recibos a facturas

**Qué se hizo.** Todo en E1 (Bodega La Esquina), con la dueña, el 25/09. Desde este bloque, E1 es E4.
- **La banda de la caja:** «Estás vendiendo con recibos. Con tu RIF puedes facturar →».
- **El RIF:** Configuración → «Poner mi RIF» con V-12345678-9 y la dirección → «RIF registrado».
- **La activación:** /empezar paso 4 → «Ya puse mi RIF: activar facturas» → «A personas» · sin máquina fiscal → «Formatos libres · PA SNAT/2011/00071» → Ordinario → IVA 16 % → talonario A 1-2000 de «Tipografía Barquisimeto, C.A.». Captura: `capturas-recorrido/M/M-facturas-activadas.png`.
- **En la base:** régimen `formatos_libres` desde 2026-09-25 17:59:03 (la fila `sin_facturacion` se cerró en ese mismo instante), `taxpayer_type_code` ordinario, reglas de IVA 16 % y 0 % desde el 25/09 y rango de facturas A 1-2000. No hay rangos de notas.
- **La primera venta con RIF:** no se pudo cobrar (M-01).
- **Llegó mercancía con RIF:** el paso «¿Qué llegó?» con proveedor ya aparece. La compra no se completó.

**Error del guion.** La primera ejecución de `m2-facturar.mjs` pulsó el botón del tema oscuro en lugar de «Tus facturas», y no activó nada. En esa ejecución la bodega seguía con recibos, y su cobro emitió el recibo **R-7**, una venta real. Lo que el estratega leyó en la captura 024 como «eco» de R-7 es esa venta, no un eco. El eco sigue como SOSPECHA (M-02).

**No se pudo probar** el PDF de una factura de E1, porque no llegó a haber ninguna. Lo que se dice del PDF sale de leer la función que lo arma.

### M-01 · M · crítica · E4 · dueña/cajera — una cuenta ya cobrada vuelve de la nube y queda envenenada: la primera factura de la bodega da 409 (S, C; E)
PANTALLA: /vender → Cobrar
DIMENSIÓN: DATOS · ESTADOS
PROMETE: el comentario de `apps/web/src/pages/negocio/Vender.tsx:237-239` dice que la cuenta vendida ya no vuelve («h. 85»).
HACE:
- La caja trajo de la nube la «Cuenta 11» (id `64d2d062-84d8-41da-b672-ccd6f0df9964`) con las 2 Harinas de la venta R-7 y una nueva. Ahora con IVA: base 3.080,39, IVA 496,28, total 3.576,67.
- Cobrar → **409 `IDEMPOTENCY_KEY_REUSED`** «Esa operación ya se registró con otros datos». No se registró nada. Tras reabrir el flujo entero, otra vez lo mismo.
- La causa es una carrera, y la base la demuestra (C):
  - la llave `64d2d062…` está `completed` desde las 17:57:56.420 (R-7, `created_at` 17:57:56.437);
  - la fila de `pos_carts` tiene `version 2` y `created_at 17:57:56.840`. La fila se INSERTÓ de nuevo 403 ms después de la venta, cuando la venta ya la había borrado (`packages/domain/src/sales.ts:3780-3786`). Su único UPDATE posterior es el PUT del paso 034;
  - la evidencia del paso 024 tiene `PUT /v1/pos/carts/64d2d062…` y `POST /v1/pos/sales` (480 ms) en el mismo paso.
- El mecanismo:
  - la subida de la cuenta espera 4 s (`apps/web/src/pos-cuentas.ts:105`, `:129-173`);
  - pulsar «Cobrar» no la cancela ni la adelanta (`Vender.tsx:590`, `:895`);
  - `olvidar` cancela el temporizador, pero no el PUT que ya salió (`pos-cuentas.ts:189-194`), y se llama tarde, cuando la venta ya respondió (`Vender.tsx:959`);
  - el upsert del servidor no sabe que ese id ya se vendió (`packages/domain/src/pos-carts.ts:81-96`);
  - la llave de la venta es el id de la cuenta (`Vender.tsx:1587`).
- Basta cobrar en el segundo en que dispara la subida, a la velocidad normal de una caja. La cuenta queda sin poder cobrarse durante las 24 h de la llave.
- El test de la h. 85 no cubre esto. El E2E (`apps/api/test/e2e-sales.test.ts:1274-1292`) comprueba que la venta borra la fila, pero nunca hace un PUT después. El unit (`apps/web/test/pos-cuentas.test.ts:28-44`) prueba `olvidar` a 1 s, con el temporizador todavía sin disparar.
EVIDENCIA: `capturas-recorrido/M/M-01-cuenta-cobrada-vuelve-409.png`; `.recorrido/…/M/024-*.json`, `032-*.json` y `034-*.json`; las dos consultas de arriba.
REPRODUCIR: agregar un producto en la caja, pulsar Cobrar y confirmar hacia los 4 s de la última edición, de modo que la subida dispare durante el POST. Después, `select * from pos_carts where id=<cuenta>` devuelve una fila.
¿SE NOTA?: la persona lo ve: reaparece una cuenta con lo ya vendido y, al cobrarla, el 409.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿La llave de la venta deja de ser el id de la cuenta, o el servidor rechaza el PUT de una cuenta ya vendida? Es la misma familia de D-03 (una llave fija para cuerpos distintos).

### M-02 · M · alta · E4 · cajera — si la cuenta resucitada se cobra igual que antes, el servidor devuelve la venta vieja como nueva, y el efectivo entra sin venta (C; SOSPECHA)
PANTALLA: /vender → Cobrar
DIMENSIÓN: DATOS · DINERO
HACE:
- Con el mismo endpoint, el mismo hash y la llave `completed`, el middleware devuelve la respuesta guardada: status y cuerpo originales (`apps/api/src/middleware/idempotency.ts:250-256`).
- El cuerpo de la venta no lleva precios, fecha ni nonce (`Vender.tsx:1582-1602`). La cuenta resucitada trae justo lo vendido, así que el mismo día, con el mismo monto sugerido, los bytes coinciden.
- Resultado: 201 con R-7, y el diálogo «Venta registrada». No hay documento, kardex ni cobro nuevo, pero el efectivo entra a la gaveta.
- Arista fiscal (F): una empresa ya inscrita le entregaría al cliente un recibo no fiscal creyendo que era factura.
- Es la lección de CLAUDE.md §3, «Asevera el mensaje»: dos caminos que terminan en el mismo 201.
REPRODUCIR: E4, mismo día, cuenta resucitada con 2 Harinas y sin cliente → cobrar en efectivo el monto prellenado (2.053,59). Esperado: 201 con `series='R', document_number=7`, y el número de recibos sigue en 7. No se reprodujo: los agentes no escriben, y el guion no lo buscó.
¿SE NOTA?: termina en verde. El descuadre solo sale como sobrante en el cierre de caja.
¿NECESITA DECISIÓN DEL DUEÑO?: la misma de M-01.

### M-03 · M · media · (todas) · cajero — la cuenta cobrada puede volver por otros dos caminos (C; SOSPECHA)
DIMENSIÓN: DATOS
HACE:
- Si el PUT en vuelo de una cuenta ya cobrada falla (sin red), el `catch` la vuelve a encolar, porque `olvidar` ya vació lo pendiente (`pos-cuentas.ts:157-167`). El siguiente `vaciar()` la sube otra vez: cambio de pestaña (`Vender.tsx:695`) o salir de la caja (`:211`).
- Otra pestaña u otra caja que tenga la cuenta en memoria la reescribe en localStorage, y al montar Vender se vuelve a subir (`Vender.tsx:295-297`).
- Los tres caminos tienen la misma raíz que M-01: el servidor no sabe qué ids ya se vendieron.
¿SE NOTA?: la persona lo ve (una cuenta fantasma).
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### M-04 · M · media · E4 · cajera — el aviso del 409 invita a revisar y repetir, y la cuenta está muerta (E)
PANTALLA: /vender → Cobrar (`Vender.tsx:1587`, `:1606`)
DIMENSIÓN: TEXTO · ESTADOS
PROMETE: «Esa operación ya se registró con otros datos. Revisa si quedó hecha antes de repetirla».
HACE: con la llave fija, cualquier reintento con otro cuerpo da el mismo 409 durante 24 h. Así pasó en el primer intento (3 Harinas) y después de rehacer el flujo entero. La única salida es abrir una cuenta nueva, y ninguna pantalla la dice. Es el mismo texto de D-03, que también dice lo contrario de lo que pasó.
EVIDENCIA: `.recorrido/…/M/014-*.png` y `034-*.png`.
¿SE NOTA?: la persona ve el aviso, pero no entiende que es permanente.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### M-05 · M · alta · E4 · dueña — el RIF de persona natural sale como una cédula de nueve cifras, en la pantalla y en el PDF de la factura (S, F, C; E)
PANTALLA: Configuración → Mi empresa (tarjeta del RIF) · PDF de factura, nota y copia (`GET /v1/documents/:id/pdf`)
DIMENSIÓN: DOCUMENTOS · TEXTO
PROMETE: «solo presentación… vestir no es corregir» (`apps/api/src/routes/documents-pdf.ts:86-92`).
HACE:
- V-12345678-9 se guarda bien, como `V123456789`, pero se enseña como **«RIF: V-123.456.789»**: agrupado con puntos, como una cédula, y sin el guion del dígito verificador.
- La función trata V y E como cédula sin mirar la longitud. Solo J y G separan el último dígito (`documents-pdf.ts:93-105`).
- La misma función imprime el RIF del EMISOR (`:216`) y el del CLIENTE (`:269`). La web usa su espejo (`apps/web/src/pages/negocio/comunes.tsx:46-58`) en Mi empresa, Clientes, la caja y el registro.
- Ningún test cubre V o E con 9 dígitos: `apps/web/test/documento.test.ts:11-13` solo prueba cédulas de 8 o menos.
- En el papel preimpreso de la imprenta, el RIF del emisor puede estar escrito de otra manera, y quedarían dos grafías del mismo RIF en el mismo documento (F; SOSPECHA: no hay ejemplar del talonario).
EVIDENCIA: `capturas-recorrido/M/M-05-rif-como-cedula.png` y `.recorrido/…/M/004-E1-poner-rif-hecho.json`. Para el PDF, la expresión de `documents-pdf.ts:99` aplicada a «123456789» da «123.456.789».
REPRODUCIR: Configuración → Poner mi RIF con V-12345678-9 → ver la tarjeta. Con la primera factura, el membrete dirá «RIF: V-123.456.789».
¿SE NOTA?: se ve, pero parece bien formateado. En el papel fiscal termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. VALIDAR-SENIAT (ya abierto en `EMISION_FACTURAS.md` §5 n.º 3): ¿con qué grafía se imprime el RIF de persona natural, y qué norma fija su estructura? La PA 00071 art. 13 num. 5 y 7 exige el número, no su forma. La opción que no depende de la norma: no reagrupar un RIF V o E de 9 dígitos.

### M-06 · M · alta · E4 · dueña — la banda «Con tu RIF puedes facturar →» lleva al paso 1 de 4, «Tus productos», no al de facturas (S, E)
PANTALLA: /vender → /empezar (`apps/web/src/components/capa-fiscal/AvisoFacturacion.tsx:9`, `apps/web/src/pages/negocio/Empezar.tsx:68`)
DIMENSIÓN: PROMESA
HACE: `/empezar` arranca siempre en `useState(0)`. El paso de activar facturas es el 4, y solo se llega a él por la escalera de la cabecera (M-07).
EVIDENCIA: `capturas-recorrido/M/M-06-banda-lleva-al-paso-1.png`; `.recorrido/…/M/002-E1-empezar-desde-caja.json` («PASO 1 DE 4 · LISTO · Tus productos»).
REPRODUCIR: /vender con recibos → clic en «Con tu RIF puedes facturar →».
¿SE NOTA?: la persona lo ve, y tiene que adivinar el camino.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### M-07 · M · media · E4 · dueña — la escalera de /empezar son cuatro barritas sin texto (E)
PANTALLA: /empezar, cabecera (`Empezar.tsx:150-159`)
DIMENSIÓN: FORMA · TECLADO
HACE: cada paso es un botón que es solo una barra de color (`h-1.5 rounded-full`), con `aria-label` («Tus facturas — listo»), sin `title` ni texto visible. Para llegar a las facturas desde la banda (M-06) hay que pulsar a ciegas una de cuatro barras iguales. En 390 px son aún más pequeñas (SOSPECHA para el tamaño de toque).
EVIDENCIA: `.recorrido/…/M/016-E1-empezar-paso-4.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### M-08 · M · baja · E4 · dueña — «Tu RIF ya está cargado desde el registro», cuando se puso después en Configuración (S, E, F, C)
PANTALLA: /empezar paso 4 (`Empezar.tsx:448`, `:596-600`; `apps/web/src/app/rif.ts:14-17`)
DIMENSIÓN: TEXTO
HACE: la condición solo mira que el RIF no empiece por `PEND-`, no de dónde vino. Además, «registro» puede leerse como el Registro de Información Fiscal, es decir, una verificación contra el SENIAT que no ocurrió: nadie validó el RIF (F).
EVIDENCIA: `capturas-recorrido/M/M-08-rif-desde-el-registro.png`; `.recorrido/…/M/026-*.json`.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### M-09 · M · media · E4 · cajera — la caja no dice que ahora se factura: la banda de recibos desaparece y nada la sustituye (E)
PANTALLA: /vender (`Vender.tsx:601`, `{modoRecibos && <AvisoFacturacion />}`)
DIMENSIÓN: ESTADOS
HACE: al activar facturas, la banda se va y no aparece nada en su lugar. La única señal del cambio está en /empezar o en Configuración. Comparar `.recorrido/…/M/001-*.png` con `012-*.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Un aviso del estilo «Ya facturas con tu RIF», y por cuánto tiempo?

### M-10 · M · media · E4 · dueña — «Formal» se ofrece sin decir qué significa, y en ventas, libros y documentos Ladino lo trata como un ordinario (F)
PANTALLA: Configuración → Tipo de contribuyente · /empezar paso 4
DIMENSIÓN: MODO
PROMETE: «Formal: el IVA de tus compras no es crédito fiscal, va al costo» (`apps/web/src/components/capa-fiscal/TipoDeContribuyente.tsx:35`). El comentario de `:18` admite «sin artículo citado».
HACE:
- Elegir «formal» solo cambia dos cosas: en compras, el IVA va al costo (`packages/domain/src/purchases.ts:869-871`), y el IGTF se apaga si la empresa era especial (`packages/domain/src/igtf.ts:203`).
- En ventas no cambia nada: `sales.ts:800-844` lee el tipo del CLIENTE, y ninguna función SQL lee `companies.taxpayer_type_code`. El formal recibe el paso «IVA que cobras 16 %» (`Empezar.tsx:823-835`), factura líneas gravadas, tiene libro y declaración de IVA, y su PDF no lleva ninguna leyenda de contribuyente formal.
- Según la LIVA art. 8 (fuente secundaria), formal es quien SOLO hace operaciones exentas o exoneradas. Hoy no hay umbral de ingresos: basta un producto gravado para que sea ordinario.
¿SE NOTA?: no. Termina en verde: un formal que factura IVA deja de ser formal, y Ladino no lo advierte.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. VALIDAR-TRIBUTARIO: ¿sigue vigente la PA SNAT/2003/1677? ¿Qué leyenda lleva la factura del formal? ¿Libros o relaciones? ¿Con qué periodicidad declara? ¿Debe impedirse que facture una línea gravada?

### M-11 · M · media · E4 · — — para Ladino, la factura empieza cuando se pulsa «Así facturo»; la ley puede ponerla antes (F)
DIMENSIÓN: MODO
HACE: la mecánica es correcta:
- el régimen se decide por `issued_at` (`supabase/migrations/20260904233235_debt_anchored_in_document_currency.sql:43`, `:57-61`);
- los recibos quedan intactos y fuera de los libros (`20260916170000_fiscal_amounts_in_bolivars.sql:163`, `:268`);
- la serie A arranca aparte de la R.
La brecha es normativa y amplía R-27. Según la LIVA arts. 5 y 54 (fuente secundaria), la obligación de facturar depende de la actividad habitual, no de la fecha del RIF. Los recibos previos pueden haber sido operaciones que debieron facturarse. Ladino no lo decide, ni debe decidirlo.
¿NECESITA DECISIÓN DEL DUEÑO?: sí, con el asesor. VALIDAR-TRIBUTARIO: una persona natural que vendía de forma habitual sin RIF y lo obtiene el día D, ¿desde cuándo factura? ¿Se regularizan las ventas con recibo? ¿El talonario debe ser posterior a la inscripción?

### M-12 · M · media · E4 · dueña — después del cambio, un recibo viejo no se puede devolver con ningún documento (F; SOSPECHA)
DIMENSIÓN: MODO
HACE: `receipt_return` solo está en los `allowed_kinds` de `sin_facturacion` (`supabase/migrations/20260915160000_correct_a_sale.sql:51`), y el régimen se evalúa a la fecha de emisión. Una devolución de R-1…R-7 emitida hoy debería caer en LAD49. En lo fiscal está bien que no salga una NC contra un recibo (PA 00071 art. 22: la nota corrige una factura). En lo operativo, no queda ninguna vía documental para devolverle algo a un cliente que compró con recibo. No se ejecutó.
REPRODUCIR: E4 ya con RIF → Ventas → R-5 → devolver → se espera un error LAD49.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿`receipt_return` se permite cuando el origen es un recibo, o se reembolsa sin documento?

### M-13 · M · baja · — · — — la pregunta P-17 al asesor describe un comportamiento que ya no existe (F)
DIMENSIÓN: MODO
HACE: `PENDIENTES_ASESOR.md:318-319` dice «Hoy: … el `especial` lleva el IVA de compra al costo». El código ya lo trata como recuperable (`purchases.ts:862-871`, h. 75, R-34). El asesor contestaría sobre un estado viejo. Hay que reescribir la pregunta: «Ladino ya trata al especial como recuperador del IVA de compras. ¿Es correcto, y con qué artículo?».
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### Pregunta para el dueño (R9, no es hallazgo)
Entre poner el RIF en Configuración y activar facturas en /empezar, la empresa ya tiene RIF pero sigue emitiendo recibos. **R-7 salió así**, con `issuer_tax_id_snapshot = V123456789` y el régimen todavía sin facturación. Tu regla del 2026-09-16 (`apps/web/src/app/rif.ts:2`) dice «con RIF, facturas». ¿Es intencional ese tramo intermedio? (C, F).

### Confirmaciones de hallazgos anteriores
- **G-01:** la puesta a punto de E4 tampoco pidió rangos de notas de crédito ni de débito. Solo hay rango de facturas (S, C).
- **D-01:** con el RIF puesto, Mi empresa ya enseña «Tipo de contribuyente: Falta» con Ordinario / Especial / Formal. Sin RIF no aparecía. La salida que D-01 echaba en falta existe solo con RIF (S).
- **E-08:** la cuenta que vuelve de la nube sin aviso es la puerta de M-01 (S, C).
- **D-03:** M-01 y M-04 son la misma familia: una llave fija para cuerpos distintos (E, C).

### Lo que se comprobó y está bien
- **El cambio de régimen no reescribió el pasado (C, F).** Solo se cerró la vigencia del régimen anterior. R-1…R-7 y D-1 conservan su versión de régimen y su snapshot. Los recibos siguen fuera de los libros.
- **Las ventas nuevas saldrán como factura:** el tipo lo decide el servidor por el régimen (`sales.ts:3662-3666`), no la pantalla (C).
- **El fiado R-5 de Luisa (3.332,41) se puede seguir cobrando.** Su cobro no genera IVA ni IGTF, porque E4 es ordinario (C).
- **Invariantes y tiempos:** E1, E2 y E3 dan 0 en todos los invariantes. La conciliación libro-mayor de E2 y E3 da 1, que es L-01. Outbox vacío. Hubo 180 peticiones, ninguna por encima de 3 s; la más lenta, `POST /v1/pos/sales`, 480 ms (C).

### Cierre del bloque M (validador)
GATE verde (el del último gate sobre el mismo código: 736 pasos, vitest 805 y pgTAP 1264, iguales a la línea base; `git diff` de apps, packages y supabase vacío) · invariantes en 0 para E1, E2, E3; cola de asientos y outbox vacíos · informe «conciliación libro-mayor de septiembre»: 0 en E1, 1 en E2 y 1 en E3 (L-01) · 181 peticiones, ninguna por encima de 3 s (la más lenta, `POST /v1/pos/sales`, 0,48 s; un PASO del guion tardó 9,5 s entre esperas, sin ninguna petición lenta) · documento con M-01..M-13 y sus capturas.

## Bloque N · Usuarios y roles

**Qué se hizo.** Todo en E2 (Distribuidora Andina), salvo el alta del dueño en E3. La corrida fue el 28/09, con el reloj real del servidor.
- **Altas:** el almacenista se creó la cuenta. El dueño de E2 agregó al cajero (Cajero), al encargado (Encargado), al administrativo (oficio «Administrador», rol `back_office`) y al almacenista (Operación de almacén). El contador ya estaba desde K. tornillo@ agregó a dueno.andina@ como Dueño de E3.
- **Con cada rol:** dónde aterriza, qué menú ve, qué pasa al abrir por URL una pantalla ajena y qué da Ctrl+K. Muestras:
  - el cajero fía a un cliente que crea en la caja y, en una tercera pasada, vende de contado;
  - el administrativo emite una factura y la anula;
  - el contador intenta vender;
  - el almacenista abre el pedido n.º 1.
- **Quitar y desactivar:** el dueño le quitó el rol al encargado y desactivó al cajero mientras este tenía la caja abierta. Los dos volvieron a entrar. Después se reactivó al cajero y se le devolvió el rol al encargado.
- **Cuarta pasada:** el dueño invitado en E3.

**Error del guion.** Hubo dos:
- La primera pasada se cayó después de crear la cuenta del almacenista, porque la sesión nueva quedó abierta.
- En la pasada completa, la segunda mitad (quitar, desactivar, reactivar) no llegó a ejecutarse: desde que el dueño de E2 también lo es de E3, al entrar cae en «Elige la empresa», y el guion no elegía. Esos pasos (037-043) son sesiones normales. `n2-quitar.mjs` los rehízo (044-056).

**Datos creados en N:**
- la factura **A-8** de E2 (28/09, 17.894,28, emitida por el administrativo; sigue emitida, porque la anulación falló);
- el cliente «Carlos Fiado Nuevo», creado por el cajero;
- las membresías.

**No se probó:**
- «Traer del BCV» pulsado por el encargado;
- el alta de empresa de alguien sin rol (se razona en N-03);
- el teclado de los diálogos de personas.

### N-01 · N · crítica · E2 · cajero — el cajero no puede vender ningún producto con existencia, ni de contado ni fiado, y nunca ha podido (S, C, E)
PANTALLA: /vender → Cobrar
DIMENSIÓN: ROLES · PROMESA
PROMETE: la migración que crea el rol dice «CAJERO: vender, cobrar, fiar y anotar al vecino» (`supabase/migrations/20260905010911_seed_named_roles.sql:112-119`).
HACE:
- La venta pide `sales.invoice.issue` (`packages/domain/src/sales.ts:3470`, `quickSale` en `:3626`). Después descuenta el kardex con `issueStockBatch` (`sales.ts:1585-1602`), que vuelve a autorizar con **su** permiso, `inventory.move` (`packages/domain/src/inventory.ts:853`).
- El rol `cashier` tiene 5 permisos (`ar.read`, `customer.manage`, `sales.invoice.issue`, `sales.payment.register`, `sales.quote.manage`). `inventory.move` no está entre ellos.
- Resultado: toda venta con una línea de producto responde 403, «Tu usuario no puede hacer esto. Pídele acceso a quien administra el negocio», y no se registra nada. Solo podría vender servicios.
- **Desde cuándo** (C): el rol nació en `1747ecd` (2026-09-04) sin `inventory.move`, y la venta ya autorizaba el kardex con ese permiso desde c36f838 (2026-08-27). `a32811c` (2026-09-10) solo lo pasó a lote. **Ningún cajero ha podido vender mercancía nunca.** En toda la corrida no hay ningún documento emitido por un cajero, tampoco por el auditor.cajero de A.
- **Por qué ningún test lo vio** (C, F4):
  - `supabase/tests/040_named_roles_test.sql:55` asevera «el cajero vende» solo porque el rol tiene `sales.invoice.issue`, y `:61` asevera que NO tiene `inventory.move`. Mira la composición del rol, no la conducta.
  - `apps/api/test/e2e-onboarding.test.ts:140-200` agrega una cajera, comprueba sus permisos y la desactiva, pero nunca vende.
  - Todos los E2E que venden lo hacen con el fundador, que tiene owner y warehouse_ops a nivel de negocio.
- La familia es un **permiso anidado**: un caso de uso compuesto llama a otro que vuelve a autorizar con su propio permiso. N-02, N-04 y B-16 son de la misma familia.
EVIDENCIA: `capturas-recorrido/N/N-01-cajero-no-vende-de-contado.png` (una Pasta de contado, sin identificar) y `N-01-cajero-no-fia.png`. Respuesta: `POST /v1/pos/sales → 403 PERMISSION_REQUIRED «La operación exige el permiso inventory.move sobre esta empresa»`. En la base, `platform.ladino_user_has_permission(<cajero>, 'inventory.move', E2) = f`.
REPRODUCIR: agregar a una persona como Cajero → que entre → /vender → un producto con existencia → Cobrar → Efectivo Bs.
¿SE NOTA?: la persona lo ve al final del cobro, con un mensaje que no dice qué le falta.
¿NECESITA DECISIÓN DEL DUEÑO?: sí, y es urgente: **en producción, cualquier empresa con un cajero no puede venderle nada** (no se miró la base remota, R6). Hay dos salidas:
- dar `inventory.move` al cajero. Obliga a cambiar la aserción existente de `040_named_roles_test.sql:61`, y eso requiere tu aprobación;
- que la salida de la venta la autorice el permiso de la venta, como ya se hace con la reposición al anular (`inventory.ts:457-459`, ADR-0061 §2) y con `revalorizar` (`:1416-1420`).

### N-02 · N · alta · E3 · dueño invitado — el «Dueño» que se agrega a otra empresa no es dueño: no ve a las personas, no puede vender mercancía, y la web le ofrece lo que el servidor le niega (S, C)
PANTALLA: /admin/configuracion → Usuarios y roles · /vender
DIMENSIÓN: ROLES · PROMESA
HACE:
- `addMember` crea la asignación limitada a la empresa, también para `owner` (`packages/domain/src/members.ts:181`). No añade warehouse_ops, que al fundador sí se le da a nivel de negocio (`platform.bootstrap_tenant`).
- La gestión de personas exige una asignación a nivel de negocio (`nivelTenant`, `members.ts:22-40`), pero la web decide con `ladino_user_has_permission`, que acepta la de empresa (`/v1/me/permissions`, `apps/api/src/routes/companies.ts:169-186`; `apps/web/src/pages/Configuracion.tsx:83`).
- En E3 (cuarta pasada), dueno.andina@ ve «Agregar persona» y debajo **«No se pudieron cargar las personas: Tu usuario no puede hacer esto»**: `GET /v1/members → 403 «exige membership.read a nivel de negocio»`. No puede quitarle el rol a tornillo@ ni desactivarlo. tornillo@ a él sí.
- Tampoco puede vender un Cemento de contado: 403 `inventory.move` (N-01).
- Sí puede corregir el RIF de E3: tiene `company.tax_id.manage` (C). Es lo que concede el rol Dueño.
EVIDENCIA: `capturas-recorrido/N/N-02-dueno-invitado-no-ve-personas.png` y `N-02-dueno-invitado-no-vende.png`. En la base, para E3: `membership.manage = t` según `has_permission` y `f` según `nivelTenant`.
REPRODUCIR: tornillo@ agrega a dueno.andina@ como Dueño de E3 → dueno.andina@ elige E3 → Configuración; luego la caja → Cemento → Cobrar.
¿SE NOTA?: la persona lo ve.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Un Dueño invitado gobierna todo el negocio, o solo esa empresa? En el segundo caso, que no se llame «Dueño», y que la web y el servidor digan lo mismo.

### N-03 · N · alta · E2 · encargado / cajero — a quien le quitan el rol o lo desactivan, Ladino le propone fundar un negocio (S, E, C)
PANTALLA: / al entrar (`apps/web/src/app/session.tsx:257-268`)
DIMENSIÓN: ESTADOS · PROMESA
PROMETE: «quitar el rol corta el acceso en el momento».
HACE:
- El corte se cumple (N-06). Pero la web decide con una sola condición, `companies.length === 0`, y enseña **«Vamos a montar tu negocio en Ladino. Te toma menos de dos minutos»**. Es la misma pantalla, palabra por palabra, que ve una cuenta recién creada (el almacenista, 001). Nada dice «ya no tienes acceso a Distribuidora Andina».
- Qué pasaría si lo intentan (C, SOSPECHA, sin ejecutar):
  - el encargado sin rol conserva la membresía `active` sin asignaciones, y el alta le respondería 409 «Ya perteneces a un negocio…» (LAD81 en `platform.bootstrap_tenant`), justo cuando no tiene acceso a ninguno;
  - el cajero desactivado (`inactive`) sí fundaría un negocio nuevo, en otro tenant, sin mezclarse con E2. Al reactivarlo tendría dos membresías activas.
EVIDENCIA: `capturas-recorrido/N/N-03-desactivado-monta-tu-negocio.png`; `.recorrido/…/N/050-054` y `001`.
REPRODUCIR: Configuración → Quitar el rol al encargado, o Desactivar al cajero → esa persona entra.
¿SE NOTA?: la persona lo ve, y puede creer que perdió sus datos, o crear una empresa por error.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Qué ve quien perdió el acceso? Distinguirlo exige consultar si hay una membresía inactiva o sin rol.

### N-04 · N · alta · E2 · administrativo — «Anular» se le ofrece al administrativo, falla al final y enseña el nombre técnico del permiso (S, E, C) — confirma G-08
PANTALLA: /admin/ventas/:id → Anular
DIMENSIÓN: TEXTO · ROLES
HACE:
- `back_office` tiene `sales.invoice.annul` pero no `accounting.entry.reverse`, que la reversión del asiento vuelve a pedir (`sales.ts:1938-1947` → `packages/domain/src/accounting.ts:580`). Es el mismo permiso anidado de N-01.
- `sales.ts:1946` convierte el PERMISSION_REQUIRED en `VALIDATION_FAILED` (422), y el mensaje técnico llega a la persona: **«La operación exige el permiso accounting.entry.reverse sobre esta empresa»**, dos veces («No se pudo completar» y «No se pudo anular»).
- La rama hermana del kardex (`sales.ts:1596-1602`) ya corrigió esa conversión a 403 el 2026-09-15. Esta no.
- A-8 quedó íntegra (C): `issued`, dos asientos `posted` y cuadrados sin reversión, una salida de kardex, outbox `published` y el acta de emisión con autor.
EVIDENCIA: `capturas-recorrido/N/N-04-permiso-tecnico-en-pantalla.png`; `POST /v1/invoices/…/annul → 422`.
REPRODUCIR: administrativo@ → factura nueva a Abastos El Sol → Emitir → Anular → motivo → Anular la factura.
¿SE NOTA?: la persona lo ve, con un código técnico.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿El administrativo anula? Si sí, que la reversión la autorice la anulación. Si no, que no vea el botón, y que el mensaje sea un 403 legible.

### N-05 · N · media · E2 · encargado — Mi dinero le dice al encargado que no hay tasa BCV, cuando la hay (S, E, C)
PANTALLA: /dinero (`apps/web/src/pages/negocio/Dinero.tsx:167-172`, `:475-500`)
DIMENSIÓN: ESTADOS
PROMETE: el comentario de `Dinero.tsx:164-166`: con solo `cash.close`, la pantalla «se reduce a la tasa del día y el cierre de SU caja».
HACE: la tasa se lee del resumen, que solo se pide con `treasury.read`, y el encargado no lo tiene. Así que dice **«Todavía no hay tasa BCV. Tráela para poder vender en dólares»** y le ofrece «Traer del BCV» (tiene `fx.rate.manage`). En el mismo momento, la caja del cajero enseña «Tasa BCV: 857,0058».
EVIDENCIA: `capturas-recorrido/N/N-05-encargado-sin-tasa.png`. En su `api` no hay ninguna petición a `/v1/negocio/resumen`.
¿SE NOTA?: la persona lo ve y cree algo falso. Que tras traerla la pantalla siga igual es SOSPECHA.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### N-06 · N · media · E2 · cajero — al cajero desactivado con la caja abierta, el cobro le dice «Eso no existe o no está disponible para ti» (S, E, C)
PANTALLA: /vender → Cobrar
DIMENSIÓN: TEXTO · ESTADOS
HACE:
- El corte es inmediato, sin recargar: bien.
- El middleware responde 404 a propósito, para no confirmar que la empresa existe (`apps/api/src/middleware/scope.ts:57-80`), y la caja lo traduce como **«No se pudo calcular el cobro: Eso no existe o no está disponible para ti»**.
- El diálogo queda incoherente: «Falta Bs. 41.753,32» arriba, el botón principal dice «Falta Bs. 0,00», y se le ofrece «Fiar lo que falta».
- Se corta todo lo que lleva empresa, en cada petición y sin esperar a que caduque el token, también la subida de la cuenta. La web no usa Realtime (C).
EVIDENCIA: `capturas-recorrido/N/N-06-desactivado-con-caja-abierta.png`; `.recorrido/…/N/049-*.json` (cinco 404).
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Un mensaje específico, sin revelar más de lo debido, del tipo «Tu acceso a esta empresa ya no está activo»?

### N-07 · N · media · (todas) · cualquier miembro — cualquier miembro activo, incluso sin rol, lee todas las membresías y asignaciones del negocio directamente de la base (C)
DIMENSIÓN: ROLES · DATOS
HACE:
- Las policies de `memberships`, `user_role_assignments`, `scope_bindings` y `tenants` usan `platform.ladino_tenant_ids()`, que acepta cualquier membresía `active`, tenga roles o no.
- Con su JWT, por PostgREST, un cajero ve 6 membresías y 7 asignaciones. Eso se salta el `membership.read` que exige la API (`members.ts:58`).
- No se ven los correos (`platform.user_email` no es ejecutable para `authenticated`). No hay fuga entre negocios.
EVIDENCIA: simulado en la base local, en una transacción de solo lectura con `set local role authenticated` y los claims del cajero. En Cloud no se probó.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### N-08 · N · media · (todas) · dueño — no hay invitación: la persona tiene que registrarse antes, y si lo hace le proponen fundar un negocio (S, E)
PANTALLA: Configuración → Agregar persona
DIMENSIÓN: PROMESA · ESTADOS
HACE: con un correo sin cuenta, `POST /v1/members → 404 MEMBER_NOT_REGISTERED`: «Esa persona todavía no tiene cuenta en Ladino. Pídele que se registre con ese correo y vuelve a agregarla». El mensaje es claro. Pero el empleado que se registra por su cuenta aterriza en «Vamos a montar tu negocio» (N-03). Nada le dice que espere a que lo agreguen.
EVIDENCIA: `capturas-recorrido/N/N-08-agregar-sin-cuenta.png`; `.recorrido/…/N/001-cuenta-almacenista.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Un correo de invitación, o al menos otra pantalla para quien entra sin empresa?

### N-09 · N · baja · (todas) · cajero, encargado, almacenista — la pantalla que no le toca redirige en silencio, y hay dos pantallas distintas que se llaman «Inventario» (S, E)
PANTALLA: guardia de rutas (`apps/web/src/app/shell.tsx:198-218`) · `apps/web/src/app/nav.ts:82` y `:155-163`
DIMENSIÓN: TEXTO · ESTADOS
HACE:
- /admin/ventas y /dinero del cajero, /admin/productos del encargado y /inventario del almacenista vuelven a su pantalla inicial sin decir nada. Es deliberado: «cortesía coherente con el menú».
- El «Inventario» del menú del almacenista abre /admin/inventario. El /inventario de la tienda pide `sales.invoice.issue`: dos pantallas con el mismo nombre.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### N-10 · N · baja · (todas) · — — el rastro de quitar el rol y de reactivar queda incompleto (C)
DIMENSIÓN: DATOS
HACE:
- `member.role_revoked` se registra con `aggregate_type='membership'`, pero con el id de la ASIGNACIÓN (`members.ts:257`). El historial de una membresía no incluye las revocaciones.
- Reactivar desde «Agregar persona» pone `active` sin ningún `member.reactivated` (`:163-165`).
- Hay acta, con autor, de todo lo demás: las altas, la desactivación y la reactivación desde el botón.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### N-11 · N · baja · (todas) · roles sin permisos amplios — cada aterrizaje pide 3 a 5 datos que el rol no puede ver, y recibe 403 (C)
DIMENSIÓN: TIEMPO · ROLES
HACE:
- `/v1/suppliers`, `/v1/accounts` y `/v1/fiscal-books/runs` salen de `sondearModulosActivos` (`apps/web/src/app/modulos-activos.ts:16-29`). Es deliberado: el 403 quiere decir «módulo no tuyo».
- `/v1/treasury/accounts` sale de `useEmpezarPendiente` (`shell.tsx:113-123`), y `/v1/fiscal-declarations/deadlines` sale de Inicio.
- Ninguno mira los permisos que la web ya tiene (`/v1/me/permissions`). Son lecturas: no se vieron escrituras antes del 403, pero la familia A-07 queda sin verificar manejador por manejador.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### Confirmaciones de hallazgos anteriores
- **E-09, matizado:** no hay ningún permiso de crédito. Lo que bloqueó el fiado del cajero fue `inventory.move`, que bloquea TODA venta de bienes (N-01). Con servicios, o si el cajero recibe `inventory.move`, E-09 sigue en pie tal cual: fía cualquier importe, sin límite ni aprobación (C).
- **G-08, confirmado** y ampliado en N-04 (S, C).
- **B-16, confirmado** por la cadena de código y los permisos de la base (C): el encargado tiene `product.manage` pero no `price_list.manage`, que el alta simple con precio vuelve a pedir (`packages/domain/src/products.ts:383` → `pricing.ts:111`), y la web le enseña «Nuevo producto». Es el mismo permiso anidado. No se ejecutó por la interfaz.
- **E-08:** la cuenta del cajero sobrevivió a su desactivación y la cobró el dueño en O (ver O).

### Lo que se comprobó y está bien
- **Aterrizaje por oficio (S):** el cajero y el encargado caen en /vender, el administrativo en /inicio, el contador en /admin/contabilidad y el almacenista en «Llegó mercancía» con el pedido pendiente. El contador no puede vender. El almacenista llega al «¿Qué llegó?» del pedido.
- **Desactivar corta al instante (C):** en cada petición, sin esperar a que caduque el token. Reactivar y devolver el rol funcionan. Al final, en la base, los dos están activos con su rol.
- **La anulación fallida no dejó nada a medias (C).**
- **Invariantes y tiempos:** E1, E2 y E3 dan 0. La conciliación libro-mayor da 1 en E2 y E3 (L-01). Outbox vacío. Hubo 471 peticiones, ninguna por encima de 3 s; la más lenta, `GET /v1/treasury/accounts`, 680 ms (C).

### Cierre del bloque N (validador)
GATE verde (el del último gate sobre el mismo código: 736 pasos, vitest 805 y pgTAP 1264, iguales a la línea base; `git diff` de apps, packages y supabase vacío) · invariantes en 0 para E1, E2, E3; cola de asientos y outbox vacíos · informe «conciliación libro-mayor de septiembre»: 0 en E1, 1 en E2 y 1 en E3 (L-01) · 510 peticiones, ninguna por encima de 3 s (la más lenta, 0,68 s) · documento con N-01..N-11 y sus capturas, sin huérfanas.

## Bloque O · Varias empresas

**Qué se hizo.** dueno.andina@ es Dueño de E2 (desde A) y de E3 (desde N). La corrida fue el 28/09.
- **Aterrizaje y cambio de empresa:** «Elige la empresa» y «Cambiar de empresa».
- **¿Nada se mezcla?:** fotos de productos, clientes, Mi dinero y Ventas de las dos empresas.
- **La prueba de las dos pestañas:** la 1 en E2 con una cuenta; la 2 cambia a E3; la 1 cobra sin recargar.
- **La pestaña que recarga** (`o2-recargar.mjs`): la 1 en E2; la 2 cambia a E3; la 1 recarga.

**Datos creados en O:** la factura **A-9** de E2 (28/09, 59.647,60, pagada en efectivo USD), cobrada sobre la cuenta que el cajero había armado en N.

**No se probó:** el caché de la conversión Bs/USD al cambiar de empresa (O-07), porque todas las tasas de hoy son de plataforma.

### O-01 · O · alta · E2, E3 · dueño — una pestaña que recarga se pasa sola a la empresa que se eligió en otra pestaña, sin avisar (S, E, C)
PANTALLA: toda la web (`apps/web/src/app/session.tsx:55`, `:134-138`, `:168-184`)
DIMENSIÓN: ESTADOS · DATOS
HACE:
- La empresa activa vive en el estado de React de cada pestaña. Por eso, sin recargar, cada pestaña conserva la suya: la 1 cobró A-9 en E2 después de que la 2 cambiara a E3, y la venta quedó bien.
- Al elegir, la empresa se guarda en una sola clave por usuario (`ladino.company.<userId>`), y cada carga de página la vuelve a leer. Nadie escucha el evento `storage` ni un `BroadcastChannel`.
- En la segunda pasada, la pestaña 1 estaba en /vender de «Distribuidora Andina». La 2 cambió a E3. La 1 recargó (F5) y quedó en **«Ferretería El Tornillo»**, con la caja llena de productos de la ferretería, **sin ningún aviso**.
- No mezcla datos: la cabecera lo dice, y el servidor exige que la cabecera `X-Company-Id` y el cuerpo coincidan (C). Pero la próxima venta de esa caja sería una factura de la otra empresa: otro talonario, otro inventario, otro libro.
EVIDENCIA: `capturas-recorrido/O/O-01-pestana1-antes-en-E2.png` y `O-01-pestana1-tras-F5-en-E3.png`.
REPRODUCIR: dos pestañas con el mismo usuario → la 1 en E2 → la 2 cambia a E3 → F5 en la 1.
¿SE NOTA?: solo si la persona mira la cabecera.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿La empresa activa va por pestaña (sessionStorage), o se avisa del cambio en las demás pestañas? QuickBooks Online cierra la sesión de la otra ventana (E, fuente en el informe del estratega).

### O-02 · O · media · E2 · dueño — la venta del POS queda entera a nombre de quien cobra: quién armó la cuenta no queda en ningún sitio (C; E)
PANTALLA: /vender → Cobrar
DIMENSIÓN: DATOS
HACE:
- La cuenta «Carlos Fiado Nuevo» la armó el cajero en N; no pudo cobrarla (N-01) y lo desactivaron (N-06). Apareció en la caja del dueño (E-08). La pestaña de la cuenta solo enseña el cliente y el número de líneas (`Vender.tsx:699`). El dueño le sumó una Pasta y la cobró como A-9.
- A-9 queda a nombre del dueño en el documento, el pago y las dos actas, con `vendor_id` en null.
- La fila de `pos_carts` se borró al cobrar y nunca tuvo acta (`packages/domain/src/pos-carts.ts`; `sales.ts:~3783`). El único rastro indirecto es `customers.created_by` = cajero@, que no dice quién armó la venta.
EVIDENCIA: `capturas-recorrido/O/O-02-cuenta-del-cajero-en-caja-del-dueno.png`; `select created_by, vendor_id from documents where id='01a0e849-049e-7943-8479-587fee9de1cc'` → el dueño, null; ningún `audit_event` de cuentas.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿El vendedor de una venta del POS es quien armó la cuenta o quien la cobró? ¿Una cuenta ajena avisa al abrirse? Es la decisión pendiente de E-08.

### O-03 · O · media · (todas) · — — las altas de personas y sus roles no guardan autor en su fila (C)
DIMENSIÓN: DATOS
HACE:
- `memberships`, `user_role_assignments`, `scope_bindings`, `roles` y `role_permissions` tienen columna `created_by`, pero no el trigger `set_row_provenance`. Los inserts de `members.ts:169` y `:180` no ponen autor.
- Resultado: 7 de 15 asignaciones y 7 de 11 membresías sin autor. Entre ellas, el owner de E3 dado a dueno.andina@ y todos los roles de E2 del bloque N.
- El autor solo queda en `audit_events` (N-10). Esas cinco son exactamente las tablas de `public` que tienen `created_by` sin el trigger.
- Pasa lo que CLAUDE.md §3 advierte sobre la primera excepción: una regla de familia («toda tabla con `created_by` lleva su procedencia») que nadie comprueba.
EVIDENCIA: `select count(*) filter (where created_by is null), count(*) from user_role_assignments` → 7 de 15.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: no. Falta el invariante que lo mire: «toda tabla de `public` con `created_by` tiene `set_row_provenance`» = 0.

### O-04 · O · baja · E2, E3 · dueño — «Elige la empresa» y «Cambiar de empresa» enseñan el RIF crudo, y el resto de la web con guiones (S, E)
PANTALLA: «Elige la empresa» (`session.tsx:800-805`) · «Cambiar de empresa» (`shell.tsx:551-558`) · `apps/web/src/app/rif.ts:21-23`
DIMENSIÓN: FORMA · TEXTO
HACE: `rifParaMostrar()` devuelve el `tax_id` tal cual: «J405551234». Mi empresa formatea el mismo dato como «J-40555123-4» (`formatearDocumento`). Es la misma raíz de M-05 y P-02: dos funciones distintas para el mismo documento.
EVIDENCIA: `capturas-recorrido/O/O-04-elige-la-empresa-rif-crudo.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### O-05 · O · media · E2, E3 · dueño — nada distingue una empresa de otra salvo el texto: mismo ícono para todas, sin el logo que ya existe (E)
PANTALLA: «Elige la empresa» · «Cambiar de empresa» · cabecera (`shell.tsx:536-537`)
DIMENSIÓN: FORMA
HACE: el mismo ícono `Building2` para cualquier empresa. `Company.logo_url` existe (`apps/web/src/lib.ts:111-112`) y no se usa ahí. La única señal de en qué negocio se está es el nombre, en letra pequeña, en la cabecera. Justo lo que O-01 necesita para que se note.
EVIDENCIA: `capturas-recorrido/O/O-05-cambiar-de-empresa.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Logo o color por empresa en la cabecera y el selector?

### O-06 · O · baja · (todas) · dueño — el botón del selector enseña el nombre comercial y la lista la razón social (E; SOSPECHA)
PANTALLA: «Cambiar de empresa» (`shell.tsx:537` frente a `:554`)
DIMENSIÓN: TEXTO
HACE: el botón usa `trade_name ?? legal_name` y cada fila de la lista usa `legal_name`. Con un nombre comercial distinto, la persona no reconocería su empresa en la lista. En el recorrido no se vio, porque en E2 y E3 los dos nombres coinciden.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### O-07 · O · baja · (todas) · — — la conversión Bs/USD se cachea sin la empresa (C; SOSPECHA)
DIMENSIÓN: DATOS
HACE: `apps/web/src/components/MoneyDualInput.tsx:59` usa `["dual", limpio, moneda, fecha]` como clave, y el servidor contesta según la empresa (`apps/api/src/routes/sales.ts:812-838`). Al cambiar de empresa en la misma pestaña, la conversión podría salir de la empresa anterior durante 60 s. Hoy no se nota: las tres tasas son de plataforma.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### Confirmaciones de hallazgos anteriores
- **E-08, confirmado con ejecución real:** la cuenta que armó el cajero sobrevivió a su desactivación y la encontró el dueño en su caja, sin ninguna señal de quién era (S, E, C). Ver O-02.
- **N-02:** la divergencia de permisos también la vio el auditor desde este bloque: `has_permission(membership.manage, E3) = t` y `nivelTenant = f` (C).
- **A-13:** el dueño solo llegó a tener dos empresas porque otra cuenta fundó E3 y lo invitó. Desde dentro no hay forma de abrir una segunda (E).
- **K-08:** «Lo que gané hoy Bs. 5.172,5356» en el Inicio de E2 (S). Ver P-01.

### Lo que se comprobó y está bien
- **Nada se mezcla entre E2 y E3 (S, C).** Productos, clientes, Mi dinero y ventas son distintos, y la tasa BCV es la misma (es global). Las 16 comprobaciones cruzadas de la base dan 0: documentos, pagos, kardex, asientos, cuentas y clientes sin ninguna referencia a la otra empresa.
- **La empresa de cada petición la decide la cabecera, y el servidor la verifica (C).**
  - `X-Company-Id` se valida contra las empresas visibles del usuario (`apps/api/src/middleware/scope.ts:42-81`).
  - El cuerpo repite `company_id`, y `coherente()` exige que coincida (`sales.ts:65-72`).
  - Las FK compuestas `(company_id, x)` impiden un cliente, almacén, cuenta o producto de otra empresa.
  - En la web, Vender se vuelve a montar con cada empresa (`key={empresa.id}`), y las cuentas del disco y de la nube van separadas por empresa.
- **A-9 quedó entera en E2:** cliente, pago, cuenta de tesorería y kardex de E2 (S, C). Captura: `capturas-recorrido/O/O-pestana1-cobra-en-E2.png`.
- **«Elige la empresa» recuerda la última elegida** y se usa con el teclado (botones nativos) (E).
- **Invariantes y tiempos:** E1, E2 y E3 dan 0, con 1 en la conciliación de E2 y E3 (L-01). Hubo 111 peticiones, ninguna por encima de 3 s; la más lenta, `POST /v1/pos/sales`, 541 ms (C).

### Cierre del bloque O (validador)
GATE verde (el del último gate sobre el mismo código: 736 pasos, vitest 805 y pgTAP 1264, iguales a la línea base; `git diff` de apps, packages y supabase vacío) · invariantes en 0 para E1, E2, E3; cola de asientos y outbox vacíos · informe «conciliación libro-mayor de septiembre»: 0 en E1, 1 en E2 y 1 en E3 (L-01) · 141 peticiones, ninguna por encima de 3 s (la más lenta, `POST /v1/pos/sales`, 0,54 s) · documento con O-01..O-07 y sus capturas.

## Bloque P · Inicio, reportes y búsqueda

**Qué se hizo.** Con la dueña de E1 y el dueño de E2 y E3, el 28/09.
- **Inicio:** «Hoy» y «Este mes» de las tres empresas.
- **Reportes:** cada tarjeta y su destino.
- **Búsqueda Ctrl+K:** cuatro términos por empresa (un cliente, un producto, un documento por su número y una pantalla).
- **Forma:** Inicio y caja de E1 a 390 px en oscuro, y de E2 a 1024 px.
- **La deuda por rol:** además, una llamada a la API local como cajero y como almacenista, para comprobar P-04.

**La pregunta central, ¿cada cifra del Inicio cuadra con lo que pasó?: sí, en las tres empresas y hasta el último decimal (C).** La tabla está al final del bloque. Lo que falla es la presentación y lo que rodea a las cifras.

### P-01 · P · alta · (todas) · dueño — «Lo que gané» sale con cuatro a seis decimales en la pantalla más vista, contra lo que dice ADR-0063 (S, E, C)
PANTALLA: Inicio → «Lo que gané hoy / este mes»
DIMENSIÓN: DINERO · FORMA
PROMETE: «Ventas menos lo que costó la mercancía, gastos, mermas y faltantes: lo mismo que tu contabilidad». Y lo es: `ganado_mes` es literalmente el resultado del mayor. ADR-0063, en «Lo que NO cambia», dice que las pantallas de contabilidad e inventario reciben esos importes redondeados a 2 al servir.
HACE:
- Se sirve sin redondear (`apps/api/src/routes/negocio.ts:165-167`, `:251-252`, con `::text`). Lo mismo pasa en el estado de resultados (`apps/api/src/routes/accounting.ts:598-603`).
- En pantalla: E1 **«Bs. 15.580,653921»**, E2 **«Bs. 232.167,219258»** («hoy»: «Bs. 20.705,4102»), E3 **«Bs. 59.068,56931»**.
- Los decimales vienen del costo de venta, que va a 8 decimales como permite ADR-0063, y de los egresos en divisa (P-03).
EVIDENCIA: `capturas-recorrido/P/P-01-lo-que-gane-seis-decimales-E1.png` y `capturas-recorrido/P/P-01-lo-que-gane-seis-decimales-E2.png`. La consulta del mayor da las mismas cifras.
¿SE NOTA?: la persona lo ve cada vez que entra.
¿NECESITA DECISIÓN DEL DUEÑO?: no para redondear al servir, que ya lo dice el ADR. La política del residuo sigue siendo VALIDAR-CONTABLE (K-08).

### P-02 · P · media · (todas) · administrativo / cajero — el RIF del cliente se guarda con guiones o sin ellos según por dónde entró, y la búsqueda depende de cómo se escriba (S, E, C)
PANTALLA: Ctrl+K · lista de clientes (`apps/api/src/routes/customers.ts:70-71`)
DIMENSIÓN: DATOS · TEXTO
HACE:
- El alta de la administración guarda lo tecleado («J-40888777-6»; `apps/web/src/pages/clientes/Clientes.tsx:304`, `:526` → `packages/domain/src/customers.ts:146`). El mostrador compone prefijo más dígitos («V18222333»).
- La búsqueda compara crudo (`ilike`). Buscar «J40888777» no encuentra a Bodegón Mayorista Los Andes, y al revés.
- La unicidad NO se rompe: el índice `customers_company_tax_id_uidx` normaliza. El lookup exacto del mostrador también está normalizado. Así que el cliente duplicado que teme el estratega no puede crearse: el alta respondería DUPLICATE.
- La paleta enseña el RIF crudo (`apps/web/src/app/palette.tsx:98-105`), y la lista de clientes lo formatea. El snapshot `customer_tax_id_snapshot` de los documentos y libros guarda los dos formatos. No lo miró el auditor fiscal, porque no estaba en este bloque.
EVIDENCIA: `capturas-recorrido/P/P-02-rif-crudo-en-la-busqueda.png`; en la base, `J-40888777-6` y `J409998881`, los dos en E2.
¿SE NOTA?: la persona ve «Sin resultados» y no sabe por qué.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Se normaliza en el servidor para todos los caminos (como ya hace la importación, `customers.ts:235-237`) y se migran los datos, o solo se normaliza la búsqueda?

### P-03 · P · media · E2, E3 · contador — los gastos y pagos a proveedores en divisa se asientan con fracciones de céntimo (C)
DIMENSIÓN: CONTABILIDAD · DINERO
HACE: ADR-0063 §2 redondea el funcional solo en los COBROS. Un gasto de USD 5 y un pago de USD 50 a 855,6625 quedan en la cuenta 1.1.02 como 4.278,3125 y 42.783,125 (asientos 52 y 46, 25/09). Esos decimales pasan al mayor de caja y a «Lo que gané» (P-01).
EVIDENCIA: la consulta de `journal_lines` de 1.1.02 con importes de más de 2 decimales devuelve 2 filas.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. VALIDAR-CONTABLE: ¿el equivalente en bolívares de un egreso en divisa se redondea al céntimo, y la diferencia va al diferencial?

### P-04 · P · media · E2 · cajero, almacenista — cualquier miembro recibe lo que debe cada cliente, aunque el Inicio se lo oculte (C; confirmado por S)
DIMENSIÓN: ROLES · DINERO
PROMETE: ADR-0048 §5: «El dinero agregado nunca viene gratis con la membresía… estado de cuenta (`ar.read`)». El Inicio esconde «Lo que me deben» sin `customer.tax_id.manage` o `accounting.read` (`apps/web/src/pages/negocio/Inicio.tsx:64`).
HACE: `GET /v1/customers?with_debt=1` no comprueba ningún permiso (`apps/api/src/routes/customers.ts:52-96`), y la pantalla de clientes de la tienda lo pide (`apps/web/src/pages/negocio/Clientes.tsx:74`). Llamada como cajero y como **almacenista** (que no tiene ningún permiso sobre clientes): 200, con Abastos El Sol 17.894,28, Alcaldía de Iribarren 86.934,03 y John Smith 1.988,26.
EVIDENCIA: `capturas-recorrido/P/P-04-deuda-por-rol.txt`.
¿SE NOTA?: termina en verde.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿El cajero ve la deuda de cada cliente para fiar? El almacenista, al menos, no debería.

### P-05 · P · media · (todas) · dueño — «Te deben… Un mensaje a tiempo cobra la mitad» lleva a una lista que no se puede ordenar por deuda (E)
PANTALLA: Inicio → recordatorio → /admin/clientes (`apps/web/src/pages/negocio/Inicio.tsx:127-133` → `apps/web/src/pages/clientes/Clientes.tsx:142-158`)
DIMENSIÓN: PROMESA
HACE: la columna «Deuda» tiene `enableSorting: false`, no hay filtro «con deuda» y el endpoint no acepta orden. Con más de 25 clientes hay que hojear página por página para encontrar a quién cobrar, justo cuando el texto dice que el tiempo importa.
EVIDENCIA: `capturas-recorrido/P/P-05-te-deben-E2-tablet.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿El recordatorio lleva a los deudores ordenados, o a la ficha del de mayor deuda vencida?

### P-06 · P · media · (todas) · cualquiera — Ctrl+K no encuentra un documento por su número ni una acción como «cierre» (S, E, C)
PANTALLA: Ctrl+K (`apps/web/src/app/palette.tsx:76-117`)
DIMENSIÓN: PROMESA · TEXTO
HACE:
- Busca clientes, productos y pantallas, que es lo que promete su texto: «Buscar clientes, productos o ir a una pantalla…».
- «R-5», «A-2» y «A-5» dan «Sin resultados», sin sugerir dónde buscar. «cierre» también, porque la acción vive dentro de Mi dinero.
- El pie promete **«Asistente de Ladino — este espacio lo espera. Próximamente.»** (`palette.tsx:196-198`): una función que no existe, anunciada en la herramienta de todos los días.
- El teclado funciona por código: flechas y Enter. Escape no se verificó en vivo.
EVIDENCIA: `capturas-recorrido/P/P-06-buscar-un-recibo-sin-resultados.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: sí. ¿Documentos por número en la paleta, con permiso por rol? ¿Se quita el «Próximamente»?

### P-07 · P · media · (todas) · dueño — «Reportes» es una sola cifra, el diferencial cambiario, y tres enlaces (E)
PANTALLA: /admin/reportes (`apps/web/src/pages/reportes/Reportes.tsx:59-85`)
DIMENSIÓN: PROMESA
HACE: no hay ventas por producto, por vendedor ni por día, ni margen, IVA del mes o cierre de caja. Loyverse y Alegra traen de fábrica el reporte diario, el mensual y los productos y clientes que más venden (E, con fuentes en el informe del estratega).
EVIDENCIA: `capturas-recorrido/P/P-07-reportes-una-cifra.png`.
¿NECESITA DECISIÓN DEL DUEÑO?: sí, y es de producto: ¿qué reportes primero?

### P-08 · P · baja · (todas) · dueño — el pie del gráfico dice «esmeralda ganancia» y la barra es azul (E)
PANTALLA: /admin/reportes (`Reportes.tsx:154-169`; `apps/web/src/styles/theme.css:51`)
DIMENSIÓN: TEXTO · FORMA
HACE: la barra de ganancia usa `var(--accent)`, que es azul. La de pérdida, en ámbar, sí coincide con el texto.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### P-09 · P · baja · (todas) · — — si hay tasa BCV de mañana, el Inicio la enseña mientras la caja cobra con la de hoy (C; SOSPECHA)
DIMENSIÓN: TIEMPO
HACE:
- `tasa_del_dia` y `/v1/negocio/convertir` piden `rate_for(…, caracas_day + 1)` (`negocio.ts:231`, `:301`). La venta usa el día de hoy (`sales.ts:383`), y la deuda también (`document_debt_today`).
- Con una tasa de fecha valor mañana guardada antes de medianoche, el Inicio y el «≈ Bs» enseñarían la de mañana, y saldría «Estás vendiendo con la tasa BCV de hace -1 días».
- No se reprodujo. Las tres tasas de la base son del día en que se crearon.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### P-10 · P · baja · (todas) · — — «Por agotarse» ignora la existencia en lotes (C; SOSPECHA)
DIMENSIÓN: DATOS
HACE: `platform.low_stock_products` une `stock_balances` con `lot_id is null`. Un producto que se controle por lotes contaría como 0 y saldría «por agotarse» teniendo existencia. Hoy no hay ningún lote.
¿NECESITA DECISIÓN DEL DUEÑO?: no.

### Confirmaciones de hallazgos anteriores
- **K-08:** llega al Inicio (P-01).
- **G-10 / L-07:** «Últimas ventas» del Inicio mezcla ventas, devoluciones en negativo y la anulada en positivo, con la misma regla de presentación (`Inicio.tsx:360-369`) (E).
- **A-04:** la bodega E1 ve Libros fiscales, Declarar IVA, IGTF y Facturación fiscal en el menú, ahora con razón, porque factura desde M (S).
- **Sospecha del bloque E sobre /vender a 1024 px («apretado»): no se confirma.** La captura 025 se ve holgada (E).

### Lo que se comprobó y está bien
- **Las cifras del Inicio cuadran con la base (C):**

| Empresa | Vendido este mes | Lo que gané este mes (= mayor) | Me deben (= documentos a la tasa de hoy) | Mi dinero Bs (= mayor 1.1.01) | Mi dinero USD | Por agotarse | Diferencial (= 4.1.02) |
|---|---|---|---|---|---|---|---|
| E1 | 52.894,18 ✓ | 15.580,653921 ✓ | 1.839,97 ✓ | 46.789,45 ✓ | 4,00 ✓ | 0 ✓ | +2,10 ✓ |
| E2 | 650.467,72 ✓ | 232.167,219258 ✓ | 106.816,57 ✓ | 493.860,89 ✓ | 70,12 ✓ | 1 ✓ (Café, 23 frente a 30) | +70,05 ✓ |
| E3 | 220.821,31 ✓ | 59.068,56931 ✓ | 23.351,26 ✓ | 111.369,61 ✓ | 55,98 ✓ | 0 ✓ | +36,43 ✓ |

- **Cómo se calcula cada cifra (C):**
  - «Vendido» suma facturas, recibos y notas de débito, y resta notas de crédito y devoluciones. Nunca cuenta las anuladas. Va con IVA y en moneda funcional. «Hoy» es el día de Caracas, comparando dos `date`.
  - «Me deben» difiere del mayor 1.1.03 en la revalorización a la tasa de hoy, que no se asienta (ADR-0047) y que la tarjeta anuncia: «cambia cuando cambia la tasa».
- **Ctrl+K** filtra por la empresa de la cabecera, cachea por empresa, no expone el costo de los productos y encuentra clientes, productos y pantallas (S, C).
- **Forma:** sin desborde horizontal a 390 px en oscuro (`capturas-recorrido/P/P-inicio-390-oscuro.png`) ni a 1024 px. La barra inferior que en la captura de página completa parece tapar «Te deben…» es la barra fija del móvil, retratada a media página: no es un hallazgo (S).
- **Invariantes y tiempos:** E1, E2 y E3 dan 0, con 1 en la conciliación de E2 y E3 (L-01). Outbox vacío. Hubo 240 peticiones, ninguna por encima de 3 s; la más lenta, `GET /v1/products?search=Cemen`, 883 ms. `/v1/negocio/resumen` tarda entre 142 y 294 ms, y llama a `document_debt_today` una vez por documento abierto: crecerá con los documentos (C).

### Cierre del bloque P (validador)
GATE verde (el del último gate sobre el mismo código: 736 pasos, vitest 805 y pgTAP 1264, iguales a la línea base) · invariantes en 0 para E1, E2, E3; cola de asientos y outbox vacíos · informe «conciliación libro-mayor de septiembre»: 0 en E1, 1 en E2 y 1 en E3 (L-01) · 240 peticiones, ninguna por encima de 3 s (la más lenta, `GET /v1/products?search=Cemen`, 0,88 s) · documento con P-01..P-10 y sus capturas.

---

## Estado

El libro de estado de la respuesta del dueño (`RESPUESTA_RECORRIDO_2026-09-24.md`, 2026-09-28). Los hallazgos de arriba no se reescriben: aquí va una línea por ID, que cambia en el mismo commit que la cierra.

Estados posibles:
- `cerrado (<commit>)`;
- `no reproducido (<razón>)`;
- `construido (<commit>)`;
- `dejado de prometer (<commit>, ADR-xxxx)`;
- `decidido por criterio (<decisión>, alternativa: <cuál>)`.

Línea base al empezar: VERIFY EXIT=0 · 736 pasos · vitest 805 en 19 paquetes · pgTAP 1264 en 70 ficheros (gate del cierre Z, commit `804862b`).

| ID | Severidad | Estado | Nota |
|---|---|---|---|
| A-01 | alta | abierto | — |
| A-02 | alta | abierto | — |
| A-03 | alta | cerrado (c36753e) | historia append-only del tipo con vigencia; sin tipo vigente no se factura (TAXPAYER_TYPE_REQUIRED en el dominio, LAD98 en la base); el registro lo pregunta (migraciones 20260928190000-190200, ADR-0072 §1). Decidido por criterio (no_contribuyente se deriva de no tener RIF y nunca se declara, alternativa: declararlo con RIF; lectura del tipo sin permiso, alternativa: exigir company.settings.manage; retroactivo admitido con aviso de documentos ya emitidos, alternativa: prohibir fechas anteriores al último emitido) — ADR-0072, nota de aplicación |
| A-04 | alta | abierto | — |
| A-05 | alta | abierto | — |
| A-06 | alta | cerrado (c36753e) | el recibo de devolución imprime «Recibo de devolución · Documento no fiscal: no es factura ni nota de crédito y no otorga derecho a crédito fiscal», sin RIF (nunca el marcador `PEND-`, detectado con `esMarcadorSinRif` de rif.ts), sin IVA, sin providencia y sin copia fiscal (422); la web no le ofrece forma libre. P-16 afina la redacción |
| A-07 | media | cerrado (pendiente de commit) | el logo se autoriza (`autorizarLogo`, company.settings.manage) antes de leer el archivo y de tocar el almacenamiento: 403 sin objetos nuevos (E2E e2e-permisos-que-terminan-en-verde; `pnpm recorrido A`) — ADR-0068 §7 |
| A-08 | media | cerrado (c36753e) | estructura del RIF validada en el servidor (422 legible); dígito verificador módulo 11 que avisa y deja acta `*.tax_id_check_digit_mismatch`; registro con las seis letras (añade C); OPEN_QUESTIONS #9 cerrada; letra C abierta en PENDIENTES_ASESOR P-49. Decidido por criterio: el cliente se identifica con RIF o con cédula (V/E + hasta 8 dígitos, sin verificador; PA 00071 art. 13.7); la empresa y el proveedor siempre con RIF; un V/E de 9 dígitos es RIF, nunca cédula; la cédula se sigue mostrando `V-12.345.678` (alternativa: un selector explícito de tipo de documento). Revisión 2026-09-28 (criterio §2.16): **decidido por criterio** que el cliente acepta también pasaporte (manda la PA 00071 art. 13.7): P + 9 dígitos es RIF P y cualquier otro «P» + alfanumérico de 5 a 20 es pasaporte, guardado «P» + mayúsculas sin separadores y mostrado como hoy (alternativa: un selector explícito de tipo de documento); `createCompany` no acepta el marcador por la entrada, solo el que genera el registro por un parámetro interno (alternativa: aceptar `^PEND-[0-9A-F]{10}$` por la entrada); el mismo documento con otra grafía es ok sin escribir (alternativa: 422 «ya es ese»). La clasificación «P → no domiciliado» queda como está, pendiente del asesor (R-58) |
| A-09 | media | abierto | — |
| A-10 | media | cerrado (pendiente de commit) | cerrado junto con E-15 (ADR-0077 §2): el diálogo dice las dos ramas («Si todavía no has emitido documentos, el cambio es directo…; si ya emitiste, el camino es «Corregir RIF», con el motivo») y siempre «Actualiza tu RIF ante el SENIAT dentro del mes siguiente (COT art. 35)»; la corrección lleva el aviso del art. 13.5 de la PA 00071 (textos del dueño, RESPUESTA §3 A-10). Decidido por criterio: el texto no consulta si hay documentos (alternativa: `has_issued_documents` en `CompanyResponse`, un cambio de contrato) |
| A-11 | media | cerrado (c36753e) | borrada la leyenda de homologación del pie (`documents-pdf.ts`); la única leyenda legal es «SIN DERECHO A CRÉDITO FISCAL» en la copia (FC-28, probado en los tres destinos). El papel (ADR-0071 §4, revisión 2026-09-29): la marca de cortesía y el pie en CADA página y solo en factura, NC y ND; la franja preimpresa con el mismo alto en vista y papel. Decidido por criterio: `print_control_number` es presentación y se lee al imprimir (alternativa: congelarlo al emitir); `?destino=cortesia` explícito se acepta (alternativa: solo papel y vista); la «Venta lista» de la caja ofrece «Imprimir en la forma libre» para la factura, con el diálogo del detalle (alternativa: solo desde el detalle); la marca nombra la clase, «La nota de crédito válida…» (alternativa: el literal «La factura válida…»). Auditoría fiscal 2026-10-02 (RESPUESTA §0, manda la norma): PA 00071 art. 33, un documento ocupa UNA forma libre — P-55 cerrada; decidido por criterio, opción (a): tope de FILAS IMPRESAS por empresa (`rows_per_free_form`, 15, máximo 18; revisión A-2: las filas las parte una sola función que usan el dominio y el PDF; alternativa rechazada: truncar la descripción), 422 al emitir, aviso en la caja y en la factura de administración, y el papel rechaza lo que pase de una página o invada el pie (FC-34) (alternativa (b): partir la operación sola en varios documentos). Arts. 26-27: el papel imprime «Serie A N° 00000001». Art. 13.7: la factura sobre forma libre exige adquirente identificado (P-57, lectura conservadora; LAD99). Decidido por criterio en la revisión: la NC y la ND identifican al adquirente como su factura (regla 1; R-63 resuelto; alternativa: exigirles el 13.7); la contingencia refleja su papel y no pasa por el tope ni el adquirente (alternativa: exigírselo); `delivery_note` fuera, P-62 |
| A-12 | media | abierto | — |
| A-13 | media | cerrado (pendiente de commit) | «Crear otra empresa» en el selector: `POST /v1/onboarding/another-company` reutiliza el alta en un tenant NUEVO, del que la persona nace Titular y Dueño (`platform.bootstrap_another_tenant`, migración 20261003120000); E2E `e2e-empresa-e-invitaciones` y pgTAP 100; `pnpm recorrido A` — ADR-0077. Decidido por criterio: solo el Titular de alguna cuenta (alternativa: cualquier persona con sesión); clave natural = nombre o RIF entre sus negocios, sin Idempotency-Key (alternativa: llave por usuario); se enseña con `company.manage` y decide el servidor (alternativa: un campo en la sesión) |
| A-14 | baja | cerrado (pendiente de commit) | logo por contenido (carpeta = SHA-256 del archivo); el PDF usa siempre el logo VIGENTE (el logo es presentación, no requisito del art. 13); una versión reemplazada se conserva 30 días desde que QUEDA huérfana y después la purga la API tras cada logo nuevo con `platform.company_logo_purgeable` (migraciones 20261003130000, 130100 y 130200). Decidido por criterio: sin rama «referenciada por documentos», alternativa (a): congelar el logo al emitir; purga en la subida y no job del worker (sin credencial de Storage), alternativa: job con esa credencial — ADR-0068 §9 |
| A-15 | baja | abierto | — |
| A-16 | baja | abierto | — |
| A-17 | baja | cerrado (c36753e) | `cambiarRif` rechaza `PEND-…` con su propio mensaje y cualquier cosa que no sea un RIF (422) |
| A-18 | baja | abierto | — |
| A-19 | baja | abierto | — |
| B-01 | alta | abierto | — |
| B-02 | alta | cerrado (c36753e) | aceptar otra tasa cierra la vigencia y abre otra desde hoy (`platform.accept_general_vat`); 0 % y fuera de 8–16,5 % → 422 LAD97; trigger en `tax_rules` (ADR-0073). Decidido por criterio: una regla con líneas emitidas se cierra, nunca se retira; el mismo día en que ya se facturó, 422 y la persona elige la fecha efectiva (alternativa: correrla sola a mañana) |
| B-03 | alta | cerrado (c36753e) | ADR-0071 |
| B-04 | media | cerrado (c36753e) | reducida, adicional (general + 15 %) y exenta vienen del catálogo con su cita y se venden; `no_sujeto` y exonerado no se ofrecen; la exenta «ACEPTADA por el dueño» se cierra (migraciones 20260928150000 y 150100, ADR-0073). Decidido por criterio: el servidor rechaza (422) clasificar en lo que el catálogo no ofrece (alternativa: solo esconderlo en la pantalla); la adicional se factura como 31 % en una línea (alternativa: 16 % + 15 %, VALIDAR-SENIAT P-53) |
| B-05 | media | abierto | — |
| B-06 | media | abierto | — |
| B-07 | media | cerrado (c36753e) | `platform.taxpayer_type_at(empresa, día)` es la única lectura; especial con fecha de notificación y vigencia. Decidido por criterio (el IGTF exige ser especial el día del cobro, alternativa: apagar el acta al declarar una vigencia futura) — ADR-0072, nota de aplicación |
| B-08 | media | cerrado (c36753e) | «Formas libres» en el catálogo de regímenes (migración 20260928180100; el `code` no cambia), en /empezar, en la puesta a punto y en los docs; cita PA 00071 arts. 6, 30 y 31 |
| B-09 | media | abierto | — |
| B-10 | media | abierto | — |
| B-11 | media | cerrado (c36753e) | la ayuda del porcentaje sale de `iva_catalog` (catálogo con cita), sin cifra en la web |
| B-12 | media | abierto | — |
| B-13 | baja | abierto | — |
| B-14 | baja | abierto | — |
| B-15 | baja | abierto | — |
| B-16 | baja | cerrado (6ceea89) | ADR-0068 |
| B-17 | baja | abierto | — |
| B-18 | baja | abierto | — |
| B-19 | baja | abierto | — |
| C-01 | crítica | cerrado (c36753e) | ADR-0074 |
| C-02 | alta | abierto | — |
| C-03 | alta | abierto | — |
| C-04 | alta | cerrado (c36753e) | ADR-0074 · decidido por criterio (§2.16): un trabajo `failed` se puede volver a subir (alt.: reanudarlo); coherencia de formato por archivo (alt.: detectarlo); el worker adopta `ladino_api` (alt.: procesar en la API); costo de referencia guardado en el producto (alt.: solo en el informe) |
| C-05 | media | cerrado (c36753e) | ADR-0074 |
| C-06 | media | abierto | — |
| C-07 | media | abierto | — |
| C-08 | media | cerrado (6ceea89) | ADR-0068 |
| C-09 | media | cerrado (pendiente de commit) | la foto se autoriza (`autorizarImagenProducto`: product.manage y que el producto exista) antes de procesar y subir: 403/404 sin objetos (E2E; `pnpm recorrido C`) — ADR-0068 §7 |
| C-10 | media | abierto | — |
| C-11 | media | abierto | — |
| C-12 | baja | abierto | — |
| C-13 | baja | abierto | — |
| C-14 | baja | abierto | — |
| D-01 | crítica | cerrado (pendiente de commit) | sin RIF compra sin factura o con la del proveedor como soporte de costo, nunca crédito fiscal; el tipo de contribuyente solo se exige con factura (ADR-0066 nota ola 3); `e2e-llegada-sin-rif`, `pnpm recorrido D` |
| D-02 | alta | cerrado (pendiente de commit) | pago cruzado en compras (ADR-0075 §3, migración 20261003170000): una factura en USD se paga desde una cuenta en Bs (o al revés) a la BCV del día; la fila del pago va en la moneda del dinero y lo cancelado en `settled_amount`. En ventas ya existía. La pantalla «¿Ya la pagaste?» funciona sin tocarla (mandaba la cuenta en Bs y el servidor la rechazaba). Decidido por criterio: con `currency` = la de la factura y una cuenta en otra moneda, `gross_amount` es lo que se cancela; alternativa: un campo nuevo en el contrato |
| D-03 | alta | cerrado (pendiente de commit) | ADR-0076: la llegada estrena llave tras un 4xx (`llave-intento.ts`); la misma llave con otro cuerpo da IDEMPOTENCY_BODY_MISMATCH en palabras; `pnpm recorrido D` |
| D-04 | alta | cerrado (pendiente de commit) | migración 20261003160000: proveedor nacional sin RIF permitido; la factura con soporte lo exige (trigger LAD96 + caso de uso); decidido por criterio: nace `natural`/`no_contribuyente`, alternativa pedirlos en el alta; pgTAP 106 |
| D-05 | alta | cerrado (pendiente de commit) | precio sin IVA por omisión, `prices_include_tax` lo quita el servidor; `POST /v1/arrivals/preview` (el mismo caso de uso, deshecho) enseña base, IVA y total en «¿Todo bien?» |
| D-06 | alta | cerrado (pendiente de commit) | «Ya llegó la factura» pide el precio por línea; la revalorización por valor ya existía (E2E: cantidad igual, valor +100) |
| D-07 | alta | cerrado (pendiente de commit) | el pago a proveedor reconoce el diferencial al pagar (ver H-02); `pnpm recorrido D` lo comprueba con el mayor de la factura en cero |
| D-08 | alta | cerrado (pendiente de commit) | `instanteDelHecho`: hoy → `now()`, día anterior → último milisegundo de ese día en Caracas (F1, granularidad declarada); test que pasa a cualquier hora |
| D-09 | alta | cerrado (pendiente de commit) | decidido por criterio: la pantalla lo impide con su motivo (sin tasa del día «Seguir» se apaga y la vista previa lo repite); alternativa: permitirla por K-05, que exigiría inventar la tasa; `pnpm recorrido D` |
| D-10 | media | cerrado (pendiente de commit) | el mismo `instanteDelHecho` que D-08 para «ya era mía», recepción y pago: un solo reloj para el hecho |
| D-11 | media | cerrado (pendiente de commit) | sobregirar exige `allow_negative_balance` + `treasury.overdraft` + motivo, y deja el acta `treasury.overdraft.confirmed`; sin permiso 403 con qué hacer (H-05), sin motivo 422; decidido por criterio: los cuatro ojos no aplican al sobregiro en el acto, alternativa: aprobación pendiente con `approval_allowed` (ADR-0066 nota ola 3 §8, ADR-0068 §8); `e2e-sobregiro`, `pnpm recorrido D` |
| D-12 | media | cerrado (pendiente de commit) | sin RIF, la tarjeta y el resumen de la factura dicen «su IVA entra al costo», sin libro ni crédito (`capa-fiscal/textos.ts`) |
| D-13 | media | cerrado (pendiente de commit) | `exigeSaldo` formatea los importes del aviso («Bs. 120.000,00») |
| D-14 | media | cerrado (pendiente de commit) | ver I-03 |
| D-15 | baja | abierto | — |
| D-16 | baja | abierto | — |
| D-17 | baja | abierto | — |
| D-18 | baja | abierto | — |
| E-01 | crítica | cerrado (c36753e) | ADR-0071 · decidido por criterio: serie opcional (vacía = sin serie), alternativa: exigir serie; corrección de imprenta con acta, alternativa: solo anular y registrar |
| E-02 | crítica | cerrado (ddc34e8) | migración 20261002100000: percibe quien es especial el día del pago, en los pagos en divisas o cripto sin mediación financiera (PA SNAT/2022/000013 art. 1): qué instrumento causa es data de plataforma con fuente (migración 20261002100100: efectivo en divisa, USDT y Zelle sí; transferencia, tarjeta y punto de venta bancarios no; VALIDAR-TRIBUTARIO P-66); ni el acta `igtf_enabled_at` ni la empresa lo cambian (422 en los dos sentidos); el aviso de la caja usa la misma regla. E2E `e2e-igtf-especial`, `pnpm recorrido E`. Lo no percibido no se regulariza: VALIDAR-TRIBUTARIO P-32 |
| E-03 | crítica | cerrado (ddc34e8) | el PDF imprime alícuota y monto del IGTF, en divisa y en Bs a la tasa del cobro, en los tres destinos (FC-27 real); el cobro posterior emite la ND por IGTF (una línea no sujeta, consume control, libro base 0 e IVA 0, nace pagada; `igtf_debit_note` aditivo). pgTAP 098, `pnpm recorrido E/F`. VALIDAR-TRIBUTARIO P-40 |
| E-04 | alta | cerrado (c36753e) | el PDF discrimina base e IVA por alícuota con su porcentaje y «Exento (E)»; columnas sin IVA (FC-10, FC-11, FC-31) |
| E-05 | alta | cerrado (pendiente de commit) | por línea, base_bs = round(base_divisa × tasa, 2) e iva_bs = round(base_bs × alícuota, 2); totales por suma; la deuda sigue siendo el total en divisa (`insertarDocumento`). Invariante `fiscal_amount_gaps` con su corte en el enunciado (los emitidos antes no se tocan, regla 1); pgTAP 109 con sus variantes rotas. Decidido por criterio: la tolerancia de «total_usd × tasa − total_bs» es el redondeo por línea que dice §3 (media unidad de la divisa × tasa + 0,01 Bs), no «0,01 × líneas» literal, que es inalcanzable con el IVA en divisa redondeado al céntimo de dólar (P-85). Aserción cambiada: e2e-sales «la deuda se sirve a 2 decimales» 4190.32 → 4190.33. **Revisión «el cobro y el cierre» (migración 20261003200000):** la caja (`quotePos`) cotiza con la MISMA función que la factura (`fiscalDeLinea`); a la tasa del documento, pagar el total en Bs cierra en cero sin diferencial (decidido por criterio, reglas 2 y 3; alternativa: saldo en divisa × tasa siempre) y el diferencial del cierre tiene tope (`SETTLEMENT_MISMATCH`, regla 4; alternativa: aceptar cualquier diferencia). `pnpm recorrido E`: dos casos nuevos |
| E-06 | alta | abierto | — |
| E-07 | alta | abierto | — |
| E-08 | alta | cerrado (pendiente de commit) | ADR-0076: autor, hora y caja (`station_id`, decidido por criterio); la ajena en solo lectura salvo `pos.carts.manage` (dueño y administrativo; el encargado no, §2.8 — decidido por criterio, migración 20261003100100); aviso de las recuperadas; RLS de `pos_carts` por tenant |
| E-09 | media | abierto | — |
| E-10 | media | cerrado (c36753e) | el PDF lleva «P. unit. sin IVA» y «Total sin IVA»; el subtotal es la suma de la columna, luego el IVA por alícuota y el total (familia alícuotas; e2e-checklist-factura asevera los importes). El desfase de céntimos entre cantidad × unitario redondeado y el total de línea es el cálculo fiscal de E-05 (ola 3) |
| E-11 | media | cerrado (pendiente de commit) | ADR-0075 §6, migración 20261003180000: la línea de caja de un hecho en divisa guarda moneda, importe original y tasa (`platform.treasury_original_of`); la reversa los copia; las cajas y la CxC/CxP en divisa se revalúan al cierre del período (`fx_revaluation_items`). Decidido por criterio: revaluación acumulada, sin reverso al abrir (alternativa: reversar el primer día; P-86). Abierto: las líneas de CxC/CxP siguen en VES/identidad. E2E e2e-moneda-deuda-reversa, `pnpm recorrido E`. **Revisión (20261003210000):** la API sirve Debe/Haber en Bs y el original aparte; la revaluación netea por cuenta (reabrir y cerrar no asienta), no revalúa lo `paid`, y usa una tasa de cierre de no más de 7 días (parámetro de plataforma; decidido por criterio, alternativa: último día hábil; P-88); un período sin terminar se revalúa a hoy. **H6 cerrado (20261003210200):** las líneas de CxC/CxP de un documento en divisa llevan moneda, original y tasa del documento (decidido por criterio: el original es el del hecho —total o lo saldado— y no una división; alternativa: siempre funcional / tasa); la suma de originales de un documento saldado es cero. Abierto: ningún invariante suma aún los originales de la cartera. |
| E-12 | media | cerrado (pendiente de commit) | seis tablas pasan a `ladino_service_tenant_ids()` (20261003130000); `pos_carts` la alinea la migración del POS (20261003100000). Invariante «policy de ladino_api con true en tabla con tenant_id» = 0 con su variante rota (pgTAP 101; `pnpm recorrido E`) — ADR-0068 §7 |
| E-13 | media | abierto | — |
| E-14 | media | abierto | — |
| E-15 | media | cerrado (pendiente de commit) | con documentos, el 422 de «Cambiar el RIF» dice el camino: «Corregir RIF» con motivo, el aviso del art. 13.5 de la PA 00071, y para un RIF nuevo «Crear otra empresa», que ahora existe (A-13); el diálogo ya no promete «Sin documentos…» a ciegas (A-10); `pnpm recorrido E` — ADR-0077 §2 |
| E-16 | media | cerrado (c36753e) | /admin/igtf: si ya es especial dice «Eres sujeto pasivo especial y no estás percibiendo IGTF»; si no, manda a declararlo con sus fechas |
| E-17 | media | cerrado (c36753e) | ADR-0071 |
| E-18 | media | cerrado (c36753e) | catálogo del art. 18.1 por literal (fuente secundaria); el escenario reclasifica la cesta básica como exenta (`corregir-escenario-post.sql`); atún y sardinas no (P-52) |
| E-19 | baja | abierto | — |
| E-20 | baja | abierto | — |
| E-21 | baja | abierto | — |
| E-22 | baja | abierto | — |
| E-23 | baja | abierto | — |
| E-24 | baja | cerrado (c36753e) | «(E)» en el 13.8 y adquirente en el 13.7 en EMISION_FACTURAS, en el comentario del PDF y en la descripción OpenAPI del PDF |
| F-01 | crítica | cerrado (pendiente de commit) | hecho en la ola 2 (abona a la tasa de la factura, sin diferencial; P-30). Comprobado con la familia de moneda: e2e-moneda-diferencial carga el comprobante en una factura en USD con la tasa cambiada, sin diferencial, y el cobro que cierra deja la CxC en cero. Si la retención es el abono que cierra, su céntimo va a «Diferencias por redondeo» (plantilla ar.retention_applied) |
| F-02 | alta | cerrado (pendiente de commit) | cada cobro guarda lo que saldó en la moneda del documento (`payments.settled_transaction_amount`, 20261003170000), congelado al cobrar; la función de saldo (familia «moneda B», 20261003180000) lo lee y da 0 a un documento pagado. `pnpm recorrido F` mete una tasa tardía y la factura sigue sin deber. Los cobros anteriores al corte no se rellenan (append-only) |
| F-03 | alta | cerrado (pendiente de commit) | ADR-0076: el cobro de documentos estrena llave tras un 4xx; IDEMPOTENCY_BODY_MISMATCH; el aviso pinta `person_message`, no el texto técnico (`comunes.tsx`) |
| F-04 | alta | cerrado (pendiente de commit) | ADR-0075 §5, migración 20261003180000: una sola función (`platform.document_debt`; `customer_debt_today` y `ar_aging` salen de ella). Lista, «Debe hoy», estado de cuenta, antigüedad y «Lo que me deben» dan la misma cifra; un documento pagado debe 0,00; el WhatsApp dice USD y Bs con la tasa y la fecha; «Saldo restante» es la deuda. Decidido por criterio: el `balance` de la respuesta del cobro sigue siendo el saldo funcional (alternativa: cambiar el contrato). E2E e2e-moneda-deuda-reversa, pgTAP 110; la comprobación con datos de `pnpm recorrido F` necesita las tasas del escenario. **Revisión (20261003210000):** sin tasa de hoy la deuda no lanza (nominal servido, equivalente en `null`; decidido por criterio: `null` y no suma parcial); un cobro reversado no cuenta en `has_payments`, lo pagado, el diferencial ni para anular (decidido por criterio; alternativa: que reversar no habilite anular); `paid → issued` solo si debe ahora; un comprobante ya declarado no se anula (409; P-89). |
| F-05 | alta | cerrado (ddc34e8) | la ficha muestra el total a pagar con IGTF del servidor (`/v1/pos/tender`) y registra lo entregado con `igtf_included` (10 USD = 9,71 + 0,29; la cuenta sube 10); `absorb_igtf` por empresa (gasto 5.1.05, no suma a la caja, se entera igual). E2E `e2e-igtf-especial`, pgTAP 098, `pnpm recorrido F`. VALIDAR-CONTABLE P-64 |
| F-06 | alta | abierto | — |
| F-07 | alta | abierto | — |
| F-08 | alta | cerrado (pendiente de commit) | ADR-0076: la devolución (crear, confirmar, reembolso) estrena llave tras un 4xx, así «confirmar el sobregiro» viaja con la suya |
| F-09 | media | cerrado (c36753e) | tras cargar, la lista salta al mes del comprobante |
| F-10 | media | abierto | — |
| F-11 | media | cerrado (c36753e) | `ar.retention.register` (quien cobra) y `ar.retention.correct` (contador); la reversa queda en R-61 |
| F-12 | media | abierto | — |
| F-13 | media | abierto | — |
| F-14 | baja | cerrado (pendiente de commit) | `Cuentas.tsx` en modo recibos: «Te deben», «Cuánto tiempo llevan debiendo», «Pagado»; decidido por criterio: «Abonada» → «Pagado en parte», alternativa «Pagado» a secas; `pnpm recorrido F` |
| F-15 | baja | cerrado (pendiente de commit) | el cobro que cierra cancela de cuentas por cobrar exactamente lo que el mayor todavía le carga al documento (`platform.settlement_ledger_open`) y la diferencia va al diferencial. Invariante nuevo `settled_ledger_gaps` (documento saldado ⇒ sin residuo en CxC/CxP), con corte; los −0,01 anteriores al corte quedan para el contador (P-84) |
| F-16 | baja | abierto | — |
| F-17 | baja | abierto | — |
| G-01 | crítica | cerrado (c36753e) | ADR-0071 · decidido por criterio: «contingencia…» solo por su camino, alternativa: columna explícita; anular solo sin emitir, alternativa: solo anular y registrar |
| G-02 | alta | cerrado (c36753e) | la NC y la ND imprimen «Factura que corrige: N° … · Control 00-… · del dd/mm/aaaa · por Bs. …» (arts. 23-24; FC-23, FC-24) |
| G-03 | alta | cerrado (c36753e) | ver A-06: título «RECIBO DE DEVOLUCIÓN», sin RIF inventado, sin IVA, sin cita a la PA 00071, pie propio; `?copia=1` → 422 |
| G-04 | alta | abierto | — |
| G-05 | alta | abierto | NO se hizo en la familia «moneda A» (ola 3): anclar el saldo a favor en USD cambia tres caminos a la vez —aplicarlo (a qué tasa baja el pasivo), reembolsarlo (hoy sale de una cuenta en la moneda del saldo a tasa 1, y su plantilla no tiene diferencial) y revaluarlo al cierre (familia «moneda B»)— y `customer_credits` no guarda tasa. Queda con su diseño en la nota de aplicación de ADR-0075 |
| G-06 | alta | cerrado (ddc34e8) | la devolución deja el IGTF percibido; la NC no lo lleva; el saldo a favor lo excluye; la confirmación devuelve el aviso «el IGTF de X ya fue enterado al SENIAT y no se devuelve» y la pantalla lo muestra; la anulación sigue enviando a reintegro. `pnpm recorrido G`. VALIDAR-TRIBUTARIO P-31 (devolución total del mismo día) |
| G-07 | alta | abierto | — |
| G-08 | alta | cerrado (6ceea89) | ADR-0068 |
| G-09 | media | cerrado (c36753e) | porcentaje por alícuota (parte 1), «Descripción del ajuste: crédito | débito de Bs. X sobre la factura N° …» y «Motivo: …» (el guardado en la nota; el de la devolución para la NC de devolución, probado; «—» si no hay, probado) |
| G-10 | media | abierto | — |
| G-11 | media | cerrado (c36753e) | la NC y la ND imprimen «Tasa BCV de la factura N° … del dd/mm/aaaa: Bs …» (FC-26); cierra P-20 y P-21 en lo que toca a las notas |
| G-12 | media | cerrado (pendiente de commit) | el cobro que cierra guarda como saldado exactamente lo que faltaba en la moneda del documento (sin el resto de ~1e-5 de la conversión a 8 decimales), y un documento pagado no debe (función de deuda, «moneda B»). `pnpm recorrido G`: saldo en USD 0 y deuda de hoy 0 |
| G-13 | media | abierto | — |
| G-14 | media | abierto | — |
| G-15 | media | abierto | — |
| G-16 | media | cerrado (c36753e) | ADR-0071 |
| G-17 | baja | abierto | — |
| G-18 | baja | abierto | — |
| G-19 | baja | abierto | — |
| G-20 | baja | abierto | — |
| G-21 | baja | abierto | — |
| H-01 | crítica | cerrado (ddc34e8) | migración 20261002110000: la empresa especial en la fecha de la factura retiene SOLA al registrar, por los tres caminos (75 % `iva_compras`, 100 % `iva_compras_total` con `iva_retention_full_reason`), sin regla vigente RETENTION_RULE_MISSING; exclusiones del art. 3 como data (`retention_exclusions`) marcables con motivo auditado (`ap.retention_excluded`); contrato API 0.2.0, OpenAPI regenerado. E2E `e2e-retencion-agente`, pgTAP 094, `pnpm recorrido H`. F-88771 y F-89002 no se regularizan solas: VALIDAR-TRIBUTARIO P-63. Revisión y auditoría fiscal (migraciones 20261002110200 y 110300): pantalla de exclusión/100 % en Compras y «Ya llegó la factura»; agente por el día del registro (P-72); sin IVA no se pregunta nada (art. 3 num. 1); 20 UT en los num. 6 y 7 con `tax_units` (P-71); num. 11-12 no marcables; invariante `retention_voucher_gaps()` |
| H-02 | alta | cerrado (pendiente de commit) | el pago a proveedor debita la CxP por lo que cancela A LA TASA DE LA FACTURA y lleva la diferencia con lo que salió a «Pérdida/Ganancia en diferencial cambiario» (papeles exchange_loss / exchange_gain, 5.1.02 y 4.1.02; plantilla payment_made, migración 20261003170000); el pago que cierra deja la CxP de la factura en cero. Los códigos los confirma el contador (P-83). Los residuos de pagos anteriores (000123, F-88771) NO se regularizan solos (P-84). La NC de proveedor a la tasa de su fecha sigue como SOSPECHA abierta |
| H-03 | alta | abierto | — |
| H-04 | alta | cerrado (ddc34e8) | migraciones 20261002110000 y 20261002110100: `retention_vouchers` emitido al registrar, número AAAAMM + 8 por empresa (PA 000054 art. 16, atribución corregida), identidad congelada, vencimiento de entrega calculado y mostrado, entrega una vez, corrección = versión nueva que anula la anterior, uno por operación o por quincena y proveedor, PDF. P-26 implementada (feriados: VALIDAR-TRIBUTARIO) |
| H-05 | alta | abierto | — |
| H-06 | alta | cerrado (pendiente de commit) | el pedido nace en la moneda de la lista con la que la empresa vende (USD si el precio está en USD; sin listas, USD), la moneda se elige ANTES de las líneas y el campo dice «Precio c/u en USD/Bs.» (HacerPedido.tsx, moneda-del-pedido.ts). La SOSPECHA del servidor (una llegada en otra moneda que la del pedido) no se tocó: sigue abierta. **Revisión «el cobro y el cierre»:** mientras las listas cargan el selector no propone ninguna moneda (antes proponía USD y saltaba solo), y lo que la persona eligió no se cambia (`monedaQueSeEnsena`) |
| H-07 | alta | abierto | — |
| H-08 | media | abierto | — |
| H-09 | media | abierto | — |
| H-10 | media | abierto | — |
| H-11 | media | abierto | — |
| H-12 | media | cerrado (ddc34e8) | migración 20261002110000: `purchases_book_with_vouchers` (libro de compras del generador 1.4.0) trae número, fecha e IVA retenido del comprobante emitido en el período; el de otro período sale en el de su emisión como renglón propio con importes en cero. Aserción de cabeceras ampliada (fiscal-books-cabeceras.test.ts) |
| H-13 | baja | abierto | — |
| H-14 | baja | abierto | — |
| H-15 | media | abierto | — |
| I-01 | alta | cerrado (pendiente de commit) | ADR-0078 · migración 20261003110000: `inventory_moves.exit_reason` con CHECK de lista cerrada (los viejos quedan NULL) y motivo obligatorio en `IssueStockRequest`; la web elige el motivo de una lista · E2E `e2e-salidas-inventario` · pgTAP 102 · `pnpm recorrido I`: I-01 ✓ |
| I-02 | alta | cerrado (pendiente de commit) | las salidas de los tests mandan ahora el motivo (`e2e-inventory:175,186`, `e2e-inventario-en-el-mayor:293`, `e2e-purchases:412`, `e2e-una-venta-por-oficio:280`, `packages/domain/test/inventory.test.ts:95,176`): se cambió la ENTRADA, ninguna aserción; una salida sin motivo da 422 nombrando `reason` · `pnpm recorrido I`: I-02 ✓ |
| I-03 | alta | cerrado (pendiente de commit) | «¿A qué depósito?»: Enter elige y avanza, botón «Seguir», sin «Principal Principal»; `pnpm recorrido I` |
| I-04 | alta | abierto | — |
| I-05 | media | cerrado (pendiente de commit) | ADR-0078 §7: /inventario ya no filtra `only_active`; el inactivo con existencia sigue con la marca «Inactivo · no se vende» y cuenta en «Con existencia»; el formulario de producto avisa al inactivar con existencia («seguirá en el inventario con su existencia; no se vende hasta reactivarlo»). Decidido por criterio (§2.12, revisión): el inactivo no se vende pero su mercancía se mueve — el cambio de `apply_inventory_move` es de la familia del céntimo (20261003140000); E2E `e2e-salidas-inventario` «inactivo = no se vende» (venta rechazada; salida por vencido entra) · `pnpm recorrido I`: I-05 ✓ |
| I-06 | media | cerrado (pendiente de commit) | el kardex pide `warehouse_id` de la fila, el título dice el depósito (y el lote) y los tipos se leen «Traslado (entra/sale)» · `pnpm recorrido I`: I-06 ✓ |
| I-07 | media | cerrado (pendiente de commit) | verbo «Conteo»: `POST /v1/inventory/counts` (inventory.adjust) calcula contado − sistema bajo el bloqueo, `preview` la enseña sin escribir y la confirmación la registra como ajuste con motivo · E2E `e2e-salidas-inventario` «conteo» · `pnpm recorrido I`: I-07 ✓ · re-revisión B1 (20261003110200): el conteo que da faltante exige `evidence` al registrar (422 sin ella; la vista previa y el sobrante no la piden) y la pantalla la pide; B4: solo el 409 `CONFLICT` recalcula la diferencia. Decidido por criterio (alternativa: no exigirla y preguntar al asesor) |
| I-08 | media | cerrado (pendiente de commit) | tres verbos con permiso propio: traslado (`inventory.transfer`, sin valor), conteo y ajuste (`inventory.adjust`), salida con motivo (`inventory.move`). Decidido por criterio: quitar verbos al rol del almacenista es separación de funciones (ADR-0068, `cuatro_ojos`), de la familia de permisos |
| I-09 | media | cerrado (pendiente de commit) | los diálogos de movimiento marcan el campo que el servidor rechazó (`details[].path`) y la confirmación se cierra en vez de repetir el aviso detrás |
| I-10 | baja | cerrado (pendiente de commit) | el aviso concuerda con el artículo: «Ajuste registrado», «Conteo registrado», «Salida registrada» |
| I-11 | baja | cerrado (pendiente de commit) | merma, rotura, vencido y faltante → 5.1.08 «Pérdidas por mermas y faltantes de inventario» con el motivo en el asiento; consumo propio, regalo, donación y muestra → retiro (5.1.09) con débito fiscal al precio de la lista principal y Nota de retiro numerada que entra al libro de ventas y a la declaración; sin RIF, solo salida y gasto. Invariantes en 0 (`inventory_ledger_gap`, `inventory_coverage_gaps`, `stock_reconciliation`, `book_ledger_reconciliation`). VALIDAR P-75, P-76, P-77 · `pnpm recorrido I`: I-11 ✓ · re-revisión B1 (20261003110200): en la base, ningún hecho `stock.counted` (asiento o cola) nace para un movimiento que baja existencia sin `exit_evidence`, desde el corte de `invariant_cutoffs` (pgTAP 103b con variante rota); B2: `withdrawal_note_gaps` sigue invoker como toda su familia (ejercida como authenticated); B3: cada hecho publica el nombre de su hecho contable (`stock.counted`, `stock.shrinkage`, `stock.withdrawn`), en EVENT_CATALOG y en el registro del pgTAP 026 |
| I-12 | baja | cerrado (pendiente de commit) | `low_stock_products` suma todas las posiciones (con lote) y excluye lo no activo · E2E y pgTAP 102 · `pnpm recorrido I`: I-12 ✓ |
| J-01 | crítica | cerrado (6ceea89) | ADR-0070 · migraciones 20260928110000 y 20260928110100 · reparación `scripts/reparar/adr-0070-subcuentas.mjs` · `pnpm recorrido J`: J-01 ✓. Aserciones cambiadas por RESPUESTA §5.2.4: 056 (tres) y `e2e-cuenta-de-caja.test.ts` (`:224`, variante rota) — codificaban el mapeo a la familia que ADR-0070 sustituye |
| J-02 | alta | abierto | — |
| J-03 | alta | cerrado (pendiente de commit) | el cierre solo acepta cajas; con solo cash.close, otra cuenta es 404 y quien la ve recibe «Solo se cierran cajas», ninguno con el saldo (E2E; `pnpm recorrido J`). Aserción cambiada: e2e-cuenta-de-caja «CIERRE» cerraba el banco gracias al defecto, ahora cierra la caja USD. Terreno de G-20/H-14/D-11 decidido por criterio: tres permisos solo del Dueño, `four_eyes` automático POR PERMISO (más de una persona que puede aprobar eso; revisión H4, 130200), el aviso de sobregiro sin saldo para quien no tiene treasury.read (H6), umbral USD 1.000 (alternativas en la nota) — ADR-0068 §8 |
| J-04 | media | cerrado (pendiente de commit) | ADR-0075 §6, migración 20261003180000: invariante `platform.treasury_currency_gaps` (saldo de cada caja en su moneda = Σ originales de su subcuenta), en `invariantes.sql` y pgTAP 110 con sus variantes rotas; lo anterior lo lleva al mayor `scripts/reparar/adr-0075-divisa-del-mayor.mjs` (post-pull). La deuda con proveedores a la tasa de registro frente a 2.1.01 la cubre la revaluación al cierre, no un invariante propio (decidido por criterio; alternativa: invariante CxP ↔ mayor). /dinero dice bajo cada cifra que lo que está en dólares va «a la tasa BCV de hoy». `pnpm recorrido J`. **Revisión (20261003210000):** el invariante dice qué pasa con la cola (caja = subcuenta + lo que espera en la cola; cero sin perdones); la regularización nace `exchange_diff` / `treasury.currency_regularized` (decidido por criterio; alternativa: un `source_kind` nuevo) y el script da una línea por empresa y exit ≠ 0 si alguna queda saltada o sin tasa. |
| J-05 | baja | abierto | — |
| K-01 | crítica | cerrado (6ceea89) | migración 20260928130000, pgTAP 079, E2E periods-have-history, recorrido K |
| K-02 | alta | cerrado (6ceea89) | migración 20260928130000, pgTAP 079, E2E periods-have-history, recorrido K |
| K-03 | alta | cerrado (6ceea89) | migración 20260928130000, pgTAP 079, E2E periods-have-history, recorrido K |
| K-04 | alta | cerrado (6ceea89) | migraciones 20260928130000 (suelo), 20260928130100 (libro sobre 20260928120000) y 20260928130200 (planilla sobre 20260928120300); enrutado de factura, NC, landed cost, recepción, pago y gasto; marca en Libros y aviso en Compras; E2E accounting-hooks «K-04»; ventana LIVA art. 33 sin aplicar (P-35) |
| K-05 | media | cerrado (6ceea89) | migración 20260928130000, pgTAP 079, E2E periods-have-history, recorrido K |
| K-06 | media | cerrado (6ceea89) | migración 20260928130000, pgTAP 079, E2E periods-have-history, recorrido K |
| K-07 | alta | abierto | — |
| K-08 | media | cerrado (pendiente de commit) | migraciones 20261003140000 (oráculo y libro de compras al céntimo, cuenta 5.1.10, cent_gaps, regularización) + 140100 (escala del libro) + 140200 (revoke); estados servidos al céntimo; reparación adr-0075-centimo.mjs en los post-pull; pgTAP 105. Declaraciones guardadas NO se reescriben (append-only, P-80). Decidido por criterio: residuo de entrada sobre negativo sigue en el valor (ADR-0075 nota §7). **Revisión de la ola 3** (migraciones 20261003190000 y 190100; pgTAP 108 y 107): el libro por alícuota de la 140100 perdía el signo de la NC, el ajuste y la anulada (corregido, 081d en verde sin tocar sus aserciones); la declaración convierte sus créditos al céntimo como el libro (AF3-09); la empresa sin RIF no tiene renglones en el libro de compras (AF3-13). Decidido por criterio (alternativas en ADR-0075 nota §7): la reversa de un asiento con fracción va al céntimo con su línea de redondeo y `cent_gaps` pierde la salvedad; la posición vacía solo va entera a redondeo si es polvo (≤ 0,005 × movimientos), lo demás queda visible y se lista; la empresa sin contabilidad regulariza su kardex y encola; el asiento manual con más de dos decimales es 422 y LAD71 al postear. pgTAP 019 llevado al céntimo (aserciones aceptadas). Revisión en contexto limpio (migraciones 20261003190200 a 190400; pgTAP 108, 111, 112 y 113): la excepción de LAD71 es un registro privado, no una etiqueta que la API podía escribir; la fila de cola de la empresa sin contabilidad nace descartada con acta y no bloquea el cierre (decidido por criterio; `inventory_coverage_gaps` acepta «descartada con acta»); el cierre de ejercicio se arma al céntimo; el costo de la factura contra la recepción se redondea una sola vez |
| K-09 | media | cerrado (pendiente de commit) | la rama «te invitaron»: quien abre `#invitacion=<token>` (el token va en el fragmento; `?invitacion=` se sigue leyendo en la transición; también tras registrarse y confirmar el correo en otra pestaña) ve «Te invitaron a <empresa>» con su oficio y quién invita, y acepta; el registro sin invitación dice «¿Vienes a trabajar en el negocio de otra persona? … pídele el enlace»; `pnpm recorrido K` — ADR-0077 §3 |
| K-10 | media | abierto | — |
| K-11 | media | cerrado (6ceea89) | ADR-0068 |
| K-12 | baja | abierto | — |
| K-13 | baja | abierto | — |
| K-14 | baja | abierto | — |
| K-15 | baja | abierto | — |
| L-01 | crítica | cerrado (6ceea89) | migración 20260928120000: NC en negativo en libro, pantalla y CSV; pgTAP 074 y 078 |
| L-02 | alta | cerrado (6ceea89) | conciliación en el gate: pgTAP 074 sin todo, invariante 12 del recorrido, fila en CLAUDE.md §3; 046:170 ya no aplica el signo |
| L-03 | alta | cerrado (ddc34e8) | `aTxtRetencionesIva` con los 16 campos de P-7 en su orden, leídos del comprobante (RIF sin guiones, AAAAMM, AAAA-MM-DD, tipo 01/02/03, comprobante de 14), sin versiones anuladas; fixture aprobado `packages/domain/test/fixtures/txt-retenciones-iva-p7.txt`. Aserciones cambiadas con autorización (declarations.test.ts:36-45). VALIDAR-SENIAT: 2 decimales y documentos con varias alícuotas (P-7). Revisión y auditoría fiscal: un documento con varias alícuotas da 422 con su lista (P-69); la corrección de un comprobante ya declarado no se declara otra vez y se avisa (P-65); fixture con `-text` en .gitattributes |
| L-04 | alta | cerrado (ddc34e8) | migración 20261002120000: el especial declara por quincena y el ordinario por mes (422 legible con sus dos quincenas, o con su mes); `platform.fiscal_fortnight` y `platform.iva_period_proposal`; `GET /v1/fiscal-declarations/iva-periods/proposal` y la pantalla arranca en esa propuesta (adiós `mesLocalAnterior`). E2E `e2e-declaracion-quincenal`. Revisión (migración 20261002120100): el ordinario declara el mes calendario completo (H5; la entrada de e2e-fiscal-declarations y e2e-ajuste-creditos-anteriores pasa a meses, mismas cifras) y la propuesta evalúa el tipo al cierre del candidato (H3) |
| L-05 | alta | cerrado (ddc34e8) | migración 20261002120000: dos arrastres (`excedente_siguiente` = solo crédito fiscal; `retenciones_acumuladas_por_descontar` aparte, con su entrada `retenciones_acumuladas_anteriores`) en el cálculo, la fila, el hash (generador 1.1.0), la API y la pantalla; una fila 1.0.0 con excedente o retenciones no se encadena. P-3 cerrada, P-37 al asesor. Aserción cambiada: e2e-fiscal-declarations:346 y :357 (240 → 0, pasaban gracias a la cifra mezclada) |
| L-06 | media | cerrado (6ceea89) | discrepancias y coverage_gaps en la conciliación (campos opcionales), con enlaces; concepto en palabras |
| L-07 | media | cerrado (6ceea89) | anulada con número e importes en cero en libro y CSV (P-34) |
| L-08 | media | cerrado (c36753e) | libro de ventas por alícuota (`sales_book_by_rate`, con `iva_sin_clasificar`) y resumen del art. 72 (`summary`, y en el hash del exportado); generador 1.3.0. Decidido por criterio: el resumen se descarga como `resumen-art72.csv` de la misma generación y el CSV del libro sigue siendo cabecera + renglones (alternativa: bloque al final del mismo CSV, que exigiría cambiar la aserción de e2e-fiscal-books) |
| L-09 | media | cerrado (ddc34e8) | migración 20261002120000: PA SNAT/2025/000091 sembrada en `tax_calendar_entries` (970 fechas con norma, gaceta y fuente; 496 pendientes de cotejo y no ofrecidas — la tabla 1.2 entera desde 20261002120100, H1, con P-10 reabierta; desde 20261002120200 las 970, por la duda del terminal del RIF, H11 de la auditoría fiscal, P-10.2), vencimiento por terminal del RIF (`platform.tax_due_date`), `GET /v1/fiscal-declarations/calendar` y su tarjeta en Vencimientos; pgTAP 097. ADR-0052 enmendado. VALIDAR-SENIAT: cotejo con la G.O. 43.283; retenciones de ISLR sin fuente textual, no sembradas |
| L-10 | media | abierto | — |
| L-11 | baja | cerrado (c36753e) | la pantalla de libros, el adaptador `csv_columnas_legales` (migración 20260928180200) y R-22 citan el Reglamento de la LIVA arts. 70 a 78 (REGULATORY_STATUS); el CSV sigue siendo NO oficial |
| L-12 | baja | cerrado (c36753e) | «Retenciones que practicamos (a proveedores)» y «Retenciones que nos practicaron (clientes)» |
| L-13 | baja | abierto | — |
| L-14 | baja | abierto | — |
| L-15 | baja | cerrado (ddc34e8) | `GET /v1/igtf/status` da la quincena en curso y su vencimiento desde `platform.tax_due_date` (null si está pendiente de cotejo, nunca inventado); `quincenaLocal` sale de la web. `pnpm recorrido L` |
| M-01 | crítica | cerrado (pendiente de commit) | ADR-0076, migración 20261003100000: la venta marca la cuenta vendida (lápida), el PUT posterior da 409 POS_CART_SOLD, la llave es por intento y la caja espera la subida antes de cobrar; E2E + `pnpm recorrido M` |
| M-02 | alta | cerrado (pendiente de commit) | ADR-0076: el cobro lleva `attempt_id` y `cart_version` (nunca bytes iguales); otra llave sobre la cuenta vendida da 409 POS_CART_SOLD con la venta vieja en `details`, sin documento nuevo |
| M-03 | media | cerrado (pendiente de commit) | ADR-0076: el sincronizador no reencola una cuenta olvidada ni la que la nube dice cobrada; el trigger impide editar o borrar la lápida; unit `pos-cuentas-vendida.test.ts` |
| M-04 | media | cerrado (pendiente de commit) | ADR-0076, decidido por criterio: la llave ya no es fija, y la cuenta cobrada dice «ya se cobró … ábrele una cuenta nueva» y la caja la suelta |
| M-05 | alta | cerrado (c36753e) | una sola función `formatearDocumento` (packages/schemas/src/rif.ts) para la web y el PDF: el RIF V/E de 9 dígitos sale `V-12345678-9`, nunca agrupado como cédula. Decidido por criterio: un V/E de 9 dígitos es RIF, nunca cédula; la cédula se sigue mostrando `V-12.345.678` |
| M-06 | alta | abierto | — |
| M-07 | media | abierto | — |
| M-08 | baja | abierto | — |
| M-09 | media | abierto | — |
| M-10 | media | abierto | — |
| M-11 | media | abierto | — |
| M-12 | media | abierto | — |
| M-13 | baja | abierto | — |
| N-01 | crítica | cerrado (6ceea89) | ADR-0068 |
| N-02 | alta | cerrado (6ceea89) | ADR-0068 |
| N-03 | alta | cerrado (pendiente de commit) | sin empresas visibles y con membresía (desactivada o sin rol), la web pide `GET /v1/me/access` y enseña «Tu acceso a esta empresa ya no está activo» con «<negocio>: habla con <Titular>, que administra el negocio», nunca «monta tu negocio» (`platform.my_lost_access`, migración 20261003120000); E2E y `pnpm recorrido N` — ADR-0077 §3 |
| N-04 | alta | cerrado (6ceea89) | ADR-0068 · e2e-una-venta-por-oficio (el asiento se lee de la base) · `pnpm recorrido N` en verde |
| N-05 | media | abierto | — |
| N-06 | media | cerrado (pendiente de commit) | el middleware de alcance responde `ACCESS_REVOKED` a quien TUVO acceso (migración 20261003120100 lo acota: un miembro de otra empresa del tenant sigue recibiendo el 404 idéntico de `scope.test.ts`) y la pestaña entera enseña «Tu acceso a esta empresa ya no está activo. Habla con quien administra el negocio.»; E2E y `pnpm recorrido N` — ADR-0077 §3. Decidido por criterio: viaja con 404 como el NOT_FOUND al que sustituye (alternativa: 403) |
| N-07 | media | cerrado (pendiente de commit) | membresías, asignaciones y alcances se leen por la base con membership.read (el `members.read` del dueño, sin renombrar) o si son propios; quien lee una sola empresa ve solo las membresías con asignación en ella (revisión H5, 130200); usuario de dos tenants y dos empresas en un tenant y variante rota en pgTAP 101; `pnpm recorrido N` — ADR-0068 §7 |
| N-08 | media | cerrado (pendiente de commit) | invitación por enlace: `member_invitations` (huella sha256, un solo uso, vence a los 7 días, correo opcional, ancla, RLS, auditada) y `POST /v1/invitations`, `/preview`, `/accept`; «Crear enlace de invitación» en Agregar persona (hoy no hay proveedor de correo: el enlace se copia); pgTAP 100 con usuario de dos tenants y variante rota, E2E y `pnpm recorrido N` — ADR-0077 §3, R-69. Decidido por criterio: 7 días (alternativa: 48 h); reactivar a un desactivado solo si invita quien gobierna la cuenta (alternativa: la guarda de addMember). Abierto: listar y anular invitaciones pendientes |
| N-09 | baja | abierto | — |
| N-10 | baja | cerrado (pendiente de commit) | `member.role_revoked` lleva el id de la MEMBRESÍA (y el de la asignación en el payload); reactivar desde «Agregar persona» escribe `member.reactivated` (E2E; `pnpm recorrido N`) |
| N-11 | baja | abierto | — |
| O-01 | alta | cerrado (pendiente de commit) | la empresa de la pestaña vive en `sessionStorage` y sobrevive al F5; el disco solo da el punto de partida a una pestaña nueva (`apps/web/src/app/empresa-pestana.ts`, unitario «dos pestañas no se pisan»); `X-Company-Id` sale del estado de la pestaña; `pnpm recorrido O` (lógica, no pantalla) — ADR-0077 §1 |
| O-02 | media | cerrado (pendiente de commit) | ADR-0076: `vendor_id` = quien cobra; quién armó queda en la cuenta vendida (`created_by` + `sale_id`) y en el acta `pos.cart.sold`, y el detalle de la venta dice «Armó la cuenta» (decidido por criterio, sin columna en `documents`) |
| O-03 | media | cerrado (pendiente de commit) | las cinco tablas reciben `set_row_provenance` (y `version` las tres que no la tenían); invariante «tabla con created_by sin procedencia» = 0 con variante rota (pgTAP 101; `pnpm recorrido O`). Las filas viejas sin autor se quedan así: no se inventa el autor — ADR-0068 §7 |
| O-04 | baja | cerrado (c36753e) | «Elige la empresa» y «Cambiar de empresa» usan `rifParaMostrar`, que delega en el formateador compartido: RIF con guiones |
| O-05 | media | abierto | — |
| O-06 | baja | abierto | — |
| O-07 | baja | abierto | — |
| P-01 | alta | cerrado (pendiente de commit) | «Lo que gané» y gastos servidos con round(…, 2) (negocio.ts) sobre un mayor al céntimo (migración 20261003140000, regularización al corte); invariante cent_gaps. Revisión de la ola 3: el E2E siembra la fracción como dato heredado (ya no entra por la API: 422 / LAD71, migración 20261003190000) y la cifra esperada no cambió |
| P-02 | media | cerrado (c36753e) | todos los caminos guardan el documento normalizado; la búsqueda de clientes (y Ctrl+K) compara normalizado; reparación de datos `scripts/reparar/p-02-rif-normalizado.mjs` (función de la migración 20260928170000: idempotente, acta por fila, falla ante duplicados) que corre tras el pull; el CSV de los libros imprime el RIF formateado (generador `fiscal-books/1.2.0`); snapshots emitidos intactos. Revisión 2026-09-28 (criterio §2.16): **decidido por criterio** que el libro de ventas lee el RIF y el nombre del adquirente del snapshot del documento y el de compras del snapshot de la factura (`supplier_invoices.supplier_*_snapshot`, sin backfill), con la proyección del hash sobre el RIF normalizado (migración 20260928170100; alternativa: seguir leyendo el maestro vivo); índices únicos normalizados en proveedores y empresas (alternativa: solo el caso de uso); la búsqueda de proveedores también compara normalizado; la reparación lista además lo que normaliza a vacío. **Aserciones existentes cambiadas** (autorizadas: pasaban gracias a P-02, porque esperaban lo tecleado, y la regla del dueño manda guardar normalizado): (1) `apps/api/test/e2e-customers.test.ts:244-246`, antes `tax_id_anterior: J-E2E-${RUN}` y `tax_id_nuevo: J-NEW-${RUN}`, después `J1${D7}1` y `J2${D7}2`: el acta guarda lo normalizado; (2) `apps/api/test/e2e-company-profile.test.ts:157`, antes `J-88${RUN.slice(0, 6)}-2`, después `J88${D6}2`, por lo mismo; (3) `apps/api/test/e2e-company-profile.test.ts:221`, antes `J-99${RUN.slice(0, 6)}-3`, después `J99${D6}3`, por lo mismo; (4) `packages/domain/test/customers.test.ts:199`, antes `J-${RUN}-NEW`, después `rifDePrueba(7)`; (5) `:204`, antes `J-${RUN}-SEG`, después `rifDePrueba(6)`; (6) `:205`, antes `J-${RUN}-NEW`, después `rifDePrueba(7)`. En (4) a (6), el RIF de base36 ya no es un RIF (422) y el valor esperado es el mismo que se envía, que ya es la forma normalizada |
| P-03 | media | cerrado (pendiente de commit) | gasto, transferencia y pago a proveedor en divisa al céntimo en origen (toCents); generador al céntimo con residuo a «Diferencias por redondeo», no al diferencial; migración 20261003140000. Revisión de la ola 3: el E2E ya no sobregira la caja (la fondea antes, D-11); el kardex guarda la política que produjo el importe (`ledger:cents:2:HALF_UP`) y redondea una sola vez, decidido por criterio (ADR-0075 nota §7) |
| P-04 | media | cerrado (pendiente de commit) | `GET /v1/customers?with_debt=1` exige ar.read: el cajero la recibe, el almacenista 403 en palabras de persona; la web pide la deuda solo con ar.read (E2E; `pnpm recorrido P`) — ADR-0068 §7 |
| P-05 | media | abierto | — |
| P-06 | media | abierto | — |
| P-07 | media | abierto | — |
| P-08 | baja | abierto | — |
| P-09 | baja | abierto | — |
| P-10 | baja | cerrado (pendiente de commit) | migración 20261003110000 (ADR-0078 §8): «por agotarse» cuenta la existencia de todos los lotes y excluye los inactivos, en /inventario y en Inicio (la misma función) · E2E `e2e-salidas-inventario`, pgTAP 102 · `pnpm recorrido P`: P-10 ✓ |
