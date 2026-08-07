# infra

Docker, Traefik y despliegue de Ladino en el VPS Hostinger.

## El VPS es compartido — esto manda sobre cualquier otra consideración

- **n8n no se toca.** Nunca. Ni reiniciar, ni actualizar, ni cambiar de red.
- **Traefik ya existe** y sirve a otros proyectos. Ladino solo añade labels y se une a la red
  externa del proxy. No se reinicia Traefik ni se reescribe su configuración estática.
- Todo el stack va bajo project name `ladino`. `docker compose -p ladino ...`.
  Nunca un `down` sin acotar, nunca `system prune`.
- Supabase es gestionado, **no** self-hosted aquí. La base fiscal no comparte host con
  automatizaciones.

## Reglas de contenedores

- Imágenes por digest, no `latest`.
- `healthcheck` y `restart: unless-stopped` en todos.
- Los volúmenes **nunca** son la única copia de un dato. Backup externo siempre.
- Solo 443 público. Postgres jamás expuesto. Panel de administración protegido.
- Salida permitida hacia imprenta digital y SENIAT.
- Secretos por variable de entorno del host o gestor de secretos, jamás en la imagen ni en git.

## Esta capa nunca ejecuta el deploy sola

Prepara archivos y **propone** comandos. El usuario aprueba y ejecuta.
