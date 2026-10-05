# Arquitectura de información

Reescrito el 2026-10-03 (ola 4 de la respuesta al recorrido del 2026-09-24, §5.1 punto 2). Dice lo
que la webapp **hace hoy** y lo que el dueño **decidió**; no promete nada que no exista. La fuente
es el código: `apps/web/src/app/nav.ts`, `shell.tsx`, `modulos-activos.ts`, `empresa-pestana.ts`,
`session.tsx` y `router.tsx`. Las líneas citadas son las del 2026-10-03; si se mueven, manda el
símbolo nombrado.

La lista anterior de este documento (Inicio, Ventas, Compras, Inventario, Finanzas, Contabilidad,
Impuestos, Nómina, Reportes, Configuración, Auditoría) era el plan de antes de construir. **Nómina,
Finanzas, Impuestos y Auditoría no existen como entradas de menú** y no se prometen aquí.

## 1. Regla

**El menú se filtra por permisos, y es cortesía: quien autoriza es el servidor, en cada endpoint.**
Esconder una entrada no es control de acceso (`nav.ts:38-43`, CLAUDE.md §2). Lo que el rol no puede
ver se dice como «no tienes acceso», nunca como «no hay» (N-05, N-07, P-04).

## 2. El menú por oficio: arriba se vende y se consulta, abajo se administra

Dos grupos, y lo que los separa es la **posición**, no solo el permiso (regla del dueño):

### Arriba, sin nombre: el mostrador (`NAV_NEGOCIO`, `nav.ts:78-84`)

| Entrada | Ruta | Se abre con |
|---|---|---|
| Inicio | `/inicio` | `treasury.read` |
| Vender | `/vender` | `sales.invoice.issue` |
| Productos | `/productos` | `sales.invoice.issue` |
| Inventario | `/inventario` | `sales.invoice.issue` |
| Clientes | `/clientes` | `sales.invoice.issue` |

Habla el idioma de quien atiende. Su vocabulario lo vigila un gate (`apps/web/src/i18n/glosario.ts`,
`apps/web/test/glosario.test.ts`, `glosario-capa-fiscal.test.ts`), que recorre `pages/negocio/**` y
`pages/registro/**`.

**«Empezar»** (`NAV_EMPEZAR`, `nav.ts:87-92`, `/empezar`) se antepone a este grupo mientras la puesta
a punto del primer día esté pendiente (`useEmpezarPendiente`, `shell.tsx:147`), y solo para quien
tiene `fiscal.regime.manage`. La guardia de ruta la incluye (`shell.tsx:204-221`): teclear la
dirección sin el permiso lleva a la ruta inicial del rol.

### Abajo, plegable: ADMINISTRACIÓN (`NAV_ADMIN`, `nav.ts:95-229`)

Aparece si el rol abre al menos una de sus entradas (`shell.tsx:195`). Cuatro grupos:

| Grupo | Entradas (ruta) |
|---|---|
| Operación | Ventas (`/admin/ventas`) · Cuentas por cobrar (`/admin/cuentas`) · Clientes (`/admin/clientes`) · Llegó mercancía (`/admin/llego-mercancia`) · Compras y gastos (`/compras`) · Mi dinero (`/dinero`) |
| Catálogo e inventario | Productos (`/admin/productos`) · Listas de precios (`/admin/precios`) · Inventario (`/admin/inventario`) |
| Contable y fiscal | Compras (`/admin/compras`) · Contabilidad (`/admin/contabilidad`) · Libros fiscales (`/admin/libros`) · Declarar IVA (`/admin/declaraciones`) · IGTF (`/admin/igtf`) · Facturación fiscal (`/admin/facturacion-fiscal`) |
| Sistema | Reportes (`/admin/reportes`) · Configuración (`/admin/configuracion`) |

- **«Compras y gastos» y «Mi dinero» están en ADMINISTRACIÓN por posición**, aunque sus rutas
  (`/compras`, `/dinero`) no cuelguen de `/admin`: son tareas de quien administra, no del mostrador.
- **«Llegó mercancía» es la única puerta de entrada de mercancía** (ADR-0066). No depende de que el
  módulo de compras esté activo ni de que la empresa tenga RIF (`nav.ts:117-125`).
- Las migas (`Migas`, `shell.tsx`) solo se pintan dentro de `/admin`.

## 3. Tres filtros, en este orden (`visible`, `shell.tsx:182-192`)

1. **El rol.** Cada entrada declara `permiso` (uno, o una lista en la que basta cualquiera). Sin el
   permiso, la entrada no existe para esa persona.
2. **La empresa: la capa fiscal.** Libros fiscales, Declarar IVA, IGTF y Facturación fiscal llevan
   `fiscal: true` y **no existen para una empresa sin RIF**, tenga la persona el rol que tenga
   (`capaFiscalVisible`, `nav.ts:60-62`). Con RIF se factura; sin RIF se dan recibos.
3. **Los módulos con datos (A-04).** Compras, Contabilidad, Libros fiscales, Declarar IVA e IGTF
   llevan `advanced` y aparecen cuando hay con qué (`sondearModulosActivos`,
   `modulos-activos.ts:30`):
   - **Compras:** hay al menos un proveedor;
   - **Contabilidad:** hay al menos un asiento **posteado**, o la persona es **contadora**;
   - **Libros (y Declarar IVA e IGTF):** hay al menos una **factura**, o la persona es contadora.

   Decisión del dueño (RESPUESTA §3, A-04): «Contabilidad y Libros aparecen cuando hay datos o
   cuando el rol es contador». Cada módulo con su dato: decidido por criterio (la alternativa era
   que cualquiera de los dos datos encendiera los dos). Configuración permite además pedir verlos
   todos, por empresa (`CLAVE_TODOS`, `shell.tsx:54`); eso activa módulos, no abre lo que el rol
   cierra.

## 4. A dónde llega cada oficio (`rutaInicial`, `nav.ts:236-249`)

| Quien tiene | Llega a |
|---|---|
| `treasury.read` (dueño, administrativo) | `/inicio` |
| `sales.invoice.issue` (cajero, encargado) | `/vender` |
| `accounting.entry.create` (contador) | `/admin/contabilidad` |
| `report.export` | `/admin/reportes` |
| nada de lo anterior | la primera entrada que su rol abre (el almacenista, «Llegó mercancía») |
| ninguna entrada | `/sin-acceso` |

Fuera del menú, la sesión decide antes (`session.tsx`): quien abre un enlace de invitación ve «Te
invitaron a <empresa>»; quien perdió el rol o fue desactivado ve «Tu acceso a esta empresa ya no
está activo», con el nombre de quien administra; nunca «monta tu negocio» (RESPUESTA §2.11; N-03,
N-06, N-08).

## 5. La empresa

- **Una empresa por pestaña (O-01, ADR-0077 §1).** La empresa activa vive en el `sessionStorage` de
  la pestaña y sobrevive a la recarga; el disco solo guarda la última elegida, como punto de partida
  de una pestaña nueva (`empresa-pestana.ts`). Cada petición manda `X-Company-Id` desde la pestaña y
  el servidor lo verifica.
- **«Elige la empresa»** (`session.tsx`) es la pantalla de elegir cuando la pestaña no tiene empresa
  resuelta; la última elegida se recuerda como punto de partida.
- **El selector de la cabecera** (`CompanySwitcher`, `shell.tsx`) cambia de empresa y, para quien
  tiene `company.manage`, ofrece **«Crear otra empresa»**: nace en un tenant propio, dentro de la
  misma cuenta de la persona, que queda como Dueño de la nueva (A-13, ADR-0077 §2).
- **Cómo se distingue una de otra (O-05, O-04).** El selector, la cabecera y «Elige la empresa»
  enseñan la **insignia** de la empresa (`components/InsigniaEmpresa.tsx`): su logo si lo tiene y,
  si no, la inicial sobre un color **derivado** de su id (`app/empresa-color.ts`; no se guarda, y
  nadie lo elige). Debajo del nombre va el RIF con guiones.

  Pendiente y ya decidido por el dueño, no hecho aquí: que el selector enseñe el nombre comercial y
  debajo la razón social, igual en el botón y en la lista (O-06, ola 6). Hoy el botón usa el nombre
  comercial y la lista la razón social.

## 6. Buscar (Ctrl+K)

La paleta (`palette.tsx`; qué ofrece lo decide `paleta-acciones.ts`, sin React) hace cuatro cosas
(P-06, ADR-0081):

- **Pantallas**: las entradas del menú, con el mismo filtro del menú —permiso, módulo activo y
  modo de venta—. Se encuentran también sin tildes («llego mercancia»).
- **Acciones** que viven dentro de una pantalla: «Nuevo cliente» (`customer.manage`; abre el
  diálogo en `/clientes?accion=nuevo` o `/admin/clientes?accion=nuevo`) y «Cerrar caja»
  (`cash.close`; `/dinero?accion=cerrar-caja`, que abre el cierre si hay una sola caja). Una
  acción existe si el rol tiene el permiso del acto **y** abre la pantalla donde se hace.
- **Clientes y productos**, con la búsqueda del servidor.
- **Documentos por su número**: factura, recibo, notas, cotización y compra, con
  `GET /v1/search/documents`. El servidor devuelve solo lo que el rol puede leer en la empresa de
  la pestaña. Una venta abre su detalle (`/admin/ventas/:id`); una compra lleva a la lista de
  facturas de proveedores. Lo que el rol no puede abrir no se pinta.

Teclado: flechas, Enter, Escape. No anuncia nada que no exista: el pie del «Asistente de Ladino»
se quitó (ADR-0081).

## 7. Caminos que cruzan el menú

- **«Te deben…» → la lista de deudores ordenada por deuda VENCIDA (P-05).** El recordatorio del
  Inicio y «Ver quién me debe» de Mi dinero llevan a `/admin/clientes?orden=vencido`: la lista de
  clientes con lo vencido primero, el orden en la URL y el estado de cuenta de cada cliente a un
  clic. La columna «Vencido» y la cabecera «Deuda» (`?orden=deuda`, la deuda total) alternan cada
  una su orden. El orden y las cifras son del servidor y exigen `ar.read`. Vencido es la deuda de
  los documentos cuyo vencimiento —el que la caja pregunta al fiar («¿Cuándo paga?») o, sin él,
  el día de la emisión— es anterior a hoy.
- **Sin RIF → con RIF.** La banda de la caja, Configuración → Mi empresa y `/empezar` son las tres
  paradas de quien saca su RIF. La respuesta decidió que el alta con RIF siga directo al talonario
  (RESPUESTA §3, A-02); su estado está en el informe del recorrido, no se afirma aquí.

## 8. Propuestas sin decidir

Vienen de la edición que el estratega hizo a este documento durante el recorrido sin que se le
pidiera (copia en `.recorrido/2026-09-24/ediciones-no-pedidas/`, fuera de git). **Nada de esta
sección está decidido por el dueño ni construido.**

1. **Una vista agregada de quién debe, por antigüedad.** `/admin/cuentas` sin `?cliente=` solo dice
   «Elige un cliente». P-05 resolvió «a quién cobro primero» con la lista ordenada por deuda; una
   vista de toda la cartera por tramos de antigüedad sigue sin existir.

   **P-05 cerrado (2026-10-04, 71c73ab).** La regla que faltaba existe: una venta
   fiada lleva su fecha de vencimiento, acordada al vender y congelada en el documento (migración
   `20261004210000`), y la lista ordena por lo vencido (§7). Decidido por criterio (RESPUESTA
   §2.16); las alternativas descartadas están en la fila P-05 del bloque «Estado» del informe del
   recorrido y en ADR-0075, nota «el vencimiento». Lo que sigue sin existir es la vista de toda
   la cartera por tramos: `/admin/cuentas` enseña «Vencido» por cliente, no un agregado.
2. **El vocabulario de `/admin/cuentas` para una empresa sin RIF.** «Antigüedad de saldos» y
   «Abonada» se enseñan igual a una bodega que da recibos. Está en `/admin`, fuera del alcance del
   glosario del mostrador: la pregunta es si quien lleva una bodega debe entrar a ese vocabulario.
3. **Que `/empezar` recuerde en qué paso se quedó la persona** y que la banda «Con tu RIF puedes
   facturar» lleve al paso que falta y no al primero. No verificado si las olas 1 a 3 lo cambiaron.
4. **Que la caja diga que cambió de modo** cuando la empresa pasa de recibos a facturas (hoy la
   banda desaparece sin dejar nada en su lugar). No verificado tras las olas 1 a 3.

El resto de aquella edición eran **hallazgos**, no arquitectura: tienen su ID y su estado en
`docs/00_GOVERNANCE/AUDITORIAS/recorrido-2026-09-24.md` (bloques B, D, F y M) y no se repiten aquí.
