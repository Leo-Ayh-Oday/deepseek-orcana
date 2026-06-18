export function formatProviderStreamRecoveryPrompt(input: {
  error: string
  missing: string[]
}): string {
  return [
    "## Provider Stream Recovery",
    "The provider stream failed before this long task reached completion. This is not a completed task.",
    "",
    `Stream error: ${input.error}`,
    "",
    "Still missing:",
    ...input.missing.slice(0, 16).map(item => `- ${item}`),
    "",
    "Required next step:",
    "Resume from the first missing item. Do not repeat the whole plan, do not give a final summary, and do not mark the task complete until external verification evidence is present.",
  ].join("\n")
}

export function formatProviderStreamBlockedReport(input: {
  error: string
  missing: string[]
  changedFiles: string[]
}): string {
  return [
    "## Task blocked by provider stream failure",
    "The model/provider stream failed before the task reached completion, so this run cannot be honestly marked complete.",
    "",
    `Stream error: ${input.error}`,
    "",
    "Changed files before failure:",
    ...(input.changedFiles.length > 0 ? input.changedFiles.slice(0, 24).map(file => `- ${file}`) : ["- none recorded"]),
    "",
    "Missing work/evidence:",
    ...input.missing.slice(0, 16).map(item => `- ${item}`),
  ].join("\n")
}

export function formatGenericProviderStreamRecoveryPrompt(input: {
  error: string
}): string {
  return [
    "## Provider Stream Recovery",
    "The provider stream failed before the previous round completed.",
    "",
    `Stream error: ${input.error}`,
    "",
    "Required next step:",
    "Continue from the last stable point. Do not claim completion unless the required work and verification are actually finished.",
  ].join("\n")
}

export function formatGenericProviderStreamBlockedReport(input: {
  error: string
}): string {
  return [
    "## Task blocked by provider stream failure",
    "The provider stream failed and no retry rounds remain, so this run cannot be honestly marked complete.",
    "",
    `Stream error: ${input.error}`,
  ].join("\n")
}
