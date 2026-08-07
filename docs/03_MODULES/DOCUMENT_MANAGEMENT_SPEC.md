# Gestión documental


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Guardar soportes, PDFs, XML/TXT y documentos asociados.

## Entidades
- `documents`
- `document_versions`
- `document_links`

## Reglas de negocio
- Hash SHA-256 por objeto como control técnico.
- Versionar archivos reemplazables.
- Documentos fiscales emitidos no se sustituyen.

## Estados / transiciones
uploaded→verified→archived.

## Permisos
- según entidad/rol.
- fiscal audit read.

## API / eventos
- `POST /v1/files`
- `GET /v1/documents/:id`

## Criterios de aceptación
- [ ] URL firmada expira.
- [ ] Hash valida integridad.
- [ ] Tenant aislado.

## Casos límite
- archivo grande.
- virus.
- duplicado.

## Dependencias
- Storage
- Security
