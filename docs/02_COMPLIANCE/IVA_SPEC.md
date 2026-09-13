# IVA

## Alcance
- débito fiscal;
- crédito fiscal;
- exento/exonerado/no gravado;
- múltiples alícuotas configurables;
- prorrata si aplica;
- retención de IVA;
- libros.

## Diseño
No fijar 16% en código. Cualquier tasa vigente se carga desde configuración versionada con fuente jurídica.

## Posting ejemplo conceptual
Venta gravada:
- Dr CxC/Caja
- Cr Ingreso
- Cr IVA Débito Fiscal

Compra:
- Dr Inventario/Gasto
- Dr IVA Crédito Fiscal
- Cr CxP/Caja

La cuenta exacta depende de chart mapping de empresa.

## Validaciones
- suma de bases por tratamiento;
- impuesto por línea/documento según política autorizada;
- redondeo consistente (ADR-0058: base e impuesto de cada línea a las minor units de la moneda);
- notas ajustan documento origen.

## Fuentes normativas (verificadas 2026-09-12)

- **Alícuotas vigentes**: general 16 %, reducida 8 %, adicional sobre bienes suntuarios hasta
  31 % (Ley de IVA y Decreto 4.653 de 2025). **No se siembran**: la empresa las acepta en el
  asistente con su fuente (`tax_rules`, ADR-0038) y son suyas (ADR-0057).
- **PA SNAT/2025/000048** (G.O. 43.140, 02/06/2025): Unidad Tributaria = **Bs. 43**. Es la
  cifra con la que se lee el umbral del art. 8 de la PA 00071 (1.500 UT = Bs. 64.500/año al
  consumidor final en actividad listada ⇒ máquina fiscal obligatoria, que Ladino no imprime;
  R-25, aviso en el onboarding).
- **PA SNAT/2025/000091**: calendario 2026 de sujetos pasivos especiales. Las fechas de
  declaración **no vienen de fábrica** (ADR-0052): se cargan por empresa desde esta fuente.
- **Retención de IVA**: PA SNAT/2025/000054 — ver `RETENTIONS_SPEC.md`.
- Texto primario en Gaceta pendiente de archivar en `EXPEDIENTE_TECNICO.md`
  (**VALIDAR-TRIBUTARIO**).
