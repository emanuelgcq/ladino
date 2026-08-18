---
name: caso-de-uso
description: Escribir un caso de uso transaccional de dominio en Ladino (el patrón obligatorio para todo lo que crea dinero, stock o documentos). Úsalo cuando implementes cualquier operación con impacto financiero o fiscal.
---

# Caso de uso transaccional — Ladino

Ninguna UI persiste estado final. Todo pasa por este patrón.

## Secuencia obligatoria

```
1. autorizar        — permiso resource.action, empresa y sucursal en alcance
2. idempotencia     — buscar Idempotency-Key; si existe, devolver el resultado anterior
3. cargar + bloquear— SELECT ... FOR UPDATE de los agregados afectados
4. validar          — periodo abierto, estado permitido, stock disponible, crédito
5. calcular         — reglas de dominio puras (packages/*), con la versión de reglas vigente
6. persistir        — documento + líneas
7. impactar         — asiento contable, movimiento de inventario, ledger de pagos
8. auditar          — audit_event con autor, origen, versión de reglas
9. outbox           — insertar el evento en la misma transacción
10. commit
```

Los 10 pasos van **dentro de una sola transacción**. Si algo puede quedar a medias, está mal.

## Esqueleto

```ts
export async function issueInvoice(
  ctx: RequestContext,
  input: IssueInvoiceInput,
): Promise<Result<Invoice, DomainError>> {
  return ctx.db.transaction(async (tx) => {
    await requirePermission(ctx, 'invoice.issue', input.companyId);

    const existing = await findByIdempotencyKey(tx, ctx.idempotencyKey);
    if (existing) return ok(existing.result);

    const period = await lockOpenPeriod(tx, input.companyId, input.fiscalDate);
    if (!period) return err(new PeriodClosedError());

    const rules = await getRuleSetAt(tx, input.companyId, input.fiscalDate); // versionado
    const computed = computeInvoice(input, rules);   // puro, Decimal, testeable

    const invoice = await insertInvoice(tx, computed);
    await postJournalEntry(tx, buildEntry(computed, rules));
    await recordInventoryMoves(tx, computed.lines);
    await writeAuditEvent(tx, ctx, 'invoice.issued', invoice.id, rules.version);
    await enqueueOutbox(tx, 'invoice.issued', invoice.id);
    await saveIdempotency(tx, ctx.idempotencyKey, invoice);

    return ok(invoice);
  });
}
```

## Reglas

- El cálculo (`computeInvoice`) es **puro**: sin I/O, sin `Date.now()`, sin random.
  Recibe reglas y reloj como parámetros. Así es testeable y reproducible en una auditoría.
- Errores de dominio como valores (`Result`), no excepciones de control de flujo.
- Nada de `number` en montos. `Decimal` de `packages/money`.
- La asignación de número fiscal ocurre en el paso 6 y es transaccional. Nunca antes.

## La idempotencia acota la ventana; la clave natural la cierra

**Toda operación crítica necesita LAS DOS, y asumir que con `Idempotency-Key`
basta es el malentendido más fácil de cometer al copiar la plantilla.**

El borde exacto (medido en S0.5, escrito también en `idempotency.ts` y en
`ENGINEERING_STANDARDS.md`): si el proceso muere después de que el caso de uso
commiteara y antes de que T2 cerrara la clave, la reserva queda `in_progress`.
Dentro del TTL, el reintento recibe 409 y nada se duplica. **Pasado el TTL, el
reintento reejecuta el cuerpo entero** — y lo único que impide el doble efecto
es la restricción única natural del esquema:

| Operación | Su clave natural |
|---|---|
| crear empresa | `unique (tenant_id, tax_id)` |
| emitir factura | número fiscal por serie, asignado transaccionalmente |
| postear asiento | `source_type + source_id + event` (ACCOUNTING_ENGINE_SPEC) |
| registrar pago | la que el módulo defina — **si no existe, hay que crearla ANTES del endpoint** |

Una operación crítica sin clave natural única tiene un doble efecto programado
para 24 horas después de su primer fallo de infraestructura.

## Tests que acompañan siempre

- property-based: para cualquier input válido, `sum(debit) === sum(credit)`;
- idempotencia: dos llamadas con la misma key producen un solo efecto;
- **la clave natural, ejercida**: la reejecución directa del cuerpo (sin pasar
  por la idempotencia) muere en el único del esquema — es el test de que la
  segunda defensa existe, no solo la primera;
- concurrencia: dos llamadas simultáneas no duplican número fiscal ni stock negativo;
- periodo cerrado: rechaza.
