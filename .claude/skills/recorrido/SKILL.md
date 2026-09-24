---
name: recorrido
description: Recorre Ladino entero, de la A a la Z, como lo usarían personas reales — pantalla por pantalla, con Playwright, cuatro empresas y seis roles — y documenta cada diferencia entre lo que la pantalla PROMETE y lo que HACE. Úsala antes de cada salida a producción o cuando el dueño pida probar el producto de punta a punta. No arregla nada.
---

# /recorrido

Se construyó módulo por módulo, cada uno con sus tests en verde. Lo que nunca se hizo es USARLO de
punta a punta. Las veces que se miraron dos pantallas juntas aparecieron problemas que ningún test
veía — tres puertas para meter mercancía, un «Anular» que prometía reponer inventario y no lo
hacía, un Inicio en cero para quien vendía con recibos. Todos terminaban en verde.

**No se arregla nada, ni lo más obvio. No se cambia ningún test.** Se encuentra, se prueba que
existe y se documenta. Arreglar viene después, con `/arreglar` y el informe en la mano.

## 1 · El escenario

**Dónde:** el entorno LOCAL completo — web en 5174, API en 3000, Supabase local — con la base
limpia al empezar (`npx supabase db reset --local`). Nada del recorrido toca el remoto.

**Cuatro empresas, creadas POR LA INTERFAZ** (registro premium), para que el registro quede probado:
- **E1 · «Bodega La Esquina»** — sin RIF, vende con recibos, un depósito, rubro bodega, con logo.
- **E2 · «Distribuidora Andina, C.A.»** — con RIF, contribuyente ordinario, formas libres, DOS
  depósitos, vende al mayor.
- **E3 · «Ferretería El Tornillo, C.A.»** — con RIF, contribuyente especial: retenciones, IGTF,
  declaración quincenal.
- **E4** — E1 cuando saca su RIF y pasa a facturar (bloque M).

**Seis usuarios, uno por rol**, cada uno con su sesión: dueño, cajero, encargado de tienda,
administrativo, contador, almacenista. El dueño pertenece a E2 y E3.

**Datos:** al menos 15 productos por empresa (con y sin foto, con y sin código de barras, uno con
receta, uno con lote y vencimiento, uno por kilo, un servicio), 8 clientes (V, E, J, G, P), 4
proveedores (con y sin RIF). Tasa del día con fuente «prueba local» si no se alcanza la real.

**El paso del tiempo** (aging 30/60/90, dos meses de declaración, cierre de período, facturas por
llegar de más de 30 días) se produce con fechas relativas vía API, igual que los tests. Lo que no se
pueda producir desde la interfaz se crea por API **y se anota cuál y por qué**.

Lo que una spec o un ADR describe y aún no está construido se anota como **«no construida»**, no
como error.

## 2 · Las doce dimensiones de cada pantalla

Antes de usar una pantalla, se lee qué PROMETE: su texto, botones, ayudas y confirmaciones; su spec
en `docs/03_MODULES/` (con `spec-explorer`); el ADR que la gobierna; el glosario. Después:

| # | Dimensión | La pregunta |
|---|---|---|
| 1 | PROMESA | ¿Hace lo que dicen su texto, su botón y su confirmación? Un texto que describe una consecuencia que no ocurre es ALTO |
| 2 | DATOS | Lo que muestra, ¿coincide con la base? Se consulta la base tras cada acción, cifra a cifra |
| 3 | DINERO | Dual Bs/USD con la tasa correcta; 2 decimales; nunca «Bs.S»; mismo total en carrito, documento, PDF, asiento y libro |
| 4 | CONTABILIDAD | Asiento generado o en cola con motivo visible; invariantes en cero |
| 5 | ROLES | La misma pantalla con los seis roles: qué ve de más, qué le falta, qué botón aparece y luego falla |
| 6 | MODO | La misma pantalla en E1 (recibos) y en E2 (facturas): en E1, cero rastro fiscal |
| 7 | ESTADOS | Vacío, cargando, error, sin tasa, sin datos, sin permiso: ¿cada uno con su pantalla y su salida? |
| 8 | TEXTO | Glosario, tuteo, errores en lenguaje de persona; nunca un código técnico visible |
| 9 | TECLADO | Flujo completo sin ratón donde aplique |
| 10 | FORMA | Escritorio, tablet 1024px, móvil 390px, modo oscuro |
| 11 | DOCUMENTOS | PDF de factura, recibo y copia: contenido verificado TEXTO A TEXTO |
| 12 | TIEMPO | Cuánto tarda cada acción. Más de 3 segundos es hallazgo |

## 3 · Los bloques, de la A a la Z

A registro y empresa · B primer día (`/empezar`) · C productos y precios · D llegada de mercancía ·
E vender · F cobros y deudas · G corregir una venta · H compras y gastos · I inventario · J mi
dinero · K contabilidad (con el contador) · L libros y declaraciones · M de recibos a facturas
(E1 → E4) · N usuarios y roles · O varias empresas · P inicio, reportes y búsqueda · Z cierre.

El detalle de cada bloque está en la versión vigente del encargo del recorrido; si no hay una,
cubre todo lo que el menú de cada rol ofrece.

## 4 · Cómo se reparte el trabajo en cada bloque

1. **La sesión principal conduce** con Playwright (receta: memoria `qa-playwright-local`), y guarda
   por cada pantalla: captura, texto visible, peticiones de red con error, consola, y el estado de
   la base antes y después de cada acción.
2. **En paralelo, máximo 3 a la vez**, sobre esa evidencia:
   - `estratega-producto` → PROMESA, TEXTO, ESTADOS, TECLADO, FORMA;
   - `auditor-codigo` → DATOS, DINERO, CONTABILIDAD, ROLES, TIEMPO;
   - `auditor-fiscal` → solo en A, B, E, G, H, L y M: MODO y DOCUMENTOS.
3. `spec-explorer` cuando haga falta saber qué promete una spec.
4. **`validador` al cerrar cada bloque**, sobre todas las empresas tocadas.
5. `escritor-tests`, `reparador`, `revisor` y `migration-author` **no se usan** en un recorrido.
6. **Suplentes.** Si el runtime no cargó los agentes del equipo al abrir la sesión, cada papel lo hace
   un `general-purpose` que lee su definición y abre su informe con `ROL: <agente>`. La sesión
   principal **crea** la marca `.recorrido/.suplentes-solo-lectura` al empezar el recorrido —con
   ella, `guard-agentes.sh` trata a esos suplentes como de solo lectura y `subagent-stop.sh` les
   exige la línea ROL— y la **borra** al cerrar el bloque Z. Si se queda puesta, un `/arreglar`
   posterior con suplentes no puede escribir.

## 5 · Cómo se registra — para que nada se pierda

Es una sesión muy larga, y se corta:

- **Al cerrar cada bloque**, sus hallazgos se escriben en
  `docs/00_GOVERNANCE/AUDITORIAS/recorrido-<AAAA-MM-DD>.md` **ANTES** de empezar el siguiente.
- Primera línea del documento: `Bloques cerrados: A, B, C… · Siguiente: D`. Si la sesión se corta o
  el contexto se compacta, se retoma desde ahí.
- Capturas de cada hallazgo en `docs/08_UX/capturas-recorrido/<bloque>/`.
- Cada hallazgo:

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

## 6 · El informe final

1. Resumen ejecutivo en media página: cuántos hallazgos, cuántos críticos, los cinco que más afectan
   a una persona real.
2. **PRIMERO los que terminan en verde**: la persona no se entera y los datos quedan mal.
3. Matriz pantalla × doce dimensiones, en verde, ámbar o rojo.
4. Todos los hallazgos, deduplicados, por severidad, separados en «arreglable sin decisión» y
   «necesita decisión».
5. Promesas rotas: cada texto de pantalla que describe algo que no ocurre.
6. Tiempos: las acciones más lentas, con su número.
7. Lo que no se pudo probar y por qué; lo creado por API y no por interfaz; lo no construido.
8. Qué agente encontró qué, y dónde se solaparon.
9. Propuesta de orden para `/arreglar`.

## Reglas

- Ante la duda de si algo es error o diseño: se anota como hallazgo **con la pregunta**, y decide el
  dueño.
- Si una pantalla falla tanto que no se puede seguir el bloque, se anota y se pasa al siguiente.
- Al final solo se hace push del documento de hallazgos y las capturas, con el validador en verde.
