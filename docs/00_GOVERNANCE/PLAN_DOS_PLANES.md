# Plan — Ladino en dos planes: Simple (sin RIF) y Fiscal (con RIF)

- **Estado**: propuesta para aprobación del dueño (2026-09-12). **No hay código.**
- **Fuentes**: 44 sitios de ERP (19 globales, 15 LatAm, 10 venezolanos), 14 competidores
  que se venden en Venezuela, y el mapa del código de Ladino al 2026-09-12. Los tres
  informes completos están en la sesión (`investigacion-erp-30-sitios.md`,
  `investigacion-competencia-venezuela.md`, `mapa-planes-ladino.md`).
- **Regla del encargo**: primero el plan, luego el código. Cero redundancia, cero
  incoherencia entre régimen fiscal, modo recibos, roles y plan.

## 1. Por qué ahora

1. **La homologación de software ya no existe.** PA SNAT/2024/000121 fue derogada por la
   PA SNAT/2026/00084 (G.O. 43.435, 12/08/2026) sin norma sustituta. Lo que gobierna la
   emisión es PA 00071 (forma libre + imprenta autorizada), PA 102 (imprenta digital) y
   PA 0141 (máquina fiscal). Un mes después, Gálac, Saint, a2, Stellar, Profit y Hybrid
   siguen vendiendo el sello «homologado»; solo Valery cita la 0071.
2. **El mercado venezolano está partido en dos y nadie cruza.** Los cloud (Fina $35+IVA,
   Clarito $10–15, IUNCI gratis) no tienen factura fiscal, libros ni contabilidad; Fina
   lo dice literalmente («no es un ERP»). Los rigurosos (Gálac $366–1.502/año, Saint $330
   por módulo, a2 licencia perpetua) son escritorio con licencia anual y precio oculto.
   El único cloud fiscal barato es Cachicamo ($15/$25/$50), sin contabilidad propia.
3. **Ladino ya tiene construidos los dos productos.** El modo recibos (migración 37, ADR-0050)
   es el plan Simple; la emisión, libros, IVA, IGTF y retenciones son el plan Fiscal. El
   gate técnico entre ambos existe: `fiscal_regimes.allowed_kinds` aplicado en el trigger de
   emisión. Lo que falta es comercial y de experiencia: la noción de plan, el menú que no
   enseñe al sin-RIF cuatro pantallas fiscales vacías, y los textos.

**Hueco exacto que ocupa Ladino**: el mismo negocio, en la misma cuenta, con el interruptor
fiscal apagado el día uno y encendido el día que llega el RIF, con contabilidad de partida
doble y dos monedas debajo desde el primer recibo. Nadie lo ofrece.

## 2. Los dos planes

| | **Ladino Simple** | **Ladino Fiscal** |
|---|---|---|
| Para quién | Negocio sin RIF (o con RIF que factura por fuera y no necesita libros) | Contribuyente ordinario o especial que emite y declara |
| Régimen que lo acompaña | `sin_facturacion` (recibos) o `sin_emision` | `formatos_libres` hoy; `per_document` (imprenta digital PA 102) cuando se construya |
| Vende con | Recibos serie R, «documento no fiscal», sin IVA | Facturas con número de control, NC/ND, devoluciones |
| Incluye | POS con varias cuentas, productos, precios en dos monedas, inventario y kardex valorado, clientes y deudas, cobros, cuentas y cierre de caja, gastos, tasa BCV automática, **contabilidad de partida doble**, balance y estado de resultados, usuarios ilimitados, multi-empresa, auditoría | Todo lo de Simple + emisión fiscal, rangos de imprenta, libros de compra/venta/retenciones, declaración demostrativa de IVA, IGTF, retenciones y comprobantes, facturas de proveedor con crédito fiscal, contingencia, exportación de libros con hash |
| No incluye | Nada fiscal: ni libros, ni IVA, ni IGTF, ni facturas de proveedor (sí compras simples y gastos) | Imprenta digital (peaje externo: HKA $15–25/mes, CG $49/100) y máquina fiscal, que Ladino no imprime |
| Precio de referencia | **$24 + IVA al mes** (entre Clarito $10–15 y Fina $35; usuarios ilimitados como Fina) | **$49 + IVA al mes** (sobre Cachicamo $25/$50 sin contabilidad; muy por debajo de Gálac PYME mensualizado ≈ $70–125) |
| Escalón adicional | Ninguno por usuario. Se cobra por **caja/sucursal adicional** (patrón Holded/Bsale/Shopify), no por usuario | Ídem |
| Prueba | 30 días gratis | 30 días gratis, también al **pasar** de Simple a Fiscal |

Decisiones de nombre y precio, con el porqué:

- **«Simple» y «Fiscal»** están libres; «Emprendedor» y «Pyme» los usan Gálac, Cachicamo y
  Alegra. El titular comercial: *«Empieza Simple. Cambia a Fiscal el día que llegue tu RIF,
  sin migrar nada.»*
- **Usuarios ilimitados en ambos**: dueño + cajero + contador sin fricción (Fina, Bsale,
  Vendus). El mercado sí acepta pagar por local o caja extra.
- **Precio público en USD + IVA con equivalencia BCV del día**: los rigurosos ocultan el
  precio o lo dan «según tasa por WhatsApp»; publicarlo es un diferenciador.
- **Nada fiscal se cobra por documento** (Vendus, Bsale, Xubio lo incluyen; México lo
  cobra por folio y las reseñas lo castigan). El peaje de la imprenta digital es externo
  y se dice antes de contratar.
- **Rol contador gratis** con tablero multi-empresa (Zoho, QBO, Alegra, Xubio, Siigo
  Contador): el contador es el canal de adquisición en Venezuela.

## 3. Principio de coherencia: tres ejes, cada uno con una sola verdad

| Eje | Pregunta que responde | Dónde vive | Quién lo cambia |
|---|---|---|---|
| **Régimen fiscal** (ADR-0029) | ¿Qué documentos puede EMITIR esta empresa y cómo se numeran? | `company_fiscal_regimes` → `fiscal_regimes.allowed_kinds`, trigger `assert_document_issuance` | El dueño, declarando su situación legal en Empezar (acta en auditoría, R-27) |
| **Rol** (ADR-0048) | ¿Qué puede hacer ESTA persona? | `permissions`/`roles`, `ladino_user_permissions()` | El dueño, asignando roles |
| **Plan** (nuevo) | ¿Qué módulos tiene CONTRATADOS esta empresa y qué se le enseña? | `plans` + `company_plans` (append-only por vigencia), `platform.plan_at()` | El dueño al contratar; el operador de plataforma (ADR-0030) |

Reglas que evitan la doble verdad:

1. **El plan es un eje comercial de visibilidad y contratación. El régimen conserva la
   última palabra sobre la emisión, en el esquema.** El plan nunca se mete en
   `fiscal_regimes` (que exige `legal_source`, LAD52) ni reutiliza `regime_code`.
2. **El plan no quita permisos.** El rol `owner` cubre el catálogo entero por invariante
   (pgTAP 040). El plan es ortogonal al RBAC: se comprueba en `companyScope()` junto a
   `companyStatus`, y en la web como tercer filtro de `NavItem` (permiso, `advanced`, plan).
3. **Estados imposibles, prohibidos por construcción**:
   - *Plan Simple + régimen que emite facturas*: al declarar RIF y elegir un régimen que
     emite, la API exige plan Fiscal (o arranca su prueba de 30 días en el mismo acto).
     Nunca se deja una empresa que puede emitir por API y no lo ve en el menú.
   - *Plan Fiscal + régimen `sin_facturacion`*: permitido (paga por adelantado, aún sin
     RIF); la puesta a punto fiscal le enseña el paso pendiente. No es incoherente, es
     una empresa en transición.
4. **El plan no incentiva mentir sobre el RIF** (R-27): activar facturación siempre es
   posible en el momento — con prueba gratis de Fiscal — y el recibo lleva su aviso
   «documento no fiscal». La deuda comercial nunca es excusa técnica para no emitir.
   **VALIDAR-LEGAL** con el asesor: que un no inscrito venda con recibos es su
   responsabilidad; Ladino se lo dice en Empezar y en cada recibo.
5. **Una sola definición de «modo recibos»**. Hoy se calcula seis veces con dos fórmulas
   distintas. Pasa a una función de dominio (`modoDeVenta(regime)` → `recibos | facturas |
   ninguno`) y a un solo campo en `GET /v1/fiscal/setup`; la web deja de deducirlo.
6. **Degradar de Fiscal a Simple no borra nada** (ADR-0006): facturas, rangos, libros
   generados y percepciones quedan; se enseñan en modo lectura bajo «Historial fiscal». Lo
   emitido nunca desaparece.

## 4. Lo que hay que cerrar ANTES de vender Simple como «completo»

Del mapa del código salen cuatro huecos reales del plan Simple; sin ellos, «ERP completo»
sería exagerar:

| # | Hueco | Hoy | Decisión propuesta |
|---|---|---|---|
| S1 | **Corregir un recibo** | No hay NC/ND ni devolución para recibos (ADR-0051 §4 lo dejó fuera); la devolución cae en 409 | **Recibo de devolución** (kind `receipt` con `source_document_id` y signo negativo) o **anulación de recibo** con motivo. Repone inventario, revierte el asiento `sales_receipt`, no toca numeración fiscal. Es un ADR nuevo (dinero + stock) |
| S2 | **Compra simple** bloqueada | `POST /v1/purchases/simple` da 422 porque `taxpayer_type_code` es nulo y no hay pantalla que lo asigne | En Simple la compra es **costo total** (sin crédito fiscal): la compra simple deja de exigir clasificación cuando el régimen no emite; el IVA pagado va al costo. Documentar en la spec de compras; sin default en la columna (la migración 22 argumenta contra él) |
| S3 | **Menú fiscal vacío** | El sin-RIF ve Facturación fiscal, Libros, Declarar IVA e IGTF vacíos, y puede activar IGTF y cargar rangos sin régimen | Filtrar por plan + régimen en `nav.ts` y paleta; en la API, `PLAN_REQUIRED` (403 con `person_message`) en rutas fiscales; IGTF y rangos exigen régimen que emite |
| S4 | **Textos** | No existe ninguna frase que explique por qué algo fiscal no aplica | Una pantalla «Esto es del plan Fiscal» (molde: `/sin-acceso`) con el botón «Ya tengo RIF: activar facturación» y el precio |

## 5. Diseño técnico (para ejecutar tras el «sí»; ningún archivo se toca antes)

**ADR-0059 — El plan es un eje comercial, ortogonal al régimen y al rol.** Rigor máximo
(toca contrato de la API, aislamiento y visibilidad). HOMOLOGATION_IMPACT: NO (no cambia qué
se emite ni cómo; el régimen sigue mandando).

Migración 53 (expand, reversible con `drop`):

- `plans(code pk, name, description, monthly_price_usd numeric(24,8), includes_fiscal bool,
  status, legal_source null)` — catálogo global, sembrado con `simple` y `fiscal`.
- `company_plans(id, tenant_id, company_id, plan_code, effective_from, effective_to,
  source ('trial'|'paid'|'operator'), created_by, created_at, version)` — append-only por
  vigencia con `EXCLUDE` sin solape (mismo patrón que `company_fiscal_regimes`), ancla
  inmutable (test 006), RLS por tenant.
- `platform.plan_at(company, fecha)` — espejo de `regime_at`. Sin fila: `simple`.
- **Backfill**: toda empresa existente con régimen que emite (`formatos_libres`,
  `sin_emision` con libros usados) → `fiscal` desde `-infinity`, `source='operator'`; el
  resto → `simple`. La empresa «Ladino» de producción queda en Fiscal.
- Función `platform.modo_de_venta(company, fecha)` → `recibos|facturas|ninguno`, la única
  definición.

Dominio y API:

- `CompanyScope` gana `plan` y `modoDeVenta`; `exigePlan(scope, "fiscal")` devuelve
  `PLAN_REQUIRED` (403) con `person_message` «Esto es del plan Fiscal. Actívalo desde
  Empezar cuando tengas tu RIF»; se aplica en: rangos, contingencia, libros, declaraciones,
  IGTF, retenciones, facturas de proveedor, NC/ND, `POST /v1/fiscal/regime` hacia un
  régimen que emite (que a su vez ofrece la prueba).
- `POST /v1/fiscal/regime` a `formatos_libres` **crea la prueba de 30 días de Fiscal** si
  la empresa está en Simple (una transacción, acta en auditoría).
- `GET /v1/fiscal/setup` expone `plan`, `plan_trial_ends_on`, `sales_mode`.
- `GET/POST /v1/plans`, `POST /v1/companies/plan` (contratar/cambiar; el cobro real es
  externo por ahora: el operador registra el pago) — **VALIDAR-NEGOCIO**: pasarela de
  pago (Cashea/pago móvil/USDT) queda para otro plan.
- OpenAPI regenerado; `person_message` en `ERROR_CATALOG.md`.

Web:

- `NavItem.plan?: "fiscal"`; `visible()` filtra por permiso, `advanced` y plan; la paleta
  igual. Sin-RIF: desaparecen Facturación fiscal, Libros, Declarar IVA, IGTF; aparece un
  bloque «Cuando tengas tu RIF» en Inicio y en Mi empresa con el precio.
- Empezar paso 4 y Mi empresa dicen el plan y la prueba; el POS mantiene la banda
  «Estás vendiendo con recibos».
- «Historial fiscal» en modo lectura para empresas degradadas.

Tests: pgTAP 053 (catálogo sembrado, vigencias sin solape, `plan_at` por defecto,
backfill, RLS por tenant, ancla); E2E: sin-RIF en Simple → 403 `PLAN_REQUIRED` en las siete
rutas; declarar RIF arranca la prueba; degradar conserva lo emitido; `modo_de_venta`
coincide con el trigger; web: nav filtrado por plan.

Documentación solidaria: `GLOSSARY.md` (régimen, modo de venta, recibo, taxpayer_type,
plan, módulo avanzado), `EMISION_FACTURAS.md` §1-bis, `RISK_REGISTER.md` R-27,
`MULTITENANCY_AND_RBAC.md`, `ROADMAP.md`, `PRODUCT_REQUIREMENTS.md` (planes y precios).

## 6. Orden de trabajo y tamaño

| Lote | Qué | Rigor | Migración | Tiempo estimado |
|---|---|---|---|---|
| P1 | ADR-0059 + migración 53 + `plan_at`/`modo_de_venta` + pgTAP 053 | Máximo | Sí | 1 sesión |
| P2 | `CompanyScope.plan`, `PLAN_REQUIRED`, prueba al declarar RIF, endpoints de plan, OpenAPI | Máximo | No | 1 sesión |
| P3 | S2 compra simple sin clasificación + S1 recibo de devolución (ADR-0060) | Máximo (dinero, stock) | Sí (S1) | 1–2 sesiones |
| P4 | Web: nav por plan, pantalla «plan Fiscal», Empezar/Mi empresa/Inicio, historial fiscal | Normal | No | 1 sesión |
| P5 | Glosario, specs, landing con precios en USD + BCV, guía del contador | Normal | No | ½ sesión |

Cada lote pasa `pnpm run verify` y se commitea; P1 y P3 necesitan tu aprobación explícita
por ser estructurales (ADR + migración).

## 7. Objeciones del comprador venezolano y cómo las cierra Ladino

| Objeción | Quién la usa hoy | Respuesta de Ladino |
|---|---|---|
| «¿Está homologado?» | Todos los desktop, con un sello derogado | «La homologación no existe desde agosto de 2026; cumplimos la 00071 y la 102, que sí rigen» (REGULATORY_STATUS) |
| «No tengo RIF» | Fina, Clarito, IUNCI (sin fiscal nunca) | Plan Simple hoy; Fiscal el día que llegue, sin migrar |
| «Sin luz / sin internet» | Profit, Hybrid, IUNCI (offline) | El punto débil de cloud-first. Respuesta honesta: PWA con cola de ventas pendientes es roadmap, no promesa. **No prometer offline** |
| «Tasa BCV» | Alegra VE, Kontave, Fina | Automática, con fuente y hora en cada documento; tasa propia si el BCV falla (ADR-0057) |
| «IGTF y retenciones» | Cachicamo, Gálac | Incluidos en Fiscal, con comprobantes y libros; percepción a la moneda (ADR-0053) |
| «Mi contador» | Zoho, Alegra, Siigo (rol gratis) | Contador gratis con acceso multi-empresa; contabilidad real desde el primer recibo |
| «Impresora fiscal» | Saint, a2 | Ladino no imprime por máquina fiscal; se dice en Empezar (art. 8, R-25) |
| «¿Cuánto cuesta de verdad?» | Precio oculto (Gálac, Profit) o módulos sueltos (Siigo, Alegra) | Dos precios públicos, en USD + IVA con Bs del día, sin módulos sueltos; el peaje de la imprenta digital, explícito |
| «Soporte» | Oficina L-V 8-18 (Cachicamo) | Soporte en la app + WhatsApp; horario a decidir |
| «Pago móvil / Cashea» | Fina | Formas de pago del POS ya incluyen pago móvil; Cashea es integración futura |

## 8. Lo que NO se copia

El sello derogado; el precio oculto o «según tasa por WhatsApp»; la licencia anual por
adelantado; módulos sueltos que inflan el precio 30–80 %; escritorio disfrazado de nube;
precios fijos en bolívares; comprobantes que parecen facturas; el suelo de $10 (no paga
soporte ni infraestructura); prometer offline.

## 9. VALIDAR antes de vender

- **VALIDAR-SENIAT**: si sigue publicado el listado de la PA 121 y cómo referirse a él; si
  la factura digital es obligatoria en canales electrónicos desde el 19/03/2026 (solo
  terceros lo afirman); si una firma personal puede usar imprenta digital.
- **VALIDAR-LEGAL**: el texto del recibo y de Empezar para el no inscrito (R-27).
- **VALIDAR-NEGOCIO**: precios finales ($24/$49 son referencia), cobro por caja/sucursal
  adicional, pasarela de pago, política de prueba y de impago (¿solo lectura tras 15 días?).
- **VALIDAR-TRIBUTARIO**: tratamiento del IVA de compra como costo en Simple (S2).

## Decisión que se te pide

1. ¿Sí a los dos planes con estos nombres y precios de referencia?
2. ¿Sí a que el plan sea un eje comercial (visibilidad/contratación) y el régimen conserve
   la última palabra sobre la emisión?
3. ¿Sí a cerrar S1 (recibo de devolución) y S2 (compra simple) antes de vender Simple?
4. ¿Sí al orden P1→P5, con aprobación tuya en P1 y P3?
