# ADR-0008 — Servicios en Docker sobre VPS Hostinger, detrás del Traefik existente

- **Estado:** Aceptado (por producto) · **Fecha:** 2026-08-07 · **Impacto fiscal:** NO

## Contexto
El VPS ya está en producción con Traefik y n8n sirviendo otros proyectos del equipo.
Ladino no puede alterar esa infraestructura.

## Decisión
`ladino-api`, `ladino-worker` y `ladino-fiscal` como contenedores bajo project name `ladino`,
unidos a la red externa del proxy. Se **añaden labels** a Traefik; no se reconfigura ni reinicia.
Imágenes por digest. La webapp se sirve como estático detrás del mismo proxy.

## Consecuencias
- (+) Coste bajo y despliegue reproducible, aprovechando infraestructura existente.
- (−) Blast radius compartido: un consumo desmedido de recursos por parte de Ladino afecta a
  n8n. Se mitiga con límites de CPU y memoria por contenedor, obligatorios.
- (−) Sin alta disponibilidad real en un solo VPS. Aceptable para las fases iniciales;
  el objetivo de 99.9% para emisión fiscal exige revisitar esto antes de producción fiscal.

## Verificación
`docker stats` bajo carga de prueba muestra que Ladino respeta sus límites.
