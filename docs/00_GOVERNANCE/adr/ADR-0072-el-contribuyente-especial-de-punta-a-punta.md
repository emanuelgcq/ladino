# ADR-0072 — El contribuyente especial, de punta a punta

- **Estado:** ADR aplicado según la respuesta del dueño del 2026-09-28 (§2.6; A-03, E-02, E-03,
  F-05, G-06, H-01, H-04, H-12, L-03, L-04, L-05, L-09, L-12, L-15)
- **Fecha:** 2026-09-28
- **Impacto fiscal:** SÍ.
- **Enmienda:** ADR-0052 (calendario sin fechas de fábrica), ADR-0053 (IGTF), ADR-0039 (retenciones)
  y ADR-0065 §3 (la retención nace al registrar, criterio R-3 ratificado el 2026-09-28).

## Contexto

El recorrido encontró que el camino del sujeto pasivo especial (SPE) está roto de punta a punta:

- **A-03:** el tipo no se pregunta.
- **E-02:** sin declararlo, el IGTF se omite en silencio.
- **E-03:** cuando se percibe, la factura no lo imprime.
- **F-05:** el IGTF «además» registra dinero que no entró.
- **H-01:** la retención de IVA nunca se practica desde la web.
- **H-04:** el comprobante de retención no existe como documento.
- **L-03:** el TXT de retenciones no sigue el instructivo.
- **L-04:** la declaración se propone por mes.
- **L-05:** el excedente mezcla crédito y retenciones.

La norma que aplica está en `docs/02_COMPLIANCE/REGULATORY_STATUS.md` §2-bis y en la respuesta del
dueño, §1: LIGTF y PA SNAT/2022/000013; PA SNAT/2025/000054; PA SNAT/2025/000091; e instructivo del
TXT.

## Decisión

1. **El tipo de contribuyente se declara y tiene vigencia.** Los tipos son `ordinario`, `especial`,
   `formal` y `no_contribuyente`.
   - Para el especial se piden la fecha de notificación de la providencia y la fecha desde la que
     rige (por omisión, la de notificación, corregible con acta).
   - La historia es append-only.
   - Sin tipo declarado no se factura: nunca «ordinario por omisión».
   - Una empresa sin RIF es `no_contribuyente` (D-01).
   - «Formal» se oculta mientras la periodicidad de la PA 1677 esté pendiente de fuente (M-10, P-38).
2. **IGTF.** Todo pago en divisas o cripto a un SPE percibe el 3 % sobre lo pagado en divisas,
   contra **cualquier** documento.
   - La caja lo suma al total. Nunca se registra dinero que no entró.
   - La factura imprime la alícuota y el monto (PA 000013 art. 6), en divisa y en Bs.
   - Hay un ajuste `absorber_igtf`, apagado por omisión.
   - El cobro posterior a la factura se documenta con una **Nota de Débito por IGTF**: sin IVA, no
     sujeta, consume control, y va al libro con base 0 (P-40).
   - La devolución deja el IGTF percibido y enterado, y el reembolso lo excluye. Solo la anulación
     lo hace indebido, con restitución y reintegro (P-31).
3. **Retención de IVA que practicamos.**
   - Se practica sola cuando la empresa es agente (SPE) y el proveedor es ordinario o especial.
   - Nace al **registrar** la factura (abono en cuenta, criterio R-3).
   - Es del 75 %, o del 100 % en los casos del art. 5.
   - Las exclusiones del art. 3 son data (`retention_exclusions`). La persona puede marcar una, con
     motivo auditado.
   - Es un cambio de contrato de la API, versionado.
4. **Comprobante de retención.** Es un documento propio (`retention_vouchers`).
   - Numeración `AAAAMM` + secuencial de 8 por empresa.
   - Contenido del art. 16.
   - Uno por operación, u opcionalmente uno por quincena y proveedor.
   - Se emite al practicar la retención y se entrega dentro de los 2 días hábiles del período
     siguiente.
   - Tiene PDF.
   - Va al libro de compras en el período de emisión, con su número, fecha e IVA retenido (H-12).
   - Corregirlo emite una versión nueva y anula la anterior, con rastro.
5. **Retenciones que nos practican.**
   - Se cargan en Bs contra la factura, con un número de 14 dígitos único por cliente.
   - El monto es el 75 % o el 100 % del IVA en Bs de la factura (± Bs 0,01).
   - Abonan la CxC **a la tasa de la factura**, sin diferencial; la alternativa, como parámetro, es
     P-30.
   - Las carga quien cobra (`ar.retention.register`) y las corrige el contador
     (`ar.retention.correct`).
6. **TXT de retenciones.** Tiene exactamente los 16 campos del instructivo, en su orden, con el
   campo 11 = IVA retenido. Un fixture aprobado lo prueba.
7. **Declaración.**
   - El SPE declara por quincena (PA 000091), y el ordinario por mes.
   - Los débitos van por la fecha de la factura, los créditos por la fecha de la factura de compra
     (o de recepción si llegó tarde) y las retenciones soportadas por la fecha del comprobante.
   - Hay dos arrastres separados: `excedente_credito_fiscal` y
     `retenciones_acumuladas_por_descontar` (P-37).
8. **Calendario** (enmienda ADR-0052).
   - La PA 000091 se siembra como data de plataforma con su fuente.
   - Las celdas pendientes de cotejo con la Gaceta (`CALENDARIO_SPE_2026.md` ⚠) quedan marcadas y
     no se ofrecen en pantalla hasta cotejarlas.
   - La quincena la calcula el servidor (L-15).
9. **Nombres** (L-12): «Retenciones que practicamos (a proveedores)» y «Retenciones que nos
   practicaron (clientes)».

## Consecuencias

- **Positivas.** El SPE factura, percibe, retiene, documenta y declara como exige la norma, y cada
  regla es data con su cita.
- **Negativas.**
  - Hay tablas nuevas: vigencias de tipo, exclusiones, comprobantes y calendario.
  - Hay contratos nuevos en la API: la retención automática y la ND por IGTF.
  - Un SPE ya existente sin fechas de calificación tiene que completarlas antes de su próxima
    factura (en producción no hay clientes reales).
- **Para revertir:** las reglas son data. Apagar la retención automática devuelve la carga manual,
  y los comprobantes emitidos quedan.

## Verificación

- E2E: un SPE cobra en divisas y la factura imprime el IGTF; el cobro posterior emite la ND por
  IGTF; una compra a un ordinario retiene al registrar y emite el comprobante.
- El TXT contra el fixture.
- `pnpm recorrido E`, `F`, `H` y `L`: los hallazgos de la familia dejan de reproducir.

## Nota de aplicación — parte 1 (tipo y retenciones soportadas, 2026-10-02)

Migraciones 20260928190000, 190100 y 190200. Decidido por criterio (respuesta del dueño §2.16),
cada punto con su alternativa:

0. **`formal` no se declara ni emite hasta construir M-10** (auditoría fiscal, hallazgo 8; PA 00071
   art. 15, P-38). El dominio lo rechaza con 422 y el CHECK de la historia admite solo
   {ordinario, especial} (migración 20260928190300). **Se reabre con M-10.** *Alternativa:*
   aceptarlo y tratar su IVA de compras al costo sin su periodicidad.
1. **`no_contribuyente` nunca se declara**: se deriva de no tener RIF (`platform.taxpayer_type_at`).
   El caso de uso lo rechaza con 422, la historia lo prohíbe con un CHECK, y la emisión exige un
   tipo en {ordinario, especial, formal}. Una empresa que pasa de sin RIF a con RIF declara su
   tipo antes de su primera factura. *Alternativa:* permitir declararlo con RIF.
   VALIDAR-TRIBUTARIO P-56.
2. **El IGTF sigue la vigencia**: la percepción exige que la empresa sea `especial` el día del
   cobro, además del acta de activación. *Alternativa:* apagar el acta al registrar una vigencia
   futura.
3. **La lectura del tipo no exige permiso**: la hace cualquier miembro de la empresa, porque la
   web decide flujos con ella. *Alternativa:* exigir `company.settings.manage`.
4. **Declaración retroactiva** (norma primero: la calificación rige desde la notificación): se
   admite con acta. Si hay documentos fiscales emitidos desde esa fecha, la respuesta, el acta y
   la pantalla dicen cuántos; no se reemiten y hay que consultar al asesor. *Alternativa:*
   prohibir fechas anteriores al último documento emitido.
5. **La puerta, también en la base**: `assert_document_issuance` rechaza con LAD98 una factura,
   NC o ND sin tipo vigente, sea cual sea el actor. *Alternativa:* solo el dominio.
6. **La retención soportada abona a la tasa de la factura** (`ar_valuation`); la tasa del
   comprobante queda como parámetro apagado (P-30). Su **reversa no está construida**: es
   semántica del dinero (R-61). La carga es de quien cobra: dueño, administrativo y cajero
   (§2.6). El encargado no cobra (§2.8) y no la tiene (migración 20260928190600). El comprobante
   es único por cliente y factura, porque uno quincenal cubre varias (PA 000054 art. 16), y sus
   porciones salen de `iva_retention_portions`, de fuente secundaria (VALIDAR-SENIAT).
