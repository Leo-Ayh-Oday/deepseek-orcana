import { describe, expect, it } from "bun:test"
import { greet, greetAll } from "./greet"

describe("greet", () => {
  it("returns a greeting for a normal name", () => {
    expect(greet("Alice")).toBe("Hello, Alice!")
  })

  it("handles empty string → falls back to World", () => {
    expect(greet("")).toBe("Hello, World!")
  })

  it("handles null → falls back to World", () => {
    expect(greet(null as unknown as string)).toBe("Hello, World!")
  })

  it("handles undefined → falls back to World", () => {
    expect(greet(undefined as unknown as string)).toBe("Hello, World!")
  })

  it("handles a very long name", () => {
    const longName = "a".repeat(10_000)
    expect(greet(longName)).toBe(`Hello, ${longName}!`)
  })

  it("handles names with special characters", () => {
    expect(greet("Jöhn Dœ-Łukas")).toBe("Hello, Jöhn Dœ-Łukas!")
  })

  it("handles emoji names", () => {
    expect(greet("🐱")).toBe("Hello, 🐱!")
  })
})

describe("greetAll", () => {
  it("joins multiple greetings with newline", () => {
    expect(greetAll(["Alice", "Bob"])).toBe("Hello, Alice!\nHello, Bob!")
  })

  it("returns empty string for empty array", () => {
    expect(greetAll([])).toBe("")
  })

  it("handles single name (no trailing newline)", () => {
    expect(greetAll(["Alice"])).toBe("Hello, Alice!")
  })

  it("falls back to World for falsy entries in the array", () => {
    expect(greetAll(["Alice", ""])).toBe("Hello, Alice!\nHello, World!")
  })

  it("handles null entries in the array", () => {
    expect(greetAll(["Alice", null as unknown as string])).toBe(
      "Hello, Alice!\nHello, World!"
    )
  })

  it("handles an array of only falsy values", () => {
    expect(greetAll(["", null as unknown as string])).toBe(
      "Hello, World!\nHello, World!"
    )
  })
})
