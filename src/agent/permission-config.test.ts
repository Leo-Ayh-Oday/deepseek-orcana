/** Tests for permission-config: pathPattern matching, rule matching, priority chain. */

import { describe, test, expect } from "bun:test"
import { matchPathPattern, matchRule, matchFirstRule, type PermissionRule } from "./permission-config"

describe("matchPathPattern", () => {
  // Basic wildcard
  test("single * matches any segment without /", () => {
    expect(matchPathPattern("*.ts", "foo.ts")).toBe(true)
    expect(matchPathPattern("*.ts", "foo.js")).toBe(false)
    expect(matchPathPattern("*.ts", "src/foo.ts")).toBe(false) // * does not match /
  })

  // Recursive glob
  test("** matches zero or more segments", () => {
    expect(matchPathPattern("src/**/*.ts", "src/foo.ts")).toBe(true)
    expect(matchPathPattern("src/**/*.ts", "src/a/b/c/foo.ts")).toBe(true)
    expect(matchPathPattern("src/**/*.ts", "src/foo.js")).toBe(false)
    expect(matchPathPattern("src/**/*.ts", "lib/foo.ts")).toBe(false)
  })

  // Trailing **
  test("trailing ** matches everything under", () => {
    expect(matchPathPattern("src/**", "src/foo.ts")).toBe(true)
    expect(matchPathPattern("src/**", "src/a/b/c/d.ts")).toBe(true)
    expect(matchPathPattern("src/**", "lib/bar.ts")).toBe(false)
  })

  // Exclusion
  test("! prefix excludes matching paths", () => {
    expect(matchPathPattern("!src/vendor/**", "src/vendor/lib.ts")).toBe(false)
    expect(matchPathPattern("!src/vendor/**", "src/app/main.ts")).toBe(true)
  })

  // Mixed * and literal
  test("* within filename matches anything without /", () => {
    expect(matchPathPattern("*.config.*", "vite.config.ts")).toBe(true)
    expect(matchPathPattern("*.config.*", "vite.config.js")).toBe(true)
    expect(matchPathPattern("*.config.*", "vite.setup.ts")).toBe(false)
  })

  // Root-level file
  test("root-level pattern matches root files", () => {
    expect(matchPathPattern("package.json", "package.json")).toBe(true)
    expect(matchPathPattern("package.json", "src/package.json")).toBe(false)
  })

  // Windows-style paths (normalized internally)
  test("backslash paths are normalized", () => {
    expect(matchPathPattern("src/**/*.ts", "src\\foo\\bar.ts")).toBe(true)
    expect(matchPathPattern("src/**/*.ts", "src\\foo.ts")).toBe(true)
  })

  // Edge: empty segments
  test("exact top-level directory match", () => {
    expect(matchPathPattern("src", "src")).toBe(true)
    expect(matchPathPattern("src", "src/foo.ts")).toBe(false)
  })

  // Edge: pattern with regex special chars
  test("regex special characters in paths are escaped", () => {
    expect(matchPathPattern("src/component[test]/**", "src/component[test]/foo.ts")).toBe(true)
  })
})

describe("matchRule", () => {
  test("wildcard toolName matches any tool", () => {
    const rule: PermissionRule = { toolName: "*", level: "deny", reason: "all blocked" }
    const r = matchRule(rule, "shell", {})
    expect(r.matched).toBe(true)
    if (r.matched) expect(r.level).toBe("deny")
  })

  test("exact toolName mismatch returns false", () => {
    const rule: PermissionRule = { toolName: "write_file", level: "deny", reason: "" }
    expect(matchRule(rule, "shell", {}).matched).toBe(false)
  })

  test("paramPattern regex is applied to param value", () => {
    const rule: PermissionRule = {
      toolName: "shell",
      paramKey: "command",
      paramPattern: "git\\s+push.*(--force|-f)",
      level: "deny",
      reason: "no force push",
    }
    expect(matchRule(rule, "shell", { command: "git push --force origin main" }).matched).toBe(true)
    expect(matchRule(rule, "shell", { command: "git push origin main" }).matched).toBe(false)
  })

  test("pathPattern checks file_path param against glob", () => {
    const rule: PermissionRule = {
      toolName: "write_file",
      paramKey: "file_path",
      pathPattern: "src/**/*.ts",
      level: "allow",
      reason: "allow TS sources",
    }
    expect(matchRule(rule, "write_file", { file_path: "src/app/main.ts" }).matched).toBe(true)
    expect(matchRule(rule, "write_file", { file_path: "package.json" }).matched).toBe(false)
    expect(matchRule(rule, "write_file", { file_path: "src/app/main.js" }).matched).toBe(false)
  })

  test("both paramPattern and pathPattern must match when both present", () => {
    const rule: PermissionRule = {
      toolName: "write_file",
      paramKey: "file_path",
      pathPattern: "src/**",
      paramPattern: ".*main.*",
      level: "allow",
      reason: "",
    }
    expect(matchRule(rule, "write_file", { file_path: "src/main.ts" }).matched).toBe(true)
    expect(matchRule(rule, "write_file", { file_path: "src/util.ts" }).matched).toBe(false)
  })
})

describe("matchFirstRule", () => {
  test("first matching deny blocks even if later allow exists", () => {
    const rules: PermissionRule[] = [
      { toolName: "write_file", paramKey: "file_path", pathPattern: "src/vendor/**", level: "deny", reason: "vendor blocked" },
      { toolName: "write_file", paramKey: "file_path", pathPattern: "src/**", level: "allow", reason: "allow src" },
    ]
    // vendor path matches the deny rule first
    const r1 = matchFirstRule(rules, "write_file", { file_path: "src/vendor/lib.ts" })
    expect(r1).not.toBeNull()
    expect(r1!.level).toBe("deny")

    // non-vendor skips deny and matches allow
    const r2 = matchFirstRule(rules, "write_file", { file_path: "src/app/main.ts" })
    expect(r2).not.toBeNull()
    expect(r2!.level).toBe("allow")
  })

  test("exclusion via allow-first then deny-gap", () => {
    const rules: PermissionRule[] = [
      { toolName: "write_file", paramKey: "file_path", pathPattern: "src/vendor/**", level: "allow", reason: "vendor allowed" },
      { toolName: "write_file", paramKey: "file_path", pathPattern: "src/**", level: "deny", reason: "other src blocked" },
    ]
    // vendor matches allow first
    const r1 = matchFirstRule(rules, "write_file", { file_path: "src/vendor/lib.ts" })
    expect(r1).not.toBeNull()
    expect(r1!.level).toBe("allow")

    // other src files skip allow and hit deny
    const r2 = matchFirstRule(rules, "write_file", { file_path: "src/app/main.ts" })
    expect(r2).not.toBeNull()
    expect(r2!.level).toBe("deny")
  })

  test("returns null when no rules match", () => {
    const rules: PermissionRule[] = [
      { toolName: "shell", level: "deny", reason: "" },
    ]
    expect(matchFirstRule(rules, "write_file", {})).toBeNull()
  })
})
