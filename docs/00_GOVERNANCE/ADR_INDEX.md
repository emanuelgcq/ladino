# ADR Index — Ladino

Los ADR viven en `docs/00_GOVERNANCE/adr/`. Crea uno nuevo ante **cualquier** cambio que afecte
persistencia, fiscalidad, sincronización offline, seguridad o el contrato de la API.
Usa la skill `adr` de Claude Code.

| ADR | Decisión | Estado | Impacto fiscal |
|---|---|---|---|
| [0001](adr/ADR-0001-monorepo-pnpm-turborepo.md) | Monorepo pnpm + Turborepo, solo pnpm | Aceptado | NO |
| [0002](adr/ADR-0002-supabase-gestionado.md) | Supabase gestionado como system of record | Aceptado | SÍ |
| [0003](adr/ADR-0003-fiscal-bounded-context.md) | Fiscal como bounded context con release train propio | Aceptado | SÍ |
| [0004](adr/ADR-0004-contrato-openapi-desde-zod.md) | OpenAPI generado desde Zod | Aceptado | NO |
| [0005](adr/ADR-0005-transactional-outbox.md) | Transactional outbox | Aceptado | SÍ |
| [0006](adr/ADR-0006-ledger-append-only.md) | Append-only con trigger + RLS | Aceptado | SÍ |
| [0007](adr/ADR-0007-expo-mobile.md) | Expo para mobile | Aceptado | SÍ |
| [0008](adr/ADR-0008-docker-hostinger-traefik.md) | Docker en VPS tras Traefik existente | Aceptado | NO |
| [0009](adr/ADR-0009-release-train-fiscal.md) | Release train fiscal con gate automático | Aceptado | SÍ |
| [0010](adr/ADR-0010-claude-no-autoritativo.md) | IA propone, nunca dispone | Aceptado | SÍ |
| [0011](adr/ADR-0011-vite-react-router.md) | Webapp con Vite (no Next.js) | Aceptado | NO |
| [0012](adr/ADR-0012-hono-api.md) | API con Hono sobre Node 22 | Aceptado | NO |
| [0013](adr/ADR-0013-decimal-js.md) | Decimal + numeric(24,8) + JSON string | Aceptado | SÍ |
| [0014](adr/ADR-0014-auth-claims-hook.md) | Permisos resueltos desde memberships, no del JWT | Aceptado | NO |
| [0015](adr/ADR-0015-zod-schemas-compartidos.md) | Zod como definición única | Aceptado | NO |
| [0016](adr/ADR-0016-testing.md) | Estrategia de pruebas por capa, TDD en dominio financiero | Aceptado | SÍ |
| [0017](adr/ADR-0017-observabilidad.md) | OpenTelemetry + logs estructurados | Aceptado | NO |
| [0018](adr/ADR-0018-idempotencia.md) | Idempotencia obligatoria por clave (enmendado por ADR-0076: BODY_MISMATCH, llave por intento) | Aceptado | SÍ |
| [0019](adr/ADR-0019-migraciones-expand-contract.md) | Expand/contract, nunca destructivo en un paso | Aceptado | SÍ |
| [0020](adr/ADR-0020-multimoneda.md) | Multimoneda con moneda funcional y trazabilidad de tasa | Aceptado | SÍ |
| [0021](adr/ADR-0021-fronteras-dependency-cruiser.md) | Fronteras con dependency-cruiser; `core` como kernel; `money/format` como subpath | Aceptado | NO |
| [0022](adr/ADR-0022-mobile-dentro-del-workspace.md) | `apps/mobile` dentro del workspace, con criterio de salida escrito | Aceptado | NO |
| [0023](adr/ADR-0023-money-y-exactmoney.md) | `Money` (persistible) separado de `ExactMoney` (calculado); solo se sale redondeando | Aceptado | SÍ |
| [0024](adr/ADR-0024-politica-de-redondeo-en-el-hecho-monetario.md) | `MonetaryFact` pasa a ocho campos: la política de redondeo se persiste (amplía ADR-0020) | Aceptado | SÍ |
| [0025](adr/ADR-0025-modelo-rbac-y-aislamiento.md) | Modelo RBAC con `requires_scope`; `permissions` global; por qué la inmutabilidad es un trigger y no una policy | Aceptado (retroactivo 2026-09-12; §3 matizado por ADR-0057) | NO |
| [0026](adr/ADR-0026-auditoria-outbox-e-idempotencia.md) | Esquema de `audit_events`, `outbox` e `idempotency_keys` | Aceptado | SÍ |
| [0027](adr/ADR-0027-la-regulacion-es-dato.md) | La regulación es dato, no código | Aceptado | SÍ |
| [0028](adr/ADR-0028-transmision-seniat-como-consumidor-de-outbox.md) | Transmisión SENIAT como consumidor de outbox tras interfaz (`NullTransmitter` hoy) | Aceptado | SÍ |
| [0029](adr/ADR-0029-regimen-fiscal-como-dato-por-empresa.md) | Régimen fiscal como dato versionado por empresa | Aceptado | SÍ |
| [0030](adr/ADR-0030-operador-de-plataforma-y-soporte.md) | Operador de plataforma con alcance acotado | Aceptado | NO |
| [0031](adr/ADR-0031-roles-de-servicio-sin-bypassrls.md) | Roles de servicio sin `BYPASSRLS`: la RLS también contiene a la API y al worker | Aceptado | NO |
| [0032](adr/ADR-0032-precios-append-por-vigencia.md) | Precios por vigencia, append-only estructural, la fecha como parámetro | Aceptado | NO |
| [0033](adr/ADR-0033-contrapartes-clasificacion-fiscal-y-rif.md) | Contrapartes: clasificación fiscal por catálogos globales y RIF auditado con valor anterior | Aceptado | NO |
| [0034](adr/ADR-0034-inventario-costeo-promedio-y-kardex-materializado.md) | Inventario: promedio ponderado móvil, kardex append-only materializado y transferencia atómica | Aceptado | NO |
| [0035](adr/ADR-0035-recetas-y-unidades-fraccionadas.md) | Productos compuestos: recetas de ingredientes y unidades fraccionadas | Aceptado | NO |
| [0036](adr/ADR-0036-variantes-como-productos-derivados.md) | Variantes de producto como productos derivados, no como dimensión de existencias | Aceptado | NO |
| [0037](adr/ADR-0037-numeracion-fiscal-correlativo-y-numero-de-control.md) | Numeración fiscal: el correlativo del emisor y el número de control son dos campos | Aceptado | SÍ |
| [0038](adr/ADR-0038-motor-tributario-con-catalogo-vacio.md) | Motor tributario: reglas como dato, catálogo vacío, sin emisión sin regla | Aceptado (enmendado por ADR-0073) | SÍ |
| [0039](adr/ADR-0039-retenciones-con-catalogo-vacio-y-formulas-cerradas.md) | Retenciones con catálogo vacío y fórmulas cerradas | Aceptado · enmendado por ADR-0072 (2026-10-02: retención automática del agente, comprobante-documento, máscara de la PA 000054 art. 16) | SÍ |
| [0040](adr/ADR-0040-compras-tablas-propias-y-landed-cost-con-variacion.md) | Compras con tablas propias; landed cost tardío genera variación | Aceptado | SÍ |
| [0041](adr/ADR-0041-mapeo-contable-como-vocabulario-cerrado.md) | Mapeo contable como vocabulario cerrado de propósitos | Aceptado | SÍ |
| [0042](adr/ADR-0042-cola-de-contabilizacion-pendiente.md) | Cola de contabilización pendiente: documento posteado ⇒ asiento o cola | Aceptado | SÍ |
| [0043](adr/ADR-0043-chart-templates-como-catalogo-global-importable.md) | Plantillas de plan de cuentas como catálogo global importable | Aceptado | SÍ |
| [0044](adr/ADR-0044-libros-fiscales-como-vista-sobre-snapshot-ampliado.md) | Libros fiscales como consulta sobre snapshot ampliado, nunca tabla | Aceptado | SÍ |
| [0045](adr/ADR-0045-adaptador-de-imprenta-digital-como-puerto.md) | Adaptador de imprenta digital como puerto; hoy NullDigitalPrintShop que rechaza | Aceptado | SÍ |
| [0046](adr/ADR-0046-la-venta-se-denomina-en-bolivares.md) | La venta se denomina en Bs; la lista USD es ancla de precios con tasa congelada | Reemplazado por 0047 | SÍ |
| [0047](adr/ADR-0047-la-deuda-se-ancla-en-dolares-el-papel-habla-en-bolivares.md) | La deuda se ancla en USD y se cobra a la tasa del día; el papel habla en Bs | Aceptado | SÍ |
| [0048](adr/ADR-0048-roles-con-nombre-y-navegacion-por-permiso.md) | Cinco roles de oficio sembrados; el menú y los botones se forman por permiso | Aceptado | SÍ |
| [0049](adr/ADR-0049-el-primer-dia-real-onboarding-y-miembros.md) | Onboarding autoservicio en un acto; miembros por correo; dueño plano + rol de almacén | Aceptado | SÍ |
| [0050](adr/ADR-0050-politica-de-rif-en-tres-niveles.md) | El RIF en tres niveles (libre sin documentos, bloqueado con ellos, corrección con acta); perfil y logo del negocio | Aceptado | SÍ |
| [0051](adr/ADR-0051-notas-de-debito-y-credito-directas.md) | ND y NC directa por el motor común; la ND es deuda (aging gana `debit_note` y `receipt`); asientos de NC/ND y del saldo a favor aplicado (cierra R-20) | Aceptado | SÍ |
| [0052](adr/ADR-0052-declaraciones-de-iva-y-percepcion-de-igtf.md) | Planilla demostrativa NO OFICIAL sin casillas; retención soportada como instrumento de pago; período insert-only con arrastre encadenado; IGTF por PAGO con conservadurismo asimétrico; calendario sin fechas de fábrica | Aceptado | SÍ |
| [0053](adr/ADR-0053-escala-de-la-percepcion-de-igtf.md) | La percepción de IGTF se redondea a las minor units ISO-4217 de su moneda; modo `HALF_UP` con nombre propio y política persistida por fila (migración 47) | Aceptado | NO |
| [0054](adr/ADR-0054-el-dia-del-negocio-es-el-de-caracas.md) | El día del negocio es el de Caracas en esquema y dominio: libros, antigüedad, saldos en moneda del documento y asientos cortan por `platform.caracas_day()` / `diaNegocio()` (migración 48) | Aceptado | SÍ |
| [0055](adr/ADR-0055-la-primera-vigencia-contable-rige-desde-siempre.md) | La primera plantilla contable y el primer papel por empresa rigen desde `-infinity`; las versiones siguientes empiezan al crearse (migración 50) | Aceptado | NO |
| [0056](adr/ADR-0056-la-reserva-de-idempotencia-se-mide-desde-su-reclamacion.md) | El reaper libera reservas huérfanas por `claimed_at`, no por `created_at`; la misma llave en otro endpoint es `IDEMPOTENCY_KEY_REUSED` (migración 49) | Aceptado | NO |
| [0057](adr/ADR-0057-lo-manual-es-de-cada-empresa-lo-oficial-de-la-plataforma.md) | Tasas manuales, alícuotas aceptadas y reglas de retención llevan empresa; `NULL` = plataforma (BCV, sistema); lo propio gana a lo oficial (en tasas, sustituido por ADR-0064: solo la oficial); firmas sin empresa eliminadas; la RLS decide quién escribe qué (migración 52) | Aceptado (enmendado por 0064 y por ADR-0073) | SÍ |
| [0058](adr/ADR-0058-el-documento-de-venta-se-redondea-a-la-moneda.md) | Base e impuesto de cada línea a las minor units de la moneda del documento (`sales:document:2:HALF_UP`); conversión funcional a las de la funcional; vuelto entregable; valoración de cobros y diferencial siguen a ocho decimales | Aceptado | SÍ |
| [0059](adr/ADR-0059-la-caja-cobra-con-el-igtf-dentro-de-lo-recibido.md) | Lo tecleado en caja es lo ENTREGADO: un solo cálculo (vista previa y venta) reparte venta, IGTF y vuelto; tolerancia de una unidad mínima; vuelto solo en efectivo y hacia abajo; el IGTF cobrado entra al saldo de caja (migración 53); hasta cuatro formas | Aceptado | NO |
| [0060](adr/ADR-0060-el-costo-de-lo-vendido-y-el-inventario-en-el-mayor.md) | El costo de ventas es un hecho propio; toda entrada de kardex asienta; FEFO en la venta con lotes; la cuenta de efectivo sale de la cuenta de tesorería real en cobro, pago a proveedor, gasto y cierre (sin mapeo → cola con motivo, nunca `cash_bs`); invariante kardex ↔ mayor de inventario; regularización por empresa con ensayo en seco; marca de semilla por registro | Aceptado | NO |
| [0061](adr/ADR-0061-corregir-una-venta.md) | Anular solo factura/recibo sin cobros y repone al costo exacto que salió; una venta cobrada se deshace por devolución (NC o recibo de devolución) con saldo a favor o reembolso; tope acumulado de devolución; invariante de ventas anuladas | Aceptado | NO |
| [0062](adr/ADR-0062-el-dinero-del-negocio.md) | La caja de un cobro se resuelve por forma configurada y, si no hay, por la cuenta propia de esa familia; la moneda de la forma manda sobre la cuenta; transferencia entre cuentas de la misma moneda como hecho con dos patas; todo egreso sin saldo exige confirmación explícita | Aceptado | NO |
| [0063](adr/ADR-0063-el-centimo-de-la-caja.md) | Un solo total para caja y documento; el cobro que cierra se guarda en céntimos y vale exactamente lo pendiente; el diferencial por proporción (cero con tasas iguales); saldos, arqueo y equivalencias se sirven en unidades mínimas | Aceptado | NO |
| [0064](adr/ADR-0064-la-tasa-oficial-y-las-dos-monedas.md) | Solo existe la tasa del BCV: la conversión lee solo la oficial y nadie escribe una tasa a mano (API, pantallas y RLS), para toda empresa; en pantalla y en el PDF se lee «Tasa BCV: 842,2067»; el documento fiscal en divisa imprime base, IVA y total en las dos monedas; el fiado cobrado a otra tasa se documentará con nota de débito o crédito cuando el asesor confirme el art. 51 (P-20) | Aceptado (§3 en espera) | YES |
| [0065](adr/ADR-0065-la-nota-del-proveedor-y-lo-que-nadie-vigilaba.md) | La nota de crédito recibida se asienta, entra al libro en negativo y resta el crédito fiscal en su propio período; la factura anulada va al libro con importes en cero; el pasivo por retención nace al REGISTRAR la factura (abono en cuenta) y el pago cancela el neto; insertar en un asiento posteado falla; los controles distinguen la causa y cubren también el dinero (migraciones 67 y 68) | Aceptado | YES |
| [0066](adr/ADR-0066-la-mercancia-entra-por-una-puerta.md) | La mercancía entra por UNA pantalla («Llegó mercancía»): la persona dice de quién vino y el sistema deriva el asiento; cuatro salidas (factura · por facturar · sin soporte fiscal · aporte) y la de «sin soporte» no necesita plantilla nueva, sino marca y filtro del libro; todo movimiento de entrada declara su origen y la ruta suelta lo exige; permiso por camino y recepción a ciegas; la fecha de la llegada se acota y el costo intermedio NO se corrige; Inventario deja de meter mercancía (migraciones 69–71) | Aceptado | YES |
| [0067](adr/ADR-0067-la-cuenta-se-pregunta-no-se-adivina.md) | La CUENTA de donde sale o entra el dinero se pregunta cuando hay más de una candidata, y no se preselecciona: una preselección es la misma adivinanza con un sello. El instrumento y la cuenta son dos hechos y los dos se guardan (el IGTF se decide sobre el instrumento). En el POS no se pregunta dos veces: se abre un botón por cuenta. Lo ya mal atribuido se ENSEÑA con un informe y se reparte con la transferencia entre cuentas — no se reescribe (migración 73) | Aceptado | NO |
| [0068](adr/ADR-0068-el-paso-interior-lo-autoriza-la-operacion.md) | El paso interior de un caso de uso compuesto lo autoriza la operación que lo contiene (la venta saca del kardex, la anulación revierte el asiento, el alta simple pone el precio); los roles son por empresa y lo que gobierna la cuenta es del Titular; la web enseña solo lo que el servidor permite; una venta por oficio como test | Aplicado (respuesta del dueño 2026-09-28) | NO |
| [0069](adr/ADR-0069-los-periodos-tienen-historia.md) | Los períodos tienen historia en `fiscal_period_events` (cerrar → reabrir → cerrar, n veces); período de cierre «13» para el cierre anual; fechas acotadas por el inicio de actividades; el borrador no nace en un período cerrado y se puede descartar; la factura de proveedor tardía entra al período abierto con su fecha original | Aplicado (respuesta del dueño 2026-09-28) | YES |
| [0070](adr/ADR-0070-cada-cuenta-de-tesoreria-tiene-su-subcuenta.md) | Cada cuenta de tesorería nace con su subcuenta contable; `apply_ledger_balance` agrupa por cuenta; las existentes se reparan con un asiento de reclasificación, nunca con UPDATE | Aplicado (respuesta del dueño 2026-09-28) | NO |
| [0071](adr/ADR-0071-un-correlativo-de-control-por-emisor.md) | Un correlativo de control por empresa e identificador (PA 00071 art. 44), compartido por factura, NC y ND; el rango se registra con los datos de la imprenta y sin solapes; la serie la dicta el talonario; lo preimpreso no se imprime encima y el PDF es copia de cortesía | Aplicado (respuesta del dueño 2026-09-28) | YES |
| [0072](adr/ADR-0072-el-contribuyente-especial-de-punta-a-punta.md) | El contribuyente especial de punta a punta: tipo con vigencia, IGTF sobre todo pago en divisas y su ND, retención al registrar con exclusiones como data, comprobante de retención como documento, TXT del instructivo, declaración quincenal, dos arrastres y calendario sembrado (enmienda ADR-0052) | Aplicado (respuesta del dueño 2026-09-28) | YES |
| [0073](adr/ADR-0073-las-alicuotas-son-un-catalogo-con-fuente.md) | Condición fiscal por producto y catálogo de alícuotas con fuente; la empresa acepta su general con acta (8–16,5 %, nunca 0 %); factura, libro y declaración por alícuota; la cesta básica exenta; la adicional del art. 62 no se siembra | Aplicado (respuesta del dueño 2026-09-28) | YES |
| [0074](adr/ADR-0074-la-importacion-es-un-trabajo.md) | La importación declara el formato numérico, enseña una vista previa interpretada, rechaza lo ambiguo y corre como trabajo en segundo plano, idempotente por el hash del archivo | Aplicado (respuesta del dueño 2026-09-28) | NO |
| [0075](adr/ADR-0075-moneda-diferencial-y-redondeo.md) | El precio es USD y la factura Bs, con una regla de conversión por línea; diferencial al pagar; documento pagado cerrado en cero; revaluación al cierre; una sola función de deuda; todo el mayor al céntimo, incluido el inventario; reversa de cobros con la restitución del IGTF. Enmienda 0058, 0060 y 0063 | Aplicado (respuesta del dueño 2026-09-28) | YES |
| [0076](adr/ADR-0076-llave-por-intento-y-cuentas-del-pos.md) | Llave de idempotencia por intento; IDEMPOTENCY_BODY_MISMATCH; la cuenta vendida muere en el servidor; cuentas con autor y caja | Aplicado (respuesta del dueño 2026-09-28) | NO |
| [0077](adr/ADR-0077-empresa-por-pestana-e-invitaciones.md) | La empresa activa vive en la pestaña; segunda empresa desde el selector; invitación por enlace con token; quien pierde el acceso no aterriza en «monta tu negocio» | Aplicado (respuesta del dueño 2026-09-28) | NO |
| [0078](adr/ADR-0078-salidas-y-retiros-de-inventario.md) | Traslado, ajuste por conteo y salida con motivo (CHECK); mermas a su cuenta; el retiro (consumo propio, regalo, donación, muestra) causa débito con Nota de retiro; inactivo no es inexistente; «por agotarse» cuenta lotes | Aplicado (respuesta del dueño 2026-09-28) | YES |
| [0079](adr/ADR-0079-rules-version-semver-mas-hash.md) | `rules_version` = versión semántica (sube por migración) + hash del conjunto de reglas de la empresa; la base la congela en cada fila en un solo sitio y la registra; lo anterior conserva `domain-s0.5` | Aplicado (respuesta del dueño 2026-09-28) | YES |
| [0080](adr/ADR-0080-el-gasto-con-factura-fiscal-es-una-compra-de-servicio.md) | El gasto con factura fiscal se registra por `registerSupplierInvoice` (libro, crédito, retención, comprobante) y se paga en el acto; línea sin producto, plantilla y evento `ap.expense_invoice_posted`; no hay fila en `expenses` | Aplicado (respuesta del dueño 2026-09-28) | YES |

## Decisiones aún abiertas

No tienen ADR porque dependen de respuestas externas. Ver `OPEN_QUESTIONS.md`.

- Proveedor de imprenta digital.
- Residencia de datos exigida para homologación (afecta a ADR-0002).
- Si la frontera de bounded context fiscal es aceptada por SENIAT (afecta a ADR-0003).
- Si un build Expo que emite entra en el alcance de homologación (afecta a ADR-0007).
- Nómina en P1 o P2.
- Soporte de balanzas e impresoras fiscales físicas.
