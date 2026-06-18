const FIELD_ALIASES: Record<string, string> = {
  file_path: "path",
  filePath: "path",
}

let fixed = '{"filePath": "b.ts"}'

console.log("before:", fixed)

for (const [bad, good] of Object.entries(FIELD_ALIASES)) {
  const re = new RegExp(`"${bad}"\\s*:`, "g")
  console.log(`  pattern: ${re}, matches: ${re.test(fixed)}`)
  fixed = fixed.replace(re, `"${good}":`)
}

console.log("after:", fixed)
