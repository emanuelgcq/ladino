# Notificaciones y workflows


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Automatizar recordatorios/aprobaciones sin permitir bypass de dominio.

## Entidades
- `workflow_definitions`
- `workflow_runs`
- `notifications`

## Reglas de negocio
- Workflow llama casos de uso; no escribe tablas críticas directamente.
- Cada acción queda auditada.
- Retries idempotentes.

## Estados / transiciones
workflow active/inactive; run queued→running→done/failed.

## Permisos
- admin configura.
- usuario recibe/actúa.

## API / eventos
- `POST /v1/workflows`
- `workflow.triggered`

## Criterios de aceptación
- [ ] No duplicar pago/factura por retry.
- [ ] Escalamiento funciona.

## Casos límite
- ciclo infinito.
- destinatario inactivo.
- regla cambia.

## Dependencias
- Outbox
- Notifications
