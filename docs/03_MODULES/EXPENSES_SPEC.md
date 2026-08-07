# Gastos


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Registrar gastos operativos con evidencia, impuestos y aprobación.

## Entidades
- `expenses`
- `expense_categories`
- `expense_attachments`
- `expense_approvals`

## Reglas de negocio
- Gasto puede generar CxP o pago inmediato.
- Soporte obligatorio por política.
- Duplicados detectados por proveedor/fecha/número/monto.

## Estados / transiciones
draft→submitted→approved→posted/paid→rejected.

## Permisos
- empleado crea.
- manager aprueba.
- contador postea.

## API / eventos
- `POST /v1/expenses`
- `POST /v1/expenses/:id/approve`

## Criterios de aceptación
- [ ] Workflow por monto.
- [ ] Attachment preservado.
- [ ] Posting balanceado.

## Casos límite
- reembolso.
- gasto en divisa.
- factura duplicada.

## Dependencias
- AP
- Accounting
- Storage
