/** Skill system — reusable capability modules injected into system prompt. */

export interface SkillDef {
  name: string
  description: string
  /** Keywords that trigger this skill automatically */
  triggers: string[]
  /** The skill's system prompt fragment — injected when active */
  prompt: string
  /** Auto-trigger or manual only */
  autoTrigger: boolean
}
