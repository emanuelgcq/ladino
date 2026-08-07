# Visión de producto — Ladino


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Problema

Las empresas venezolanas suelen operar ventas, compras, inventario, bancos, impuestos y contabilidad en herramientas separadas o sistemas heredados. Ladino busca centralizar esos procesos en una experiencia web/móvil moderna sin sacrificar controles contables ni fiscales.

## Propuesta

Una plataforma multiempresa capaz de:

- administrar ventas, compras, cuentas por cobrar/pagar, caja, bancos e inventario;
- producir contabilidad formal de partida doble;
- manejar multimoneda con trazabilidad de tasas;
- soportar IVA, retenciones, ISLR, IGTF y reglas tributarias versionadas;
- emitir documentos fiscales digitales dentro de un subsistema homologable;
- generar libros, auxiliares, reportes y exportaciones;
- ofrecer auditoría completa a usuario, contador y SENIAT;
- operar por web y móvil;
- usar IA como copiloto, jamás como motor autoritativo de impuestos o contabilidad.

## Diferenciadores

- Cloud-first real, no “desktop publicado por escritorio remoto”.
- UX consistente web/móvil.
- Fiscal ledger inmutable y verificable.
- Release train fiscal separado.
- Multiempresa y sucursal desde el núcleo.
- API-first.
- Integración con imprenta digital mediante adaptadores.
- Contabilidad explicable: cada asiento puede rastrearse al documento que lo generó.
- Configuración versionada por vigencia.
- Exportación total de datos del cliente.

## No objetivos

- Aplicación Windows/macOS local.
- Reemplazar asesoría legal o contable con IA.
- Permitir “arreglar” ventas eliminando o editando documentos fiscales.
- Hacer que el POS funcione sin control central de integridad.
