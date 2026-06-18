import { buildTools } from "../src/tools/registry"
import { selectTools } from "../src/agent/tool-disclosure"

const tools = buildTools()
console.log("All tools:", tools.map(t => t.defn.name))

const r0 = selectTools(tools, "", 0)
console.log("Round0 selected:", r0.selected.map(t => t.defn.name))
