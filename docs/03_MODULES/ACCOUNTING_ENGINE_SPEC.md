# Motor contable


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Convertir eventos de negocio en asientos de partida doble deterministas.

## Entidades
- `journal_entries`
- `journal_lines`
- `posting_rules`
- `account_mappings`
- `accounting_periods`

## Reglas de negocio
- Suma débitos=créditos.
- Posted immutable.
- Regla de posting versionada.
- Idempotencia por source_type/source_id/event.
- Cuenta debe admitir movimiento.

## Estados / transiciones
draft→validated→posted→reversed.

## Permisos
- contador puede postear/manual.
- operación genera automáticos.
- admin no bypass invariantes.

## API / eventos
- `POST /v1/accounting/journals`
- `POST /v1/accounting/journals/:id/post`
- `POST /v1/accounting/journals/:id/reverse`
- `journal.posted`

## Criterios de aceptación
- [ ] DB impide posted desbalanceado.
- [ ] Mismo evento no duplica asiento.
- [ ] Reversión exacta.

## Casos límite
- periodo cerrado.
- moneda extranjera.
- centros de costo.
- asiento manual.

## Dependencias
- Chart
- Money
- Audit
