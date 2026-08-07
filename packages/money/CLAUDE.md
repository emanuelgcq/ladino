# packages/money

Aritmética monetaria de Ladino. **Paquete puro: sin I/O, sin fecha del sistema, sin red.**

## Contrato

- Tipo `Money { amount: Decimal; currency: CurrencyCode }`. Nunca un `number` suelto.
- `decimal.js` internamente. Precisión alineada con `numeric(24,8)` de Postgres.
- Serialización a JSON como `string`. `Money.toJSON()` nunca produce un número.
- El redondeo es **explícito y nombrado**: `roundForCurrency`, `roundForTax`, `roundForDocument`,
  `roundForPayment`. No existe un redondeo "por defecto" implícito.
- Conversión FX requiere `{ rate, source, timestamp }`. Una conversión sin origen no compila.
- Se conservan valores pre-redondeo cuando la auditoría los necesita.

## Tests

Property-based obligatorio. Como mínimo:
- asociatividad y conmutatividad de la suma en el rango soportado;
- `0.1 + 0.2 === 0.3` exacto;
- redondeo half-even vs half-up documentado y probado por moneda;
- ida y vuelta de serialización sin pérdida;
- una conversión FX y su inversa con la misma tasa recuperan el original dentro de tolerancia declarada.
