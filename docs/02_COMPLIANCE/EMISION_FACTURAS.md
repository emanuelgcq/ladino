# Emisión de facturas — las tres vías y qué cumple Ladino

> **Estado: VIGENTE.** Revisado el **2026-09-28** contra la PA 00071 (G.O. 39.795) y la PA 102
> (procedencia en `REGULATORY_STATUS.md`, que es el punto de entrada). La homologación de
> software (PA 121) está **derogada** por la PA SNAT/2026/00084 (G.O. 43.435, 12-08-2026), sin
> sustituta: ningún documento de Ladino lleva leyenda de homologación.
> Este documento es la vista OPERATIVA: qué vía le corresponde a quién, qué exige cada una, y
> dónde —en código, esquema o pantalla— lo cumple Ladino. Cada afirmación normativa lleva su
> providencia y artículo.

---

## 1. Las tres vías (PA 00071 art. 6)

El contribuyente elige **libremente** entre tres medios de emisión — salvo que el art. 8 lo
obligue a máquina fiscal:

| Vía | Quién asigna el N° de control | Estado en Ladino |
|---|---|---|
| **Formas libres** (imprenta autorizada, PA 00071 arts. 6.2 y 31) | La imprenta, por **rango preasignado** impreso en el papel | **Construida** — `numbering_mode = 'range'` (ADR-0037), `fiscal_number_ranges`, PDF de forma libre |
| **Imprenta digital** (PA 102) | La imprenta digital, **documento a documento** | **Contrato definido** — `per_document` (ADR-0037) + `DigitalPrintShopAdapter` (ADR-0045); implementación = dependencia externa |
| **Máquina fiscal** (PA 0141) | La máquina | **No construida** — R-25; Ladino opera como administrativo sin emisión para este segmento |

«Formatos» (art. 6.1 y 30) es otro medio: en él la imprenta preimprime la denominación, el número y los datos del emisor. Ladino no emite sobre formatos. En forma libre **nunca** se emite a mano (art. 6).

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
| 13.7 | Adquirente: nombre o razón social y RIF, o cédula o pasaporte si es persona natural sin uso tributario | Snapshot del cliente (migración 33, `customer_*_snapshot`); jurídica/gobierno exigen domicilio al crearse |
| 13.8 | Descripción con cantidad y monto, y marcador **«(E)»** junto a lo exento, exonerado o no sujeto | El PDF lo imprime junto a la descripción, leído del `tax_treatment` **congelado** (migración 27); una línea pre-27 sin tratamiento no se marca — no se adivina |
| 13.13 | **«SIN DERECHO A CRÉDITO FISCAL»** en toda copia | `GET /v1/documents/:id/pdf?copia=1` — el generador distingue original de copia |
| 13.14 | Ambas monedas y **tipo de cambio** si la operación se expresó en moneda extranjera | ADR-0047: la operación se expresa en la moneda de la lista (ancla USD) y la deuda queda anclada ahí. El PDF **habla en Bs** — líneas y totales del lado funcional congelado al emitir — y añade base imponible, IVA y total en la divisa (LIVA art. 69) y la tasa, limpia: «Tasa BCV: 842,2067» (ADR-0064; «Tipo de cambio» si el documento viejo se emitió con una tasa tecleada). Ambas monedas presentes, el Bs se lee grande. La fecha de la tasa no se imprime: P-21 |

La tabla se completa con «13.9 · recargos, descuentos, bonificaciones y anulaciones, con descripción y valor», y el resto de los 16 numerales, en `FACTURA_CHECKLIST.md` (FC-01…FC-33). El contenido del documento se prueba contra esa checklist.

## 3-bis. El PDF no es la factura

La factura válida es la impresa sobre la **forma libre**, con el control preimpreso por la imprenta (arts. 13.3 y 31).

- **Lo preimpreso no se imprime encima.** Lo que la imprenta preimprime aparece en la vista previa sombreado como «preimpreso en la forma libre», y en el papel queda en blanco. El número de control, por omisión, se imprime también en el cuerpo del documento como referencia («Control N° 00-00001234»), nunca sobre la casilla preimpresa.
- **El PDF es una copia de cortesía.** El PDF que se descarga o comparte lo dice: «Copia de cortesía · La factura válida es la impresa en forma libre con control N° …».
- **La factura digital solo existe por la PA 102**, emitida a través de una imprenta digital autorizada. El adaptador está pendiente, fuera de esta entrega.
- **Leyendas legales.** Las copias impresas llevan «SIN DERECHO A CRÉDITO FISCAL» (13.13), y ninguna otra leyenda legal.

## 4. Los requisitos de la PA 102 y su estado

| Requisito (PA 102) | Estado en Ladino |
|---|---|
| Autorización del emisor (arts. 3/17) | **Dependencia externa** — trámite del contribuyente, no del software |
| Control asignado documento a documento por imprenta digital | **Contrato definido** — `DigitalPrintShopAdapter.assignControlNumber()` (ADR-0045); `per_document` modelado (ADR-0037) y deshabilitado hasta tener adaptador real |
| Formato del control, art. 30 (dos dígitos + hasta ocho, desde 00-1) | **Construido** — `CONTROL_NUMBER_RE` en `packages/fiscal`, probado |
| Talonarios de contingencia con la palabra «contingencia» | **Construido** — migración 35: `contingency_ranges` (LAD69 exige la palabra en la serie), `registerContingencyInvoice` registra a posteriori con los números del papel, entrando a libros y contabilidad como cualquier documento |
| Conservación 10 años | **Construido de facto** — documentos inmutables y append-only (regla 1, LAD06/LAD68); la política de retención explícita queda anotada en `FISCAL_DOCUMENTS_SPEC.md` |
| Entrega por medio digital | **Solo aplica a la vía PA 102, no construida.** En forma libre, el PDF es copia de cortesía (§3-bis). La pantalla «Venta lista» ofrece «Descargar PDF» y «Compartir» del navegador (share sheet nativo). **No hay botón de WhatsApp**: se quitó a propósito en `8756c91` y no se repone (E-06). |
| Elegir imprenta digital autorizada | **Dependencia externa** — decisión del operador con la lista vigente en la mano (VALIDAR-SENIAT) |

## 5. VALIDAR-SENIAT abiertos de emisión

| # | Qué falta validar | Sostenido por |
|---|---|---|
| 1 | ~~Layout oficial de forma libre~~ — **cerrada** (2026-09-28): el contenido se rige por el art. 13 (`FACTURA_CHECKLIST.md`); E-04 cierra la base e IVA por alícuota | PA 00071 art. 13 completo |
| 2 | **Lista de imprentas digitales autorizadas vigente** — no está en el repo y no se inventa | PA 102; ADR-0045 |
| 3 | ~~Regex y dígito verificador del RIF~~ — **cerrada con M-05 / A-08** (2026-09-28): se guarda normalizado (`V123456789`) y se imprime `V-12345678-9` / `J-12345678-9`. La norma exige el número (13.5 y 13.7); la grafía es la del certificado del SENIAT. La estructura (V, E, J, G, P o C + 8 dígitos + 1 verificador) bloquea. El dígito verificador (módulo 11) solo avisa y queda VALIDAR-SENIAT: ninguna providencia lo fija (la PA SNAT/2026/00080 no define la estructura) | OPEN_QUESTIONS 9; PA SNAT/2026/00080 |
| 4 | ~~Máscara del comprobante de retención~~ — **cerrada** (2026-09-28): PA SNAT/2025/000054 art. 16, `AAAAMM` + 8 dígitos | ADR-0039; `RETENTIONS_SPEC.md` |

## 6. Riesgos relacionados

- **R-25** (`RISK_REGISTER.md`): el segmento retail-consumidor-final con volumen requiere
  máquina fiscal (art. 8) y Ladino no la tiene.
- **R-26**: la vía digital depende de una imprenta digital autorizada — dependencia externa.
