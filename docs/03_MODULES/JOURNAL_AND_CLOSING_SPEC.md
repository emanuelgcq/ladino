# Diario, periodos y cierre


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Controlar posting, cierres mensuales/anuales y reaperturas auditadas.

## Entidades
- `accounting_periods`
- `closing_checklists`
- `closing_entries`

## Reglas de negocio
- No post en periodo cerrado.
- Reapertura requiere permiso/motivo.
- Cierre verifica subledgers.
- Asientos cierre son trazables.

## Estados / transiciones
period open→soft_closed→closed→reopened.

## Permisos
- contador cierra.
- CFO/aprobador reabre.
- auditor solo lee.

## API / eventos
- `POST /v1/periods/:id/close`
- `POST /v1/periods/:id/reopen`
- `period.closed`

## Criterios de aceptación
- [ ] No cerrar con documentos pendientes configurados.
- [ ] Reapertura queda auditada.
- [ ] Balance sigue cuadrado.

## Casos límite
- backdated transaction.
- cierre anual.
- ajuste auditor.

## Dependencias
- Accounting
- AR/AP
- Inventory
