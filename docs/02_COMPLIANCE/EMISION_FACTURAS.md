# Emisión de facturas — las tres vías y qué cumple Ladino

> **Estado: VIGENTE.** Verificado al **2026-09-02** con fuentes primarias por el responsable del
> proyecto (procedencia y advertencia en `REGULATORY_STATUS.md`, que es el punto de entrada).
> Este documento es la vista OPERATIVA: qué vía le corresponde a quién, qué exige cada una, y
> dónde —en código, esquema o pantalla— lo cumple Ladino. Cada afirmación normativa lleva su
> providencia y artículo.

---

## 1. Las tres vías (PA 00071 art. 6)

El contribuyente elige **libremente** entre tres medios de emisión — salvo que el art. 8 lo
obligue a máquina fiscal:

| Vía | Quién asigna el N° de control | Estado en Ladino |
|---|---|---|
| **Formatos libres** (imprenta autorizada) | La imprenta, por **rango preasignado** impreso en el papel | **Construida** — `numbering_mode = 'range'` (ADR-0037), `fiscal_number_ranges`, PDF de forma libre |
| **Imprenta digital** (PA 102) | La imprenta digital, **documento a documento** | **Contrato definido** — `per_document` (ADR-0037) + `DigitalPrintShopAdapter` (ADR-0045); implementación = dependencia externa |
| **Máquina fiscal** (PA 0141) | La máquina | **No construida** — R-25; Ladino opera como administrativo sin emisión para este segmento |

Y la **tercera modalidad del producto**, que no es una vía de emisión sino un modo válido de
usar Ladino: **administrativo completo SIN emisión** (`regime_code = 'sin_emision'`). La
empresa lleva inventario, clientes, cuentas, compras, tesorería y contabilidad en Ladino y
factura por fuera (típicamente su máquina fiscal). Es exactamente como opera Fina con ese
segmento, y `/empezar` lo asigna cuando el negocio declara tener máquina fiscal.

## 1-bis. El MODO RECIBOS: el negocio que aún no tiene RIF (migración 37)

**Sin RIF no existe factura**: el art. 13.5 de la PA 00071 exige RIF y domicilio fiscal del
EMISOR en el documento — un no-inscrito no puede emitir nada que sea factura, y tampoco puede
repercutir IVA. El modo recibos (`regime_code = 'sin_facturacion'`, `numbering_mode
internal_only`, `allowed_kinds = {receipt}`) es **administrativo, no fiscal**: la venta
produce un **RECIBO** rotulado «Documento no fiscal — no es una factura», sin número de
control, sin RIF del emisor y sin IVA (líneas con tratamiento `no_fiscal`, sin regla
tributaria). Inventario, cobros, deudas, cuentas y contabilidad funcionan idénticos a una
venta normal (asiento CxC contra ingresos, sin línea de IVA); el recibo **jamás** entra a
libros fiscales (el libro de ventas filtra por `kind`, con test).

**La regla dura, en las dos direcciones y en el ESQUEMA** (trigger de emisión, LAD49): un
régimen fiscal **no puede emitir recibos** — nadie con RIF vende por recibo desde Ladino,
que es la puerta al uso evasor — y `sin_facturacion` no puede emitir facturas. La PA
SNAT/2026/00080 hizo el RIF digital y sin caducidad: al obtenerlo, `/empezar` cambia el
régimen a formatos libres (la vigencia vieja se cierra, append-only por fecha), el POS pasa
a facturar, y los recibos históricos quedan intactos y visibles — nunca en libros. Riesgo
del inscrito que se declare «sin RIF»: R-27.

## 2. Quién DEBE usar máquina fiscal (PA 00071 art. 8)

Obligado quien reúna las **tres condiciones concurrentes**:

1. ingresos brutos anuales del **año anterior superiores a 1.500 UT**;
2. operaciones **mayoritarias** con **consumidor final**;
3. actividad **listada** en el artículo (ventas al detal, restaurantes, farmacias, etc. —
   la lista exacta es del texto del artículo, no de este resumen).

El **literal j** obliga **sin importar el ingreso**. Y el **art. 49** prohíbe a los obligados
emitir documentos previos (presupuestos, proformas, notas de entrega que hagan de factura).

**Qué hace Ladino con esto:** `/empezar` pregunta «¿a quién le vendes principalmente?» y
«¿tienes máquina fiscal?». Ventas mayormente a personas (o mitad y mitad) sin máquina → se
asigna formatos libres **con advertencia visible** citando el art. 8 y remitiendo al contador.
Con máquina → `sin_emision` con el mensaje honesto de que Ladino aún no imprime por máquina
fiscal. Ladino **no decide** si el art. 8 aplica: no conoce los ingresos del año anterior ni
califica la actividad — eso es del contador (VALIDAR-TRIBUTARIO).

## 3. Los requisitos del art. 13 (forma libre), mapeados

| Numeral | Exige | Dónde lo cumple Ladino |
|---|---|---|
| 13.1-13.3 | Denominación «Factura», numeración consecutiva, N° de control | `KIND_TITULO` en el PDF; `document_number` gapless y `control_number` de rango (ADR-0037, LAD49) |
| 13.5 | Nombre/razón social, **domicilio fiscal** y RIF del emisor | **Snapshot congelado al crear el documento** (migración 34, `issuer_*_snapshot`, LAD68); `companies.fiscal_address` lo pide `/empezar`; sucursal aparte si aplica |
| 13.6 | Fecha de emisión en **ocho dígitos** | `fechaLegible()` — DD/MM/AAAA |
| 13.7-13.8 | Identificación del adquirente | Snapshot del cliente (migración 33, `customer_*_snapshot`); jurídica/gobierno exigen domicilio al crearse |
| 13.9 | Marcador **«(E)»** en operaciones exentas/exoneradas/no sujetas | El PDF lo imprime junto a la descripción, leído del `tax_treatment` **congelado** (migración 27); una línea pre-27 sin tratamiento no se marca — no se adivina |
| 13.13 | **«SIN DERECHO A CRÉDITO FISCAL»** en toda copia | `GET /v1/documents/:id/pdf?copia=1` — el generador distingue original de copia |
| 13.14 | Ambas monedas y **tipo de cambio** si la operación se expresó en moneda extranjera | El PDF imprime total en moneda de transacción, equivalente funcional y la tasa con su fuente — los tres congelados en la fila |

El **layout sigue siendo provisional** (VALIDAR-SENIAT, abajo): estos elementos son de la
00071 y van ya; lo pendiente es contrastar el conjunto contra un ejemplar real aprobado.

## 4. Los requisitos de la PA 102 y su estado

| Requisito (PA 102) | Estado en Ladino |
|---|---|
| Autorización del emisor (arts. 3/17) | **Dependencia externa** — trámite del contribuyente, no del software |
| Control asignado documento a documento por imprenta digital | **Contrato definido** — `DigitalPrintShopAdapter.assignControlNumber()` (ADR-0045); `per_document` modelado (ADR-0037) y deshabilitado hasta tener adaptador real |
| Formato del control, art. 30 (dos dígitos + hasta ocho, desde 00-1) | **Construido** — `CONTROL_NUMBER_RE` en `packages/fiscal`, probado |
| Talonarios de contingencia con la palabra «contingencia» | **Construido** — migración 35: `contingency_ranges` (LAD69 exige la palabra en la serie), `registerContingencyInvoice` registra a posteriori con los números del papel, entrando a libros y contabilidad como cualquier documento |
| Conservación 10 años | **Construido de facto** — documentos inmutables y append-only (regla 1, LAD06/LAD68); la política de retención explícita queda anotada en `FISCAL_DOCUMENTS_SPEC.md` |
| Entrega por medio digital | **Construido** — PDF por descarga y WhatsApp desde el POS |
| Elegir imprenta digital autorizada | **Dependencia externa** — decisión del operador con la lista vigente en la mano (VALIDAR-SENIAT) |

## 5. VALIDAR-SENIAT abiertos de emisión

| # | Qué falta validar | Sostenido por |
|---|---|---|
| 1 | **Layout oficial de forma libre** contra un ejemplar real aprobado (el PDF lo dice en su pie) | PA 00071 art. 13 completo |
| 2 | **Lista de imprentas digitales autorizadas vigente** — no está en el repo y no se inventa | PA 102; ADR-0045 |
| 3 | **Regex y dígito verificador del RIF** — hasta la respuesta, ningún regex de formato (solo normalización) | OPEN_QUESTIONS 9; PA SNAT/2026/00080 |
| 4 | **Máscara del comprobante de retención** | ADR-0039; `RETENTIONS_SPEC.md` |

## 6. Riesgos relacionados

- **R-25** (`RISK_REGISTER.md`): el segmento retail-consumidor-final con volumen requiere
  máquina fiscal (art. 8) y Ladino no la tiene.
- **R-26**: la vía digital depende de una imprenta digital autorizada — dependencia externa.
