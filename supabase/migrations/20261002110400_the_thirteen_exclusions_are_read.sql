-- =============================================================================
-- Ladino — LAS TRECE EXCLUSIONES DEL ART. 3, LEÍDAS
-- (ADR-0072 §3; auditoría fiscal de la 2.ª ronda de la parte 3, lectura de los 13 numerales)
--
-- Módulo: compras · retenciones. Rigor máximo (fiscal).
-- Spec:   docs/02_COMPLIANCE/REGULATORY_STATUS.md (PA SNAT/2025/000054 art. 3) · RETENTIONS_SPEC.md.
-- Fuente: el auditor fiscal leyó los 13 numerales en ivecofi (reproducción no oficial), 2026-10-02.
--         Cotejo con la G.O. 43.171 y el art. 146 del COT: VALIDAR-TRIBUTARIO (PENDIENTES_ASESOR).
-- Reversible: SÍ, con datos vivos — ver al final.
-- HOMOLOGATION_IMPACT: YES — el texto y el numeral de cada exclusión que la persona marca.
--
-- Qué cambia:
--   1. `retention_exclusions` gana `source` (de dónde salió la lectura de cada fila).
--   2. Las 13 filas con su numeral exacto, `numeral_verified = true` y la fuente. La fila
--      `ente_publico` pasa a ser solo el num. 11 (órganos de la República, estados o municipios) y
--      nace `ente_publico_sin_fines_empresariales` para el num. 12. Las dos se refieren al COMPRADOR:
--      `not_markable`, una empresa privada no las marca. Ninguna factura referencia `ente_publico`
--      (nunca fue marcable desde la 20261002110300), así que partirla no deja huérfanos.
--   3. Las descripciones del 3 (los bienes), del 9 (las dos condiciones) y del 10 («en el ejercicio
--      fiscal anterior») dicen lo que la norma dice. El tope de 20 UT del 6 y el 7 no cambia.
-- =============================================================================

alter table public.retention_exclusions add column source text;
comment on column public.retention_exclusions.source is
  'De dónde sale la lectura de la fila (fuente y fecha). La norma va en legal_norm/legal_article.';

insert into public.retention_exclusions
  (code, legal_norm, legal_article, gazette, numeral_verified, applies, description, effective_from)
values
  ('ente_publico_sin_fines_empresariales', 'PA SNAT/2025/000054', 'art. 3 num. 12',
   'G.O. 43.171, 16-07-2025', true, 'not_markable', 'pendiente', '2025-08-01');

update public.retention_exclusions x
   set legal_article = v.articulo, description = v.descripcion, numeral_verified = true,
       source = 'ivecofi, reproducción no oficial, 2026-10-02 (auditor fiscal)'
  from (values
    ('exentas_exoneradas_no_sujetas', 'art. 3 num. 1',
     'Operación no sujeta, exenta o exonerada.'),
    ('proveedor_formal', 'art. 3 num. 2', 'El proveedor es contribuyente formal.'),
    ('percepcion_previa', 'art. 3 num. 3',
     'Proveedor agente de percepción del IVA que vende bebidas alcohólicas, fósforos, cigarrillos, tabaco u otros derivados del tabaco.'),
    ('retencion_previa_importacion', 'art. 3 num. 4',
     'Proveedor que ya pasó por la percepción anticipada del IVA al importar los bienes.'),
    ('viaticos', 'art. 3 num. 5',
     'Compras pagadas por empleados del agente con dinero entregado como viáticos.'),
    ('gastos_reembolsables_20ut', 'art. 3 num. 6',
     'Gastos reembolsables pagados por directores, gerentes, administradores u otros empleados por cuenta del agente, hasta 20 UT por operación.'),
    ('caja_chica_20ut', 'art. 3 num. 7',
     'Compras de bienes muebles o servicios pagadas con la caja chica, hasta 20 UT por operación.'),
    ('servicio_publico_domiciliado', 'art. 3 num. 8',
     'Electricidad, agua, aseo y telefonía pagados por domiciliación en las cuentas bancarias del agente.'),
    ('exportador_recuperacion', 'art. 3 num. 9',
     'Proveedor inscrito en el Registro Nacional de Exportadores que ADEMÁS pidió recuperar créditos fiscales por exportación en los últimos 6 meses (las dos condiciones).'),
    ('proveedor_mayoria_exenta', 'art. 3 num. 10',
     'Más del 50 % de las ventas o servicios del proveedor fueron exentos o exonerados en el ejercicio fiscal anterior.'),
    ('ente_publico', 'art. 3 num. 11',
     'Compra hecha por un órgano de la República, de un estado o de un municipio calificado y notificado como sujeto pasivo especial (se refiere al COMPRADOR: una empresa privada no la marca).'),
    ('ente_publico_sin_fines_empresariales', 'art. 3 num. 12',
     'Compra hecha por un ente público sin fines empresariales creado por la República, calificado y notificado como sujeto pasivo especial (se refiere al COMPRADOR: una empresa privada no la marca).'),
    ('art_146_cot', 'art. 3 num. 13',
     'La operación y el IVA se pagan bajo la excepción del art. 146 del COT (el art. 146: VALIDAR-TRIBUTARIO).')
  ) as v(code, articulo, descripcion)
 where x.code = v.code;

update public.retention_exclusions set applies = 'not_markable' where code = 'ente_publico';

do $$
begin
  if (select count(*) from public.retention_exclusions
       where numeral_verified and source is not null) <> 13 then
    raise exception 'esperaba las 13 exclusiones del art. 3 leídas, con numeral y fuente';
  end if;
  if (select count(distinct legal_article) from public.retention_exclusions) <> 13 then
    raise exception 'esperaba 13 numerales distintos en retention_exclusions';
  end if;
  if exists (select 1 from public.retention_exclusions
              where code in ('ente_publico', 'ente_publico_sin_fines_empresariales')
                and applies <> 'not_markable') then
    raise exception 'los num. 11 y 12 se refieren al comprador: no se marcan';
  end if;
end $$;

-- =============================================================================
-- Reversibilidad (con datos vivos): SÍ. Las descripciones y numerales vuelven con UPDATE (catálogo
-- de plataforma; las facturas guardan el código, no el texto). `ente_publico_sin_fines_empresariales`
-- se borra si ninguna factura la referencia (no es marcable, así que ninguna puede). `source` se
-- retira con drop column.
-- =============================================================================
