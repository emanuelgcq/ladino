/**
 * Estanqueidad — ninguna vía publica un importe sin redondear.
 *
 * Este fichero existe porque la primera versión de ADR-0023 razonaba así: "`ExactMoney` no tiene
 * `toJSON`, luego no se puede publicar". Falso, y por partida triple. `JSON.stringify` enumera
 * las propiedades propias aunque no haya `toJSON`; el spread y `Object.entries` ni siquiera
 * pasan por ahí.
 *
 * **Ausencia de mecanismo no es prohibición.** Cada vía de salida se prueba una por una, porque
 * la única forma de saber que una puerta está cerrada es empujarla.
 */
import { describe, expect, it } from "vitest";
import {
  ExactMoney,
  Money,
  parseCurrency,
  parseDecimal,
  roundForCurrency,
  roundForTax,
} from "../src/index.js";
import { must } from "./arbitraries.js";

/** Los dígitos no deben aparecer en NINGUNA salida, en ninguna forma. */
const DIGITS = "1.23456789012345";

const exacto = () =>
  must(ExactMoney.fromDecimal(must(parseDecimal(DIGITS)), must(parseCurrency("VES"))));

describe("ExactMoney no tiene ninguna vía de publicación", () => {
  it("JSON.stringify lanza en vez de publicar", () => {
    expect(() => JSON.stringify({ total: exacto() })).toThrow(/no se serializa/i);
  });

  it("el spread no copia nada: {...exactMoney} está vacío", () => {
    // Con propiedades propias esto producía {"amount":"1.23456789012345","currency":"VES"},
    // saltándose toJSON por completo. Campos privados con getter: no hay nada que copiar.
    const copia = { ...exacto() };
    expect(Object.keys(copia)).toEqual([]);
    expect(JSON.stringify(copia)).toBe("{}");
    expect(JSON.stringify(copia)).not.toContain(DIGITS);
  });

  it("Object.entries y Object.keys no ven el importe", () => {
    expect(Object.entries(exacto())).toEqual([]);
    expect(Object.keys(exacto())).toEqual([]);
    expect(Object.values(exacto())).toEqual([]);
  });

  it("Object.assign a un objeto plano no arrastra el importe", () => {
    const destino = Object.assign({}, exacto());
    expect(JSON.stringify(destino)).not.toContain(DIGITS);
  });

  it("structuredClone no produce una forma publicable", () => {
    // Lanza DataCloneError (no es un tipo clonable) o clona sin propiedades. Ninguna de las dos
    // publica el importe; lo que no vale es que devuelva {amount, currency}.
    let salida: string;
    try {
      salida = JSON.stringify(structuredClone(exacto()));
    } catch {
      salida = "";
    }
    expect(salida).not.toContain(DIGITS);
  });

  it("toString identifica el valor como no redondeado, no lo disfraza de importe", () => {
    // Es diagnóstico: lleva los dígitos, pero también dice a gritos lo que es. Nadie lo va a
    // confundir con un payload.
    expect(exacto().toString()).toContain("exacto, sin redondear");
  });
});

describe("RoundedMoney cruza capas sin publicar el pre-redondeo", () => {
  const redondeado = () =>
    must(roundForTax(exacto(), { id: "test:HALF_EVEN:2", scale: 2, mode: "HALF_EVEN" }));

  it("serializar el RoundedMoney entero lanza: preRound es ExactMoney", () => {
    // Es el punto que más importa de todos: `RoundedMoney` SÍ está pensado para cruzar capas,
    // y lleva dentro el valor sin redondear. Si `JSON.stringify` de la estructura completa lo
    // publicara, el resto de las defensas no serviría de nada.
    expect(() => JSON.stringify(redondeado())).toThrow(/no se serializa/i);
  });

  it("el spread del RoundedMoney tampoco lo publica", () => {
    const copia = { ...redondeado() };
    expect(() => JSON.stringify(copia)).toThrow(/no se serializa/i);
  });

  it("lo que sí se publica es `value`, y en forma canónica", () => {
    // La proyección tiene que ser explícita. Esa es toda la idea.
    expect(JSON.stringify(redondeado().value)).toBe('{"amount":"1.23000000","currency":"VES"}');
  });

  it("la política aplicada sigue siendo legible: la trazabilidad no se pierde", () => {
    const r = redondeado();
    expect(JSON.stringify(r.policy)).toBe('{"id":"test:HALF_EVEN:2","scale":2,"mode":"HALF_EVEN"}');
  });
});

describe("Money solo se publica en forma canónica", () => {
  it("el spread no puede saltarse toAmountString", () => {
    // Con propiedades propias, {...money} daba {"amount":"1.005"} — ocho decimales de menos,
    // con toda la pinta de un payload válido. Un importe no canónico es peor que uno ausente:
    // el receptor no tiene forma de notar la diferencia.
    const m = must(Money.of("1.005", "VES"));
    const copia = { ...m };
    expect(Object.keys(copia)).toEqual([]);
    expect(JSON.stringify(copia)).not.toContain("1.005");
    expect(JSON.stringify(m)).toBe('{"amount":"1.00500000","currency":"VES"}');
  });

  it("Object.entries de un Money tampoco expone el Decimal crudo", () => {
    expect(Object.entries(must(Money.of("1.005", "VES")))).toEqual([]);
  });

  it("un Money anidado en un documento sigue serializando canónicamente", () => {
    const doc = { total: must(roundForCurrency(exacto())).value };
    expect(JSON.stringify(doc)).toBe('{"total":{"amount":"1.23000000","currency":"VES"}}');
  });
});
