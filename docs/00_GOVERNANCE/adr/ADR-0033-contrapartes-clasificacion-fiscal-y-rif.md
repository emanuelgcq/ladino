# ADR-0033 — Contrapartes: clasificación fiscal por catálogos globales y RIF auditado con valor anterior

- **Estado:** Aceptado
- **Fecha:** 2026-08-26
- **Impacto fiscal:** NO (clasificación referencial sin tasa ni regla; el RIF no se valida en formato)

## Contexto

El maestro de clientes es la primera contraparte del sistema y arrastra dos decisiones que el
motor tributario (que no existe) va a consumir: **qué es fiscalmente el cliente** (`taxpayer_type`
en `TAX_ENGINE_SPEC` §Modelo, sin valores definidos en ningún documento de `02_COMPLIANCE` —
comprobado por grep), y **cómo se cambia su RIF** — la operación que una fiscalización pregunta
como «¿bajo qué RIF se emitió esto?» (M4, migración 10, R-05). Las specs de clientes son
esqueletos (`CUSTOMERS_CRM_SPEC`); las decisiones D-1..D-14 y el vocabulario los fijó el usuario.

## Decisión

### Dos ejes fiscales, dos catálogos globales, sin tasas

- **`taxpayer_types`**: `ordinario`, `especial`, `formal`, `no_sujeto`, `no_domiciliado` — la
  clasificación del sujeto pasivo en la normativa venezolana de IVA e ISLR. **VALIDAR-TRIBUTARIO**
  en la propia migración: hoy son etiquetas sin consecuencia; se confirman con asesor antes de que
  `tax_rules` las cruce con una regla.
- **`person_types`**: `natural`, `juridica`, `gobierno`, `extranjera`.
- **Dos campos, no uno**: ISLR mira persona y residencia; IVA mira la designación de especial.
  Son ejes independientes; fundirlos obliga a un producto cartesiano inmanejable.
- **«Agente de retención» NO es un booleano**: se deriva de `taxpayer_type` cuando exista el motor.
  Dos campos para el mismo hecho divergen — el mismo argumento de `created_by` vs `actor_id`.
- Misma forma que `product_tax_categories` (ADR-0032 / D-3 de productos): código `text`
  semántico, FK desde el cliente, ninguna tasa en ninguna parte.

### El RIF del cliente: nullable, único parcial, y auditado con el valor anterior

- `tax_id` **sin validación de formato** (`OPEN_QUESTIONS` 9; migración 10 hizo lo mismo con
  `companies`): inventar un regex es inventar una obligación legal.
- **Nullable solo para persona natural** (CHECK): «cliente sin RIF persona natural» es un caso de
  la spec; una jurídica sin RIF es un error. Único **parcial** por company sobre `upper(tax_id)`:
  dos clientes sin RIF conviven, dos con el mismo no.
- **Cambio de RIF = patrón M4 completo**: permiso propio `customer.tax_id.manage` (distinto de
  `customer.manage`), trigger `AFTER UPDATE OF tax_id` que exige el permiso cuando hay JWT y
  registra en `audit_events` `customer.tax_id_changed` con `tax_id_anterior` y `tax_id_nuevo`
  (LAD36). Es la red del esquema; el caso de uso exige el mismo permiso antes. Bloquear el cambio
  cuando existan documentos emitidos sigue abierto (`OPEN_QUESTIONS` 11): no hay documentos.
- **R-05 se hereda al cliente**: el documento fiscal COPIA razón social, RIF y domicilio del
  cliente al emitir; nunca los referencia.

### Alcance del maestro (D-1..D-14)

Por company; una dirección fiscal inline; email y teléfono inline; `default_price_list_id`
opcional con FK compuesto por company; estados `lead/active/blocked/inactive` con `blocked`
gobernado por `customer.block` (cobranzas bloquea, ventas no). **Fuera**: contactos múltiples,
direcciones múltiples, perfiles de crédito (módulo de crédito), etiquetas, y la unificación
cliente/proveedor en un `party` — R-12 en `RISK_REGISTER`, disparador: proveedores.

## Consecuencias

- Positivas: el motor tributario tendrá contrapartes ya clasificadas por dos ejes estables; el
  cambio de RIF es explicable ante una fiscalización con el valor anterior garantizado por el
  esquema; PII de persona natural queda identificada (nombre, RIF, email, teléfono, dirección) con
  la regla de no borrar sino desactivar (los snapshots fiscales son copias).
- Negativas: la misma contraparte en dos companies son dos filas; un mismo RIF como cliente y como
  proveedor puede divergir en razón social (R-12); el vocabulario fiscal es provisional hasta
  el asesor.
- Revertir: `drop` de tablas y catálogos mientras estén vacíos; las filas de auditoría que deje
  un cambio de RIF no se revierten — es el punto.

## Verificación

pgTAP 018: RIF hostil (mayúsculas/minúsculas, espacios) y único parcial ejercido en las dos
direcciones (dos sin RIF conviven; dos con el mismo no), jurídica sin RIF rechazada, cambio de RIF
sin permiso → LAD36 y con permiso → fila de auditoría con **el valor anterior asertado por el
dato**, aislamiento por company, variantes rotas (sin el índice el duplicado entra; sin el trigger
el cambio no deja rastro). Dominio y E2E como `ladino_api` con la segregación de permisos.
