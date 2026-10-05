-- =============================================================================
-- Ladino — 20261005100600 · LA FICHA DEL ADQUIRENTE DE UN RETIRO NO ES UN CLIENTE MÁS
--
-- Módulo: clientes · ventas (rigor normal: maestro, tabla con datos, cambio aditivo)
-- Spec: ADR-0082 (segunda ronda, punto 4)
-- HOMOLOGATION_IMPACT: NO — no toca documentos ni libros. Lo que la factura de retiro imprime
--   sale de su congelado, no de esta ficha.
--
-- EL DEFECTO. La factura de retiro referencia una ficha de cliente (el documento la exige), y
--   20261005100000 dejó que el caso de uso la creara como un cliente cualquiera con el RIF de la
--   propia empresa. Aparecía en el buscador de clientes de la caja y de la factura, en la paleta y
--   en la lista de Clientes, y se le podía vender —y fiar— como a un tercero.
--
-- LA DECISIÓN. Una marca en la ficha, `own_company`: «este adquirente es la propia empresa». A lo
--   sumo una por empresa (índice único). Quien la lleva:
--     · no sale en la lista ni en el buscador de clientes (`GET /v1/customers`, `/lookup`);
--     · no se le vende: `resolverLista`, la puerta de toda venta, la rechaza;
--     · sigue sirviendo de ancla a las facturas de retiro, que es para lo único que existe.
--   Si el negocio YA tenía un cliente con su propio RIF, esa ficha es suya y no se marca: se usa
--   como ancla y sigue siendo un cliente (decidido por criterio: no se le esconde al dueño un
--   cliente que él creó; alternativa: marcarla también).
--
-- COMPATIBILIDAD: aditiva, con `default false`: la API saliente no la escribe ni la lee. Va JUSTO
--   DESPUÉS del `git pull`, tras 20261005100500.
-- REVERSIBILIDAD: reversible (soltar el índice y la columna). Con fichas marcadas, soltarla las
--   devuelve a la lista de clientes; no se pierde ningún documento.
-- =============================================================================

alter table public.customers add column own_company boolean not null default false;
comment on column public.customers.own_company is
  'ADR-0082: la ficha es la de la PROPIA empresa, el adquirente de sus facturas de retiro. No es un cliente: no sale en listas ni buscadores y no se le vende. La crea emitirFacturaDeRetiro; a lo sumo una por empresa.';

create unique index customers_one_own_company_uidx
  on public.customers (company_id) where own_company;
