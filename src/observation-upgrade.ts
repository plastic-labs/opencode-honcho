export type ObservationMode = "unified" | "directional"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const isStampedObservationMode = (value: unknown): value is ObservationMode =>
  value === "unified" || value === "directional"

export const stampedHostObservationMode = (
  raw: Record<string, unknown> | null | undefined,
): ObservationMode | null => {
  if (!isRecord(raw) || !isRecord(raw.hosts) || !isRecord(raw.hosts.opencode)) {
    return null
  }
  const value = raw.hosts.opencode.observationMode
  return isStampedObservationMode(value) ? value : null
}

export const needsObservationUpgradePrompt = (raw: Record<string, unknown> | null | undefined) => {
  if (!isRecord(raw) || !isRecord(raw.hosts) || !isRecord(raw.hosts.opencode)) {
    return false
  }
  return stampedHostObservationMode(raw) === null
}

export const observationUpgradeNotice = () =>
  [
    "Observation mode is unset, so this install is still directional (this OpenCode agent's view of you).",
    "New installs use unified (your self-collection, shared with other unified agents).",
    "Choose with /honcho:setup or /honcho:config (hosts.opencode.observationMode).",
    "If you switch to unified, you can run /honcho:import to reingest local OpenCode transcripts into the new collection.",
  ].join(" ")

export const observationUpgradeNextSteps = () =>
  "Ask the user whether to keep directional or switch to unified. Persist the choice with honcho_set_config field=observationMode. If they choose unified, mention they can run /honcho:import to backfill local OpenCode history — optional, not required."

export const unifiedImportFollowUp = () =>
  "Switched to unified. Optionally run /honcho:import to backfill local OpenCode transcripts into the user self-collection. Skip if you do not want that history in the new collection."

export const directionalKeepFollowUp = () =>
  "Keeping directional. This OpenCode agent continues using its own view of you. You can switch later with /honcho:config."
