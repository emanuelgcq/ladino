-- Correcciones del ESCENARIO del recorrido 2026-09-24 que necesitan el esquema NUEVO
-- (solo base local, nunca producción). `pnpm recorrido restaurar` lo corre DESPUÉS de las
-- migraciones posteriores al volcado (scripts/recorrido/correr.mjs). Cada corrección cita su
-- hallazgo.

-- ── E-18 (ADR-0073 §4; RESPUESTA §2.5): la cesta básica del escenario, EXENTA ────────────────
-- E1 y E2 clasificaron los alimentos del art. 18.1 de la LIVA como gravados, y E2 los facturó al
-- 16 %. «El producto del escenario que se facturó con IVA se corrige en el escenario, no en
-- producción.» Se reclasifica el PRODUCTO; las facturas ya emitidas no se tocan (son inmutables y
-- conservan su categoría congelada, ADR-0044).
--
-- Por nombre exacto y con su literal (tax_exemption_literals, fuente secundaria):
--   18.1.c arroz · 18.1.d harina de origen vegetal · 18.1.e pan y pastas · 18.1.g sal ·
--   18.1.h azúcar (no industrial) · 18.1.i café · 18.1.m leche en polvo · 18.1.n queso blanco ·
--   18.1.o margarina · 18.1.q mayonesa · 18.1.u aceites comestibles salvo oliva.
-- NO se reclasifican, porque el literal depende de la presentación y el escenario no la dice:
-- «Atún en lata 170g» (18.1.k exige presentación natural) y «Sardinas en lata» (18.1.l exige lata
-- cilíndrica de hasta 170 g). Tampoco galletas, refresco, salsa de tomate ni limpieza: no están
-- en la lista.
update public.products p
   set tax_category_code = 'exento'
 where p.company_id in ('01a0d547-9c92-7121-9d82-438e2e322415',   -- E1 · Bodega La Esquina
                        '01a0d548-82bb-783e-909e-643fc473d458')   -- E2 · Distribuidora Andina
   and p.tax_category_code <> 'exento'
   and p.name in (
     -- E1
     'Aceite vegetal 1L', 'Arroz blanco 1kg', 'Azúcar 1kg', 'Café molido 250g',
     'Harina de maíz precocida 1kg', 'Leche en polvo 400g', 'Pan canilla', 'Pasta larga 500g',
     'Queso blanco a granel (por kilo)', 'Queso blanco duro 1kg',
     -- E2
     'Aceite de soya 1L (caja x12)', 'Arroz caja x24', 'Azúcar caja x24', 'Café molido caja x12',
     'Harina precocida caja x20', 'Leche en polvo caja x12', 'Margarina caja x24',
     'Mayonesa caja x12', 'Pasta caja x20', 'Sal caja x24');

-- Que la corrección no se quede corta en silencio: la harina de E1 y la de E2 tienen que quedar
-- exentas (si el escenario cambia de nombres, esto falla en vez de «pasar» sin reclasificar nada).
do $$
begin
  if (select count(*) from public.products
       where company_id in ('01a0d547-9c92-7121-9d82-438e2e322415',
                            '01a0d548-82bb-783e-909e-643fc473d458')
         and name in ('Harina de maíz precocida 1kg', 'Harina precocida caja x20')
         and tax_category_code = 'exento') <> 2 then
    raise exception 'E-18: la harina de E1 y la de E2 no quedaron exentas; ¿cambió el escenario?';
  end if;
end $$;

-- ── 8-bis (ADR-0071 §1; RESPUESTA §2.1): los talonarios del escenario, con datos de imprenta ─
-- Con ADR-0071 un talonario sin los datos de la imprenta NO emite (claim_fiscal_control, LAD49),
-- y los talonarios activos de E2 y E3 se cargaron antes de que existieran esas columnas. Esto
-- SIMULA lo que hará el dueño desde la puesta a punto fiscal («Completar los datos de la
-- imprenta», `completarImprenta` en packages/domain/src/talonario.ts): es SOLO LOCAL, sobre el
-- escenario del recorrido, y NO es una transición de producción — en producción los completa el
-- dueño con los datos reales de su imprenta.
--
-- Datos a todas luces ficticios: la imprenta se llama «de prueba del escenario», la providencia
-- lleva la marca ESCENARIO y el RIF J-00000001-8 tiene estructura válida (el dígito cuadra con
-- el módulo 11 de rif.ts) sin ser de nadie. Se guarda normalizado, como lo guardaría la API.
--
-- Es un UPDATE limitado a las columnas que `completarImprenta` escribe, con `coalesce` columna por
-- columna (un dato real no se pisa), sobre talonarios ACTIVOS e INCOMPLETOS que no son de
-- contingencia: el trigger `fiscal_number_ranges_printer_frozen` impide reescribir uno
-- completo, y un talonario completo (la serie B de E3, «Gráficas Lara») no se toca.
--
-- Las facturas A-1…A-7 de E3 salieron de un rango sin papel detrás (E-01). NO se tocan: son
-- emitidas (regla 1).
update public.fiscal_number_ranges
   -- Columna por columna: un dato real que ya estuviera no se pisa, solo se completa lo que falta.
   set printer_legal_name         = coalesce(printer_legal_name, 'Imprenta de prueba del escenario, C.A.'),
       printer_tax_id             = coalesce(printer_tax_id, 'J000000018'),
       printer_authorization      = coalesce(printer_authorization, 'SNAT/ESCENARIO/2026/000001'),
       printer_authorization_date = coalesce(printer_authorization_date, '2020-01-15'),
       printed_on                 = coalesce(printed_on, '2026-09-01')
 where company_id in ('01a0d548-82bb-783e-909e-643fc473d458',   -- E2 · Distribuidora Andina
                      '01a0d549-6587-703a-be13-da740c2750d3')   -- E3 · Tornillo
   and status = 'active'
   and not printer_data_complete
   -- El talonario de CONTINGENCIA (PA 102) no es papel de imprenta de la caja: no se toca.
   and lower(series) not like 'contingencia%';

do $$
begin
  if exists (select 1 from public.fiscal_number_ranges
              where company_id in ('01a0d548-82bb-783e-909e-643fc473d458',
                                   '01a0d549-6587-703a-be13-da740c2750d3')
                and status = 'active' and not printer_data_complete
                and lower(series) not like 'contingencia%') then
    raise exception '8-bis: quedó un talonario activo de E2 o E3 sin los datos de la imprenta';
  end if;
end $$;

-- ── A-03 / B-07 (ADR-0072 §1; RESPUESTA §2.6): el TIPO DE CONTRIBUYENTE que el dueño declarará ──
-- SIMULA LA DECLARACIÓN que el dueño hará en pantalla, solo en la base LOCAL del recorrido. NO es
-- una transición de producción: la migración 20260928190000 deliberadamente no rellena la historia
-- («sin transición», respuesta del dueño del 2026-09-28), y en producción cada empresa declara su
-- tipo antes de su próxima factura.
--   · E2 · Distribuidora Andina: ordinario, desde su inicio de actividades;
--   · E3 · Tornillo: especial, providencia notificada el 2026-09-24, rige desde ese día.
-- E1 no tiene RIF: es no_contribuyente por hecho y no declara nada.
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, notified_on, reason, rules_version)
select c.tenant_id, c.id, v.tipo,
       coalesce(v.desde, c.activity_start_date, '2026-09-24'::date), v.notificado,
       'Recorrido local: simula la declaración del dueño (no es una transición de producción)',
       'recorrido-2026-09-24'
  from (values ('01a0d548-82bb-783e-909e-643fc473d458'::uuid, 'ordinario', null::date, null::date),
               ('01a0d549-6587-703a-be13-da740c2750d3'::uuid, 'especial', '2026-09-24'::date,
                '2026-09-24'::date)) as v(company_id, tipo, desde, notificado)
  join public.companies c on c.id = v.company_id
 where not exists (select 1 from public.company_taxpayer_types h where h.company_id = c.id);

do $$
begin
  if platform.taxpayer_type_at('01a0d548-82bb-783e-909e-643fc473d458', '2026-09-24') is distinct from 'ordinario'
     or platform.taxpayer_type_at('01a0d549-6587-703a-be13-da740c2750d3', '2026-09-24') is distinct from 'especial' then
    raise exception 'A-03: E2 no quedó ordinario o E3 no quedó especial desde el 2026-09-24';
  end if;
end $$;
