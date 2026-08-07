# Registro de riesgos

| Riesgo | Severidad | Mitigación |
|---|---:|---|
| Interpretación Art. 8.3 PA121 respecto a dispositivos no homologados | Crítica | VALIDAR-SENIAT antes de POS/mobile fiscal |
| Cambio fiscal requiere nueva homologación | Crítica | release train fiscal aislado |
| Dependencia de imprenta digital | Alta | adapter + proveedor secundario si es viable |
| Caída de internet | Alta | plan de contingencia conforme PA102 |
| Errores de redondeo | Alta | decimal + tests golden |
| RLS incorrecta filtra tenant | Crítica | pruebas automáticas de aislamiento |
| Claude sugiere asiento/impuesto incorrecto | Alta | aprobación humana + motor determinista |
| Actualización móvil no coordinada | Alta | feature flags y compatibilidad de protocolo |
| Secuencias duplicadas | Crítica | asignación transaccional/locking |
| Pérdida de audit logs | Crítica | append-only + backup + hash |
| Hostinger sin SLA suficiente para fiscal | Alta | evaluar plan/arquitectura y failover |
| Norma tributaria cambia | Alta | tax rules versionadas |
