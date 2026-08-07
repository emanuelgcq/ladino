import { describe, expect, it } from "vitest";
import {
  all,
  andThen,
  compareInstants,
  err,
  isErr,
  isOk,
  map,
  ok,
  parseInstant,
  unwrap,
  unwrapOr,
} from "./index.js";

const boom = { code: "BOOM", message: "explotó" } as const;

describe("Result", () => {
  it("ok e isOk son coherentes", () => {
    const r = ok(1);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    expect(unwrap(r)).toBe(1);
  });

  it("err conserva el código, que es el contrato", () => {
    const r = err(boom);
    expect(isErr(r)).toBe(true);
    expect(r.ok ? null : r.error.code).toBe("BOOM");
  });

  it("map no toca el error", () => {
    expect(
      unwrapOr(
        map(err(boom), (n: number) => n + 1),
        -1,
      ),
    ).toBe(-1);
    expect(
      unwrapOr(
        map(ok(1), (n) => n + 1),
        -1,
      ),
    ).toBe(2);
  });

  it("andThen encadena y corta en el primer error", () => {
    const half = (n: number) => (n % 2 === 0 ? ok(n / 2) : err(boom));
    expect(unwrapOr(andThen(ok(4), half), -1)).toBe(2);
    expect(unwrapOr(andThen(ok(3), half), -1)).toBe(-1);
  });

  it("all se queda con el primer error", () => {
    expect(unwrapOr(all([ok(1), ok(2)]), [])).toEqual([1, 2]);
    const r = all([ok(1), err(boom), err({ code: "OTRO", message: "otro" })]);
    expect(r.ok ? null : r.error.code).toBe("BOOM");
  });
});

describe("Instant", () => {
  it("acepta ISO-8601 UTC", () => {
    expect(parseInstant("2026-08-07T13:45:00Z").ok).toBe(true);
    expect(parseInstant("2026-08-07T13:45:00.123Z").ok).toBe(true);
  });

  it("rechaza offsets, fechas sueltas y fechas imposibles", () => {
    // Un rate_timestamp con offset local no reproduce entre entornos (ADR-0020).
    expect(parseInstant("2026-08-07T13:45:00+04:00").ok).toBe(false);
    expect(parseInstant("2026-08-07").ok).toBe(false);
    expect(parseInstant("2026-02-30T00:00:00Z").ok).toBe(false);
    expect(parseInstant("").ok).toBe(false);
  });

  it("ordena cronológicamente", () => {
    const a = unwrap(parseInstant("2026-08-07T00:00:00Z"));
    const b = unwrap(parseInstant("2026-08-08T00:00:00Z"));
    expect(compareInstants(a, b)).toBe(-1);
    expect(compareInstants(b, a)).toBe(1);
    expect(compareInstants(a, a)).toBe(0);
  });
});
