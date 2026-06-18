import { repairToolCall } from "../src/tools/repair"

const cases: Array<[string, string]> = [
  ['{"file_path": "a.ts",}', "file_path→path + trailing comma"],
  ['{"filePath": "b.ts"}', "filePath→path"],
  ['{"enable": True}', "Python True"],
  ['{"debug": False, "val": None}', "Python False+None"],
  ['{"query": "hello', "missing closing quote"],
  ['{"path": "x"}', "valid (should pass through)"],
]

for (const [input, desc] of cases) {
  const result = repairToolCall(input)
  console.log(desc)
  console.log("  in: ", input)
  console.log("  out:", JSON.stringify(result))
  console.log()
}
