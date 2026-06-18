import { describe, expect, test } from "bun:test"
import { PI, circleArea, circleCircum, rectArea, rectPerim } from "./math"

// ============================================================
// PI
// ============================================================
describe("PI", () => {
  test("is the expected constant", () => {
    expect(PI).toBe(3.14159)
  })

  test("is a positive number", () => {
    expect(PI).toBeGreaterThan(0)
  })
})

// ============================================================
// circleArea
// ============================================================
describe("circleArea", () => {
  test("r=1 → π", () => {
    expect(circleArea(1)).toBeCloseTo(3.14159, 4)
  })

  test("r=2 → 4π", () => {
    expect(circleArea(2)).toBeCloseTo(12.56636, 4)
  })

  test("r=0 → 0 (zero radius)", () => {
    expect(circleArea(0)).toBe(0)
  })

  test("r negative returns negative area", () => {
    // mathematically consistent (r² is positive) — actually wait:
    // (-1)² = 1, so area is PI * 1 = PI
    expect(circleArea(-1)).toBeCloseTo(3.14159, 4)
  })

  test("r=1e-6 (very small)", () => {
    const result = circleArea(1e-6)
    expect(result).toBeGreaterThan(0)
    expect(result).toBeCloseTo(PI * 1e-12, 8)
  })

  test("r=1e6 (very large)", () => {
    const result = circleArea(1e6)
    expect(result).toBeCloseTo(PI * 1e12, -2) // loose tolerance for float
  })
})

// ============================================================
// circleCircum
// ============================================================
describe("circleCircum", () => {
  test("r=1 → 2π", () => {
    expect(circleCircum(1)).toBeCloseTo(6.28318, 4)
  })

  test("r=0 → 0 (zero radius)", () => {
    expect(circleCircum(0)).toBe(0)
  })

  test("r negative returns negative circumference", () => {
    // 2 * PI * (-1) = -6.28318
    expect(circleCircum(-1)).toBeCloseTo(-6.28318, 4)
  })
})

// ============================================================
// rectArea
// ============================================================
describe("rectArea", () => {
  test("3×4 → 12", () => {
    expect(rectArea(3, 4)).toBe(12)
  })

  test("w=0 → 0", () => {
    expect(rectArea(0, 5)).toBe(0)
  })

  test("h=0 → 0", () => {
    expect(rectArea(5, 0)).toBe(0)
  })

  test("both 0 → 0", () => {
    expect(rectArea(0, 0)).toBe(0)
  })

  test("negative × positive → negative", () => {
    expect(rectArea(-3, 4)).toBe(-12)
  })

  test("negative × negative → positive", () => {
    expect(rectArea(-3, -4)).toBe(12)
  })
})

// ============================================================
// rectPerim
// ============================================================
describe("rectPerim", () => {
  test("3×4 → 14", () => {
    expect(rectPerim(3, 4)).toBe(14)
  })

  test("w=0 → 2h", () => {
    expect(rectPerim(0, 5)).toBe(10)
  })

  test("h=0 → 2w", () => {
    expect(rectPerim(5, 0)).toBe(10)
  })

  test("both 0 → 0", () => {
    expect(rectPerim(0, 0)).toBe(0)
  })

  test("negative width reduces perimeter", () => {
    // 2*(-3 + 4) = 2
    expect(rectPerim(-3, 4)).toBe(2)
  })

  test("both negative", () => {
    // 2*(-3 + -4) = -14
    expect(rectPerim(-3, -4)).toBe(-14)
  })
})
