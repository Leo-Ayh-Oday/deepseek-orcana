import { describe, expect, test } from "bun:test";
import { divide } from "../src/calc";

describe("divide", () => {
  test("normal division", () => {
    expect(divide(10, 2)).toBe(5);
    expect(divide(7, 2)).toBe(3.5);
    expect(divide(-6, 3)).toBe(-2);
  });

  test("divide by zero returns Infinity", () => {
    expect(divide(1, 0)).toBe(Infinity);
    expect(divide(0, 0)).toBe(Infinity);
    expect(divide(-1, 0)).toBe(Infinity);
  });

  test("divide zero by non-zero returns zero", () => {
    expect(divide(0, 5)).toBe(0);
  });
});
