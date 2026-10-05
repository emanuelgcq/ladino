-- =============================================================================
-- Ladino — 20261005160000 · VERSIÓN DE REGLAS 1.4.0 (la ola 5 entera)
--
-- Módulo: plataforma · fiscal (RIGOR MÁXIMO: es lo que sella cada documento y cada asiento)
-- Spec: ADR-0079 §1 y §8 · ADR-0082 · ADR-0083
-- HOMOLOGATION_IMPACT: YES — no cambia ninguna regla por sí misma: le pone NOMBRE a las que la
--   ola 5 cambió. Todo documento fiscal y todo asiento emitido desde aquí llevan `1.4.0+<hash>`
--   y se distinguen de los emitidos con la lógica anterior.
--
-- Sustituye al borrador 20261005150000, que nunca se aplicó en ninguna base (ni en la local):
--   su nota citaba rangos de migraciones que dejaron de ser exactos, y `platform.rules_releases`
--   es append-only: la nota se corrige antes de existir, no después.
--
-- POR QUÉ. ADR-0079 §1: la versión semántica sube «cuando cambia la lógica de una regla». La ola
--   5 cambia qué documento emite un retiro gravado, qué entra en el libro de ventas y en la
--   declaración, y cómo se trata la nota de crédito de un proveedor; ninguna de sus migraciones
--   subió la versión, y sin esta un retiro facturado quedaría sellado con la misma `1.3.0` que
--   una Nota de retiro de la semana anterior. Lo señaló la revisión en contexto limpio.
--
-- UNA SUBIDA POR VENTANA (ADR-0079 §8): esta es la ÚLTIMA migración de la ola 5 en orden limpio
--   y recoge todas. Entre dos migraciones de la misma ventana no se emite ningún documento, así
--   que ninguna versión intermedia llegaría a congelarse.
--
-- NO ES LA VERSIÓN DEL FORMATO DE LOS LIBROS (AF5-09). `packages/domain/src/fiscal-books.ts`
--   lleva su propio número, `fiscal-books/1.4.0`, que versiona el GENERADOR de los libros
--   (columnas y formato del fichero) y vive en el código. Que coincidan en «1.4.0» es
--   casualidad: son dos series distintas, esta migración no la toca y ninguna lee a la otra.
--
-- EL HASH. Su definición no cambia (la de 20261004205000). Se recalcula al final por el mismo
--   patrón de la 1.3.0, para que `rule_set_drift()` dé cero también si alguna migración de la
--   ventana tocó un dato que entra en él.
--
-- COMPATIBILIDAD: expand. La API saliente lee «la mayor versión registrada»: desde que esta
--   fila existe sella 1.4.0. Va JUSTO DESPUÉS del `git pull`, la ÚLTIMA de la ventana.
-- REVERSIBILIDAD (con datos vivos): NO se retira. `platform.rules_releases` es append-only y, en
--   cuanto un documento se emite con `1.4.0+…`, esa versión está congelada en un documento
--   fiscal. Revertir la lógica es subir OTRA versión, nunca borrar esta.
-- =============================================================================

insert into platform.rules_releases (semver, note) values
  ('1.4.0',
   'Ola 5. ADR-0082 — el retiro GRAVADO de inventario emite una factura de retiro a nombre de la propia empresa, con correlativo y control de las facturas, fechada el día en que se registra y sin cartera; se corrige con su propia nota de crédito, total; ambas entran en el libro de ventas y en la declaración de IVA del período en que se emiten; '
   || 'tres motivos de salida NO gravados (uso en el negocio, activo fijo, construcción o reparación de un inmueble del negocio) asientan por su destino y no emiten documento. '
   || 'ADR-0083 — la nota de crédito de un proveedor mueve el kardex, es fiscal según lo sea su factura (libro de compras) y su IVA lo calcula el servidor. '
   || 'No es la versión del formato de los libros (fiscal-books/1.4.0), que es otra serie.');

update platform.rule_set_state s
   set global_hash = platform.rules_global_hash(), computed_at = now()
 where s.id;
