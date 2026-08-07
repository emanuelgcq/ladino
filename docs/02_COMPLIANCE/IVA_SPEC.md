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
- redondeo consistente;
- notas ajustan documento origen.
