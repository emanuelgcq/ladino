# Product Requirements Document (PRD) — Ladino


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Usuarios

- Dueño/administrador.
- Contador interno.
- Firma contable multiempresa.
- Cajero/POS.
- Vendedor.
- Comprador.
- Almacenista.
- Tesorería.
- Cobranzas.
- Auditor interno.
- Usuario de consulta SENIAT.
- RRHH/Nómina.
- Superadministrador SaaS.

## Requisitos funcionales P0

1. Tenants, empresas, sucursales, almacenes y cajas.
2. Usuarios, roles y permisos finos.
3. Clientes, proveedores y datos fiscales.
4. Productos/servicios, unidades, impuestos, variantes, lotes, seriales, vencimiento.
5. Precios, listas, descuentos autorizados y multimoneda.
6. Cotización → pedido → entrega → factura.
7. POS.
8. CxC, cobranzas y aplicación de pagos.
9. Orden de compra → recepción → factura.
10. CxP y pagos.
11. Inventario y kardex.
12. Caja y bancos.
13. Conciliación.
14. Contabilidad general.
15. Centros de costo.
16. Cierres y reaperturas controladas.
17. IVA, retenciones, ISLR e IGTF parametrizables/versionados.
18. Documentos fiscales digitales.
19. Notas de crédito/débito.
20. Guías/órdenes de entrega.
21. Comprobantes de retención.
22. Libros de compras/ventas.
23. Auditoría fiscal.
24. Reportes financieros y operativos.
25. Import/export.
26. Backups y recuperación.
27. App móvil Expo.
28. Webapp.
29. API.
30. Integración de imprenta digital.
31. Registro de eventos fiscales.
32. Mecanismo de acceso SENIAT conforme a evaluación/homologación.

## Requisitos P1

- Activos fijos.
- Ajuste por inflación fiscal/financiero.
- Nómina.
- RRHH.
- Comisiones.
- Presupuestos.
- Flujo de caja proyectado.
- Workflows y alertas.
- BI.
- OCR asistido para compras, con validación humana.
- Conciliación bancaria asistida.
- Portal cliente/proveedor.
- E-commerce/orden remota.

## Requisitos no funcionales

| Área | Objetivo |
|---|---|
| Integridad | 0 documentos fiscales emitidos editables |
| Contabilidad | 100% asientos posted balanceados |
| Idempotencia | Reintento seguro en emisión/pagos |
| Disponibilidad | objetivo inicial >=99.9% para emisión cloud, sujeto a infraestructura |
| RPO | <= 15 min para datos operativos; fiscal deberá elevarse según diseño final |
| RTO | <= 2 h inicial; fiscal y contingencia se validan en homologación |
| Seguridad | MFA para roles críticos; RLS; cifrado en tránsito y reposo |
| Auditoría | registro append-only de eventos críticos |
| Rendimiento | p95 < 500 ms lecturas comunes; emisión depende de imprenta digital |
| Accesibilidad | WCAG 2.2 AA como objetivo web |

## KPI de producto

- tiempo mediano de venta en POS;
- tasa de documentos emitidos sin intervención manual;
- discrepancias de inventario;
- conciliaciones automáticas sugeridas/confirmadas;
- cierres contables sin excepción;
- tasa de reintentos fiscales exitosos;
- tiempo para generar Libro de Ventas/Compras;
- incidencias por actualización fiscal.
