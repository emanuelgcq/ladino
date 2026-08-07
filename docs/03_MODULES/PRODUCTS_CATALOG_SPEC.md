# Productos, servicios y catálogo


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Modelar bienes/servicios con atributos operativos, inventario y tributación.

## Entidades
- `products`
- `product_variants`
- `categories`
- `brands`
- `barcodes`
- `lots`
- `serials`
- `bom_components`

## Reglas de negocio
- SKU único por empresa.
- Producto inventariable genera movimientos.
- Servicio no genera stock.
- Categoría tributaria separada del IVA hard-coded.
- Combo/receta puede consumir componentes.

## Estados / transiciones
draft → active → inactive.

## Permisos
- inventario administra SKU.
- ventas puede consultar.
- contador aprueba mapeo contable/tributario.

## API / eventos
- `POST /v1/products`
- `POST /v1/products/:id/variants`
- `product.updated`

## Criterios de aceptación
- [ ] No vender SKU inactivo salvo permiso especial.
- [ ] barcode único.
- [ ] Cambio tributario no altera ventas pasadas.

## Casos límite
- talla/color.
- producto por peso.
- lote vencido.
- serial duplicado.
- combo con componentes insuficientes.

## Dependencias
- Inventory
- Pricing
- Tax
