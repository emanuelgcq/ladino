# Multitenancy y RBAC

## Jerarquía
tenant → company → branch → warehouse/register.

## Claims
JWT mínimo:
- user_id
- tenant memberships
No confiar en claims estáticos para permisos críticos de larga vida; consultar policy cache/DB.

## Tablas
`memberships`, `roles`, `permissions`, `role_permissions`, `user_role_assignments`, `scope_bindings`.

## RLS
Toda tabla tenant-owned:
```sql
tenant_id uuid not null
company_id uuid null
```

RLS valida membership y scope. **La API y el worker NO usan `service_role` ni `postgres`**
(ADR-0031, desde la migración 14): se conectan como `ladino_api` y `ladino_worker`, roles sin
`BYPASSRLS`. `ladino_api` tiene policies propias por **tenant del actor** (el GUC
`ladino.actor_id`, leído solo por las funciones de servicio (`platform.ladino_service_actor_id()`)): un `where` olvidado en un caso de uso
no cruza tenants. `ladino_worker` solo tiene GRANT sobre `outbox` e `idempotency_keys`.
`service_role` queda para operaciones de plataforma que aún no existen (ADR-0030) — y cada una
será una decisión.

## Permisos
Formato: `resource.action`, ej:
- `invoice.issue`
- `journal.post`
- `period.close`
- `supplier.bank_account.approve`
- `fiscal.audit.read`

### El paso interior lo autoriza la operación que lo contiene (ADR-0068)
Un caso de uso compuesto no vuelve a pedir el permiso de cada paso de otro módulo. Cada función de
dominio que hace un paso ajeno tiene dos entradas: la pública, con su permiso propio, para la ruta
suelta; y la interna, que usa el caso de uso que la contiene:

| Operación | Paso interior | Lo autoriza | Entrada interna |
|---|---|---|---|
| Vender (`emitirVenta`, caja) | salida de kardex | `sales.invoice.issue` sobre la empresa **y** sobre el almacén (`ladino_user_has_scope`) | `issueStockBatchForSale` |
| Confirmar una devolución | reingreso al kardex | `sales.return.manage` sobre la empresa y el almacén | `receiveStockFor(…, "sales.return.manage")` |
| Recibir una compra (`receiveGoods`) | entrada al kardex | `purchase.receive` sobre la empresa y el almacén | `receiveStockFor(…, "purchase.receive")` |
| Alta simple con existencia | entrada inicial al kardex | `product.manage` sobre la empresa y el almacén | `receiveStockFor(…, "product.manage")` |
| Anular una venta | reversa del asiento | `sales.invoice.annul` | `reverseJournalEntryForAnnulment` |
| Alta simple / importación de productos | lista y precio | `product.manage` | `createPriceListForProduct` · `setPriceForProduct` |

No son pasos interiores, y por eso siguen con la entrada pública: la llegada «ya era mía»
(`registerArrival` sin proveedor), cuyo único permiso ES la entrada (`inventory.move`), y el consumo
de una receta (`consumeRecipe`), que solo corre por la ruta de inventario.

Consecuencia aceptada: un rol que vende saca mercancía sin tener `inventory.move`; un rol de venta
NO acotado (el cajero, el Dueño) vende desde cualquier almacén de su empresa, y uno acotado
(encargado, administrativo) solo desde los almacenes de sus bindings.

### Roles por empresa y Titular de la cuenta (ADR-0068 §3, N-02)
- Quien tiene `membership.manage` / `membership.read` sobre la empresa de la cabecera (por una
  asignación de esa empresa o de nivel tenant) gestiona a las personas de **esa** empresa
  (`packages/domain/src/members.ts`).
- El **Titular de la cuenta** es quien tiene una asignación de nivel tenant (`company_id` nulo):
  el fundador. Ve y gestiona la cuenta entera, como antes.
- Un gestor acotado a la empresa: ve a las personas con asignación en su empresa (y al Titular),
  con solo las asignaciones de esa empresa; quita roles solo de su empresa; **no** quita roles ni
  desactiva al Titular (`403 MEMBER_PROTECTED`); solo cambia el acceso de quien tiene rol en su
  empresa (si no, 404) y no tiene roles en empresas que él no gestiona (`403 MEMBER_PROTECTED`: la
  membresía es de la cuenta, desactivarla corta todas). La misma guarda vale al REACTIVAR a alguien
  agregándolo. Una asignación de otra empresa responde 404 antes que cualquier `MEMBER_PROTECTED`.
- Agregar a alguien como `owner` le da también `warehouse_ops` acotado a la empresa, con bindings
  a sus almacenes, como al fundador (ADR-0049).
- La web marca «Titular» junto al rol de nivel tenant y no ofrece quitarle roles ni desactivarlo a
  quien no es Titular.

### Un 403 se dice en palabras de persona
`person_message` de un `PERMISSION_REQUIRED` es «Necesitas el permiso para <acción>. Pídeselo a
quien administra el negocio.», con la acción sacada de `ACCION_DE_PERMISO`
(`apps/api/src/middleware/errors.ts`). La clave técnica solo viaja en `message`.

## Segregación
Configurable SoD:
- creador de pago != aprobador;
- creador proveedor != aprobador cuenta bancaria;
- cajero != cierre supervisor.
