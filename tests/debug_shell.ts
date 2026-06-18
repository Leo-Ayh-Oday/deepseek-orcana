import { spawn } from "node:child_process"

async function main() {
  const proc = spawn("echo", ["hello"], { shell: true })
  const chunks: string[] = []
  proc.stdout?.on("data", d => chunks.push(d.toString()))
  proc.on("close", code => {
    console.log("close event fired, exitCode:", proc.exitCode, "code:", code)
    console.log("stdout:", chunks.join(""))
  })
  await new Promise(r => setTimeout(r, 2000))
  console.log("After 2s, exitCode:", proc.exitCode)
}

main()
