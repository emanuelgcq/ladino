# Seguridad

## Baseline
- TLS.
- MFA para roles críticos.
- sesiones cortas + refresh seguro.
- RBAC + RLS.
- secrets en secret manager/env del runtime, nunca repo.
- cifrado en reposo proporcionado por infraestructura + cifrado de campos altamente sensibles si procede.
- rate limiting.
- CSP web.
- secure storage mobile.
- dependency scanning.
- SAST/DAST.
- pentest antes de homologación/producción.

## Supabase
- anon key puede estar en cliente; RLS debe proteger.
- service role jamás en web/mobile.
- policies testeadas.
- Storage buckets privados por defecto.

## API
- idempotency keys.
- replay protection en webhooks.
- firmas de proveedores cuando existan.
- allow-list para endpoints de administración SENIAT si el esquema final lo permite.

## Datos sensibles
- cuentas bancarias;
- documentos identidad;
- nómina;
- credenciales.
Aplicar minimización y field-level access.
