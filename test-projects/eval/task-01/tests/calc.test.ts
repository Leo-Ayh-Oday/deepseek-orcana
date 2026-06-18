import { describe, expect, test } from "bun:test";
import { divide, sum } from "../src/calc";

describe("divide", () => {
  test("normal division", () => {
    expect(divide(6, 2)).toBe(3);
    expect(divide(10, 4)).toBe(2.5);
    expect(divide(1, 3)).toBeCloseTo(0.33333, 4);
  });

  test("zero divisor returns Infinity", () => {
    expect(divide(5, 0)).toBe(Infinity);
    expect(divide(-3, 0)).toBe(-Infinity);
    expect(divide(0, 0)).toBe(Infinity);
  });

  test("negative numbers", () => {
    expect(divide(-6, 2)).toBe(-3);
    expect(divide(6, -2)).toBe(-3);
    expect(divide(-6, -2)).toBe(3);
  });
});

describe("sum", () => {
  test("normal sum", () => {
    expect(sum([1, 2, 3])).toBe(6);
  });

  test("empty array", () => {
    expect(sum([])).toBe(0);
  });

  test("negative numbers", () => {
    expect(sum([-1, -2, 3])).toBe(0);
  });
});
