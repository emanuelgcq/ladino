# Preguntas abiertas / blockers

## SENIAT

> **Revisado 2026-08-15.** PA SNAT/2024/000121 derogada por PA SNAT/2026/00084 (Gaceta 43.435,
> 12/08/2026), **sin sustituta**. Seis de las ocho preguntas se caen con ella.
>
> **Resuelto aquí significa disuelto, no contestado**: la norma que generaba la pregunta ya no
> está en vigor. Se tachan y no se borran — si un régimen nuevo reintroduce la homologación,
> vuelven exactamente como están escritas. Mapa completo en
> `docs/02_COMPLIANCE/REGULATORY_STATUS.md` §5.

1. ~~`VALIDAR-SENIAT`: alcance práctico del Art. 8 numeral 3 de PA121 para web browsers, teléfonos y tablets conectados al sistema.~~
   **RESUELTO 2026-08-15** — PA SNAT/2026/00084. El Art. 8 era de la 121.
2. `VALIDAR-SENIAT`: **formato/protocolo de remisión de registros.** ~~previsto por PA121~~
   **Reformulada 2026-08-15**: la obligación concreta de la 121 cae, pero la normativa esperada
   apunta a **protocolos de comunicación**. Pasa de obligación vigente a **requisito anticipado**.
   No se implementa nada contra una norma que no existe; la estructura queda lista (ADR-0028).
3. ~~`VALIDAR-SENIAT`: mecanismo exacto de “clave de consulta” y acceso a API.~~
   **RESUELTO 2026-08-15** — era el Art. 3 numeral 8 de la 121.
4. ~~`VALIDAR-SENIAT`: si la separación de bounded contexts permite actualizar módulos no fiscales sin rehomologar.~~
   **RESUELTO 2026-08-15** — no hay rehomologación que evitar. La separación **se mantiene** con
   otra justificación: absorber volatilidad regulatoria (enmienda de ADR-0003).
5. ~~`VALIDAR-SENIAT`: procedimiento actualizado para SaaS multitenant.~~
   **RESUELTO 2026-08-15** — era el procedimiento de autorización de proveedores de la 121.
6. ~~`VALIDAR-SENIAT`: si una versión web desplegada continuamente puede homologarse por identificador de build/commit.~~
   **RESUELTO 2026-08-15** — no hay acto de homologación al que asociar un build.
7. ~~`VALIDAR-SENIAT`: requisitos específicos de infraestructura cloud fuera/dentro de Venezuela.~~
   **RESUELTO 2026-08-15** — venía de los requisitos de proveedor de la 121.
8. `VALIDAR-SENIAT`: requisitos de contingencia móvil/offline en SaaS.
   **SIGUE ABIERTA**: no dependía de la 121. La sostienen **PA 102 y PA 071**, ambas vigentes.

### Abiertas y no derivadas de la 121

9. `VALIDAR-SENIAT`: **formato del RIF** — estructura, prefijos admitidos y dígito verificador.
   Necesario para el mapeo numeral→campo→validación del Art. 7 de PA 102. Reforzado por
   PA SNAT/2026/00080, que reforma el RIF: deja de caducar, pero debe actualizarse ante cambios de
   datos. **Hasta la respuesta: ningún regex de RIF, ni en Postgres ni en Zod.**
10. `VALIDAR-SENIAT`: **emisión en dos fases con imprenta digital** — qué cuenta como «documento
    emitido» si la imprenta responde tras un timeout y el cliente ya reintentó. PA 102 vigente.
11. `VALIDAR-SENIAT`: **cambio de RIF con documentos ya emitidos** — si exige procedimiento,
    notificación o tratamiento particular de esos documentos. Determina si M4 debe además
    **bloquear** el cambio o basta con auditarlo. Toca PA SNAT/2026/00080.

## Tributario
- tasas y supuestos vigentes de IVA/IGTF/retenciones;
- formatos actuales de archivos de declaración;
- conservación legal por tipo de documento más allá del acceso digital de 10 años de PA102;
- reglas de prorrata;
- contribuyentes especiales;
- factura por cuenta de terceros.

## Producto
- primera imprenta digital;
- verticales iniciales;
- nómina P1 o P2;
- soporte de balanzas/impresoras fiscales físicas.
