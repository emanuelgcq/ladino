# Roadmap — Ladino

> **Actualizado 2026-08-15 por cambio regulatorio.** PA SNAT/2024/000121 derogada por
> PA SNAT/2026/00084 (Gaceta 43.435, 12/08/2026), sin sustituta. Estado completo en
> `docs/02_COMPLIANCE/REGULATORY_STATUS.md`; consecuencias de diseño en ADR-0027 y ADR-0028.
>
> **El cambio de fondo:** la emisión fiscal deja de ser un **gate de salida** y pasa a ser un
> **módulo más**. Ladino sin ella es un ERP administrativo, de inventario y contable, completo y
> vendible. Con ella, un ERP fiscal.

## Fase 0 — Legal y arquitectura
- Obtener asesoría tributaria. **Sigue vigente**: IVA, ISLR, retenciones e IGTF no dependían de
  la 121 y no cambiaron.
- ~~Reunión/consulta formal SENIAT sobre arquitectura web/mobile.~~ **Sin objeto (2026-08-15)**:
  no hay procedimiento de homologación al que consultar. Reabrir si se publica el régimen nuevo.
- ~~Definir entidad proveedora domiciliada en Venezuela.~~ **Sin objeto como bloqueante técnico**:
  era requisito del expediente de proveedor de la 121. Sigue siendo decisión de negocio para
  facturar, no para construir ni desplegar.
- ~~Confirmar alcance de Art. 8.3 de PA 121 para navegadores y dispositivos móviles.~~
  **RESUELTO 2026-08-15 por derogación.**
- Seleccionar imprenta digital. **Sigue vigente**: PA 102 no fue derogada.
- ~~Cerrar arquitectura de componente fiscal homologable.~~ → **Cerrar arquitectura de componente
  fiscal aislado.** La frontera se mantiene, con la justificación enmendada de ADR-0003:
  ya no es evitar rehomologar, es absorber volatilidad regulatoria.

## Fase 1 — Foundation
- Monorepo, CI/CD, Supabase, RLS, Auth.
- Tenant/empresa/sucursal/almacén/caja.
- RBAC.
- auditoría.
- catálogos maestros.

## Fase 2 — Administración
- Inventario.
- Ventas.
- Compras.
- CxC/CxP.
- Caja/bancos.
- Multimoneda.

## Fase 3 — Contabilidad
- Plan de cuentas.
- Posting engine.
- cierres.
- estados financieros.
- centros de costo.
- conciliación contable.

## Fase 4 — Fiscal
- IVA/retenciones/IGTF. **No dependía de la 121**: es tributario sustantivo y sigue igual.
- documentos digitales. **PA 071 y PA 102 vigentes**: lo que hace válida una factura no cambió.
- imprenta digital. **PA 102 vigente.**
- libros.
- auditoría SENIAT → **pista de auditoría y API de consulta**. Deja de ser requisito de
  homologación y sigue siendo requisito de producto (ADR-0027 §4).
- contingencia. **PA 102 y PA 071 vigentes.**
- ~~expedientes de homologación~~ → **transmisión al SENIAT** cuando exista protocolo (ADR-0028).
  El expediente de la 121 no tiene destinatario; la estructura de transmisión se deja lista.

## Fase 5 — Mobile/POS
- Expo.
- POS móvil.
- consultas operativas.
- contingencia fiscal solo si queda validada.

## Fase 6 — Avanzados
- activos fijos;
- ajuste por inflación;
- nómina/RRHH;
- IA asistida;
- BI y workflows.

## Gate de salida

~~No lanzar emisión fiscal productiva hasta completar autorización/homologación aplicable.~~
**Sin objeto desde 2026-08-15**: no hay autorización ni homologación que completar.

**Gate vigente**, que es más corto y no depende de ningún tercero:

No lanzar emisión fiscal productiva hasta que se cumplan **PA 071 y PA 102** —numeración
transaccional sin huecos, adaptador de imprenta digital, contingencia probada, y el mapeo
numeral→campo→validación del Art. 7 de PA 102— y hasta cerrar los `VALIDAR-SENIAT` que
**siguen abiertos** en `REGULATORY_STATUS.md` §5. Los seis que se cayeron con la 121 ya no
bloquean nada.

**Y el gate ya no bloquea el producto.** Todo lo demás —Fases 1, 2, 3, 5 y 6— es desplegable y
vendible sin él (ADR-0027 §1). Eso no era cierto antes del 12/08/2026.
