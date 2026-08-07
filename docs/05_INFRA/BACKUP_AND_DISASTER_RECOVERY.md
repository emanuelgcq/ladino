# Backup y Disaster Recovery

## Capas
1. backup administrado Supabase;
2. dump lógico cifrado;
3. storage/object backup;
4. export de fiscal/audit;
5. copia offsite.

## Objetivos iniciales
- RPO operacional <=15 min objetivo.
- RTO <=2h objetivo.
Ajustar luego de BIA y requisitos fiscales.

## Pruebas
Restore trimestral mínimo; antes de homologación ejecutar full DR simulation.

## Inmutabilidad
Mantener backups protegidos contra borrado por credenciales normales de app.
