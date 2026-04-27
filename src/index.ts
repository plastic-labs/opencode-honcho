import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { tool, type Plugin, type PluginInput } from "@opencode-ai/plugin"
import { Honcho } from "@honcho-ai/sdk"

type RecallMode = "hybrid" | "context" | "tools"
type SessionStrategy = "per-repo" | "per-directory" | "per-session" | "global" | "git-branch" | "chat-instance"
type DialecticReasoningLevel = "minimal" | "low" | "medium" | "high" | "max"
type ContextRefreshSettings = {
  messageThreshold: number
  ttlSeconds: number
  skipTrivialPrompts: boolean
  useSessionStartDialectic: boolean
}

export type RuntimePluginOptions = {
  configPath?: string
}

type HonchoSettings = {
  apiKey: string
  baseUrl: string
  peerName: string
  aiPeer: string
  workspace: string
  recallMode: RecallMode
  sessionStrategy: SessionStrategy
}

type HostScopedSettings = Partial<Pick<HonchoSettings, "workspace" | "aiPeer" | "recallMode" | "sessionStrategy">>

type RuntimeHandle = {
  rootDir: string
  configPath: string
  globalConfigPath: string
  config: HonchoSettings
  workspaceId: string
  sessionId: string
  sessionKey: string
  userPeerId: string
  rootAgentPeerId: string
  activeAgentPeerId: string
  childAgentPeerId: string | null
  parentAgentObserverPeerId: string | null
}

type ActiveRuntime = RuntimeHandle & {
  honcho: Honcho
  session: Awaited<ReturnType<Honcho["session"]>>
  userPeer: Awaited<ReturnType<Honcho["peer"]>>
  agentPeer: Awaited<ReturnType<Honcho["peer"]>>
}

type SessionState = {
  stableContext: string | null
  cachedPromptContext: string | null
  lastInjectedContext: string | null
  lastStableContextRefreshAt: number | null
  recentConclusions: string[]
  conclusionFingerprints: Set<string>
  capturedAssistantMessageIds: Set<string>
  pendingAssistantMessageIds: Set<string>
  assistantMessageParts: Map<string, { sessionID: string; parts: Map<string, string> }>
  promptCount: number
  lastPromptRefreshAt: number | null
  lastTopicKey: string | null
}

type PeerDescription = {
  id: string
  observeMe: boolean
  observeOthers: boolean
  sessionScoped?: boolean
  modelsOnly?: string[]
}

type UserFacingPeerDescription = {
  id: string
  observe_me: boolean
  observe_others: boolean
  session_scoped?: boolean
  models_only?: string[]
}

type PeerTopology = {
  sessionPeerConfigs: Record<string, { observeMe: boolean; observeOthers: boolean }>
  describedPeers: {
    userPeer: PeerDescription
    rootAgentPeer: PeerDescription
    childAgentPeer: PeerDescription | null
    parentAgentObserverPeer: PeerDescription | null
  }
}

const SETTINGS_DIR_NAME = ".opencode"
const SHARED_SETTINGS_DIR_NAME = ".honcho"
const SHARED_SETTINGS_FILE_NAME = "config.json"
const LEGACY_API_KEY_FIELD = "apiKey"
const RUNTIME_SERVICE = "opencode-honcho"
const MAX_RECENT_CONCLUSIONS = 8

const DEFAULT_SETTINGS: HonchoSettings = {
  apiKey: "",
  baseUrl: "https://api.honcho.dev",
  peerName: "",
  aiPeer: "opencode",
  workspace: "opencode",
  recallMode: "hybrid",
  sessionStrategy: "per-directory",
}

const INTERNAL_DIALECTIC_REASONING_LEVEL: DialecticReasoningLevel = "low"
const INTERNAL_DIALECTIC_MAX_CHARS = 600
const INTERNAL_MESSAGE_MAX_CHARS = 25_000
const INTERNAL_SAVE_MESSAGES = true
const INTERNAL_CONTEXT_REFRESH: ContextRefreshSettings = {
  messageThreshold: 30,
  ttlSeconds: 300,
  skipTrivialPrompts: true,
  useSessionStartDialectic: true,
}

const BOOLEAN_KEYS = new Set<keyof HonchoSettings>([])

const NUMBER_KEYS = new Set<keyof HonchoSettings>([])

const ENUM_KEYS: Record<string, ReadonlySet<string>> = {
  recallMode: new Set(["hybrid", "context", "tools"]),
  sessionStrategy: new Set(["per-repo", "per-directory", "per-session", "global", "git-branch", "chat-instance"]),
}

const INHERITABLE_STRING_KEYS = new Set<keyof HonchoSettings>(["apiKey", "baseUrl", "peerName", "aiPeer", "workspace"])

const TOP_LEVEL_SETTING_FIELDS = new Set<keyof HonchoSettings>(["apiKey", "baseUrl", "peerName"])
const HOST_SETTING_FIELDS = new Set<keyof HonchoSettings>(["workspace", "aiPeer", "recallMode", "sessionStrategy"])

const SETTING_FIELD_PATHS = new Set([
  "apiKey",
  "baseUrl",
  "peerName",
  "aiPeer",
  "workspace",
  "recallMode",
  "sessionStrategy",
])

const DURABLE_PATTERNS = [
  /\b(i prefer|i like|i love|i hate)\b/i,
  /\b(my name is|call me)\b/i,
  /\b(always|never|usually)\b/i,
  /\b(i work on|i maintain|my project)\b/i,
  /\b(please don't|please do|remember that)\b/i,
]

const TRIVIAL_PROMPT_PATTERNS = [
  /^(ok|okay|k|thanks|thank you|continue|go on|next|yes|y|no|n|retry|again)$/i,
  /^(fix it|do it|ship it|run it|keep going)$/i,
]

const TECH_TERM_PATTERN =
  /\b(react|vue|svelte|angular|fastapi|django|flask|postgres|redis|docker|kubernetes|bun|node|typescript|python|rust|go|graphql|rest|api|auth|oauth|jwt|stripe|webhook)\b/gi

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const expandEnv = (value: string) =>
  value.replace(/\$\{([^}]+)\}/g, (_, key: string) => process.env[key] ?? "")

const clampText = (value: string, maxChars: number) =>
  value.length > maxChars ? `${value.slice(0, Math.max(0, maxChars - 3))}...` : value

const trimHyphenEdges = (value: string) => {
  let start = 0
  let end = value.length
  while (start < end && value[start] === "-") {
    start += 1
  }
  while (end > start && value[end - 1] === "-") {
    end -= 1
  }
  return value.slice(start, end)
}

const normalizeId = (value: string) =>
  trimHyphenEdges(value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")) || "default"

const isLocalBaseUrl = (value: string) => {
  if (!value.trim()) return false
  try {
    const url = new URL(value)
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  } catch {
    return false
  }
}

const hasConfiguredAuth = (settings: HonchoSettings) =>
  Boolean(settings.apiKey) || settings.baseUrl !== DEFAULT_SETTINGS.baseUrl

const readTextPart = (part: unknown) =>
  isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : null

const readVisibleTextPart = (part: unknown) => {
  if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
    return null
  }
  if (part.ignored === true) {
    return null
  }
  const text = part.text.trim()
  return text ? text : null
}

const extractText = (parts: unknown) =>
  Array.isArray(parts)
    ? parts.map(readTextPart).filter((value): value is string => Boolean(value)).join("\n").trim()
    : ""

const timestampToIso = (value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined
  }

  try {
    return new Date(value).toISOString()
  } catch {
    return undefined
  }
}

const upsertAssistantMessagePart = (
  state: Map<string, { sessionID: string; parts: Map<string, string> }>,
  payload: unknown,
) => {
  if (!isRecord(payload) || !isRecord(payload.event) || payload.event.type !== "message.part.updated") {
    return
  }

  const properties = isRecord(payload.event.properties) ? payload.event.properties : null
  const part = properties && isRecord(properties.part) ? properties.part : null
  if (!part || part.type !== "text") {
    return
  }

  const messageID = typeof part.messageID === "string" ? part.messageID : ""
  const sessionID = typeof part.sessionID === "string" ? part.sessionID : ""
  const partID = typeof part.id === "string" ? part.id : ""
  if (!messageID || !sessionID || !partID) {
    return
  }

  const visibleText = readVisibleTextPart(part)
  const existing = state.get(messageID) ?? { sessionID, parts: new Map<string, string>() }
  existing.sessionID = sessionID
  if (visibleText) {
    existing.parts.set(partID, visibleText)
  } else {
    existing.parts.delete(partID)
  }

  if (existing.parts.size > 0) {
    state.set(messageID, existing)
  } else {
    state.delete(messageID)
  }
}

const extractCompletedAssistantMessage = (
  payload: unknown,
  state: Map<string, { sessionID: string; parts: Map<string, string> }>,
) => {
  if (!isRecord(payload) || !isRecord(payload.event) || payload.event.type !== "message.updated") {
    return null
  }

  const properties = isRecord(payload.event.properties) ? payload.event.properties : null
  const info = properties && isRecord(properties.info) ? properties.info : null
  if (!info || info.role !== "assistant" || info.summary === true) {
    return null
  }

  const messageId = typeof info.id === "string" ? info.id : ""
  const sessionID = typeof info.sessionID === "string" ? info.sessionID : ""
  const timing = isRecord(info.time) ? info.time : null
  const createdAt = timestampToIso(timing?.completed ?? timing?.created)
  const entry = messageId ? state.get(messageId) : null
  const text = entry ? Array.from(entry.parts.values()).join("\n").trim() : ""
  if (!messageId || !sessionID || !createdAt || !text || typeof timing?.completed !== "number") {
    return null
  }

  return {
    messageId,
    sessionID,
    text,
    createdAt,
  }
}

const fingerprint = (value: string) => normalizeId(value.trim().slice(0, 160))

const coerceBoolean = (value: unknown) => {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (normalized === "true") return true
    if (normalized === "false") return false
  }
  throw new Error(`Expected boolean value, received ${JSON.stringify(value)}`)
}

const coerceNumber = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  throw new Error(`Expected numeric value, received ${JSON.stringify(value)}`)
}

const parseSettingValue = (fieldPath: string, raw: string): unknown => {
  if (BOOLEAN_KEYS.has(fieldPath as keyof HonchoSettings)) {
    return coerceBoolean(raw)
  }
  if (NUMBER_KEYS.has(fieldPath as keyof HonchoSettings)) {
    return coerceNumber(raw)
  }
  if (fieldPath in ENUM_KEYS && !ENUM_KEYS[fieldPath].has(raw)) {
    throw new Error(`Unsupported ${fieldPath} value '${raw}'`)
  }
  return raw
}

const normalizedRawSettings = (raw: Record<string, unknown>) => {
  const normalized: Record<string, unknown> = { ...raw }
  const legacyApiKey =
    typeof raw[LEGACY_API_KEY_FIELD] === "string"
      ? expandEnv(raw[LEGACY_API_KEY_FIELD] as string)
      : ""
  const effectiveApiKey = legacyApiKey

  if (effectiveApiKey) {
    normalized[LEGACY_API_KEY_FIELD] = effectiveApiKey
  }

  return normalized
}

const applyRawLayer = (target: HonchoSettings, raw: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(raw) as Array<[keyof HonchoSettings, unknown]>) {
    if (!TOP_LEVEL_SETTING_FIELDS.has(key) && !HOST_SETTING_FIELDS.has(key)) {
      continue
    }
    if (value === undefined || value === null) {
      continue
    }
    if (typeof value === "string") {
      const expanded = expandEnv(value)
      if (INHERITABLE_STRING_KEYS.has(key) && !expanded.trim()) {
        continue
      }
      ;(target as Record<string, unknown>)[key] = expanded
      continue
    }
    ;(target as Record<string, unknown>)[key] = value
  }
}

const hostScopedSettings = (value: unknown): HostScopedSettings | null => {
  if (!isRecord(value)) {
    return null
  }
  const normalized = normalizedRawSettings(value)
  delete normalized[LEGACY_API_KEY_FIELD]
  delete normalized.peerName
  delete normalized.linkedHosts
  delete normalized.baseUrl
  delete normalized.globalOverride
  delete normalized.observation
  return normalized as HostScopedSettings
}

const normalizeScopedSettings = (raw: Record<string, unknown>, hostId = "opencode") => {
  const topLevel = normalizedRawSettings(raw)
  const normalized: Record<string, unknown> = {}
  for (const field of TOP_LEVEL_SETTING_FIELDS) {
    const value = topLevel[field]
    if (value === undefined || value === null) continue
    if (typeof value === "string" && !value.trim() && INHERITABLE_STRING_KEYS.has(field)) continue
    normalized[field] = value
  }
  const hostBlock = isRecord(raw.hosts) ? hostScopedSettings(raw.hosts[hostId]) : null

  if (hostBlock) {
    for (const [key, value] of Object.entries(hostBlock)) {
      if (value === undefined || value === null) {
        continue
      }
      normalized[key] = value
    }
  }
  return normalized
}

const mergeSettings = (...rawLayers: Array<Record<string, unknown>>): HonchoSettings => {
  const merged: HonchoSettings = { ...DEFAULT_SETTINGS }
  for (const raw of rawLayers) {
    applyRawLayer(merged, raw)
  }
  return merged
}

const setSettingValue = (target: Record<string, unknown>, fieldPath: string, value: unknown) => {
  const parts = fieldPath.split(".")
  const rootField = parts[0]
  const resolvedParts = HOST_SETTING_FIELDS.has(rootField as keyof HonchoSettings)
    ? ["hosts", "opencode", rootField]
    : parts
  let current: Record<string, unknown> = target
  for (const part of resolvedParts.slice(0, -1)) {
    if (!isRecord(current[part])) {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }
  current[resolvedParts[resolvedParts.length - 1]] = value
}

const listAllowedSettingPaths = () => Array.from(SETTING_FIELD_PATHS).sort()

const extractTopics = (prompt: string) => {
  const filePaths = prompt.match(/[\w\-/.]+\.(ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml|toml|sql)/gi) || []
  const quoted = prompt.match(/"([^"]+)"/g)?.map((value) => value.slice(1, -1)) || []
  const techTerms = prompt.match(TECH_TERM_PATTERN) || []
  const words = prompt.toLowerCase().match(/\b[a-z]{4,}\b/g) || []
  return Array.from(new Set([...filePaths, ...quoted, ...techTerms, ...words.slice(0, 6)])).slice(0, 8)
}

const deriveTopicKey = (prompt: string) => {
  const topics = extractTopics(prompt)
  return normalizeId(topics.length > 0 ? topics.join(" ") : prompt.toLowerCase().split(/\s+/).slice(0, 8).join(" "))
}

const shouldSkipContextRetrieval = (prompt: string, settings: ContextRefreshSettings) => {
  if (!settings.skipTrivialPrompts) {
    return false
  }
  const trimmed = prompt.trim()
  if (!trimmed) {
    return true
  }
  if (trimmed.length <= 4) {
    return true
  }
  return TRIVIAL_PROMPT_PATTERNS.some((pattern) => pattern.test(trimmed))
}

const parseSessionSummary = (value: unknown) => {
  if (typeof value === "string" && value.trim()) {
    return value.trim()
  }
  if (isRecord(value) && typeof value.content === "string" && value.content.trim()) {
    return value.content.trim()
  }
  return ""
}

const parseRepresentation = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : ""

const formatPeerContextBlock = (heading: string, representation: string, peerCard: string[] | null) => {
  const sections: string[] = []
  if (peerCard && peerCard.length > 0) {
    sections.push(peerCard.map((entry) => `- ${entry}`).join("\n"))
  }
  if (representation) {
    sections.push(representation)
  }
  return sections.length > 0 ? `${heading}\n${sections.join("\n\n")}` : ""
}

const formatPromptContextBlock = (summary: string, representation: string) => {
  const sections: string[] = []
  if (summary) {
    sections.push(`Session summary:\n${summary}`)
  }
  if (representation) {
    sections.push(`Relevant Honcho memory:\n${representation}`)
  }
  return sections.join("\n\n")
}

const shouldRefreshPromptContext = (
  state: SessionState,
  topicKey: string,
  settings: ContextRefreshSettings,
) => {
  if (!state.cachedPromptContext || !state.lastPromptRefreshAt) {
    return true
  }
  if (state.lastTopicKey !== topicKey) {
    return true
  }
  if (state.promptCount >= settings.messageThreshold) {
    return true
  }
  return Date.now() - state.lastPromptRefreshAt >= settings.ttlSeconds * 1000
}

const shouldInjectStableContext = (state: SessionState, settings: ContextRefreshSettings) => {
  if (!state.lastStableContextRefreshAt) {
    return true
  }
  if (state.promptCount >= settings.messageThreshold) {
    return true
  }
  return Date.now() - state.lastStableContextRefreshAt >= settings.ttlSeconds * 1000
}

const parseSettingField = (field: string) => {
  if (!SETTING_FIELD_PATHS.has(field)) {
    throw new Error(`Unknown setting '${field}'. Allowed fields: ${listAllowedSettingPaths().join(", ")}`)
  }
  return field
}

const lookupField = (payload: Record<string, unknown>, field: string) =>
  field.split(".").reduce<unknown>((current, part) => {
    if (!isRecord(current)) return undefined
    return current[part]
  }, payload)

const extractSessionId = (input: Record<string, unknown> | undefined) => {
  const event = isRecord(input?.event) ? input.event : undefined
  const eventProperties = isRecord(event?.properties) ? event.properties : undefined
  const candidates = [input, event, eventProperties, isRecord(eventProperties?.info) ? eventProperties.info : undefined, isRecord(eventProperties?.part) ? eventProperties.part : undefined]

  for (const candidate of candidates) {
    const value = candidate?.sessionID ?? candidate?.sessionId ?? candidate?.session_id
    if (typeof value === "string" && value.length > 0) {
      return value
    }
  }

  return "unknown-session"
}

const deriveProjectRoot = (pluginInput: PluginInput) => {
  const hints = [pluginInput.directory, pluginInput.worktree, pluginInput.project?.worktree].filter(
    (value): value is string => Boolean(value),
  )
  for (const hint of hints) {
    let current = path.resolve(hint)
    while (true) {
      if (existsSync(path.join(current, SETTINGS_DIR_NAME)) || existsSync(path.join(current, ".git"))) {
        return current
      }
      const parent = path.dirname(current)
      if (parent === current) {
        break
      }
      current = parent
    }
  }
  return path.resolve(pluginInput.worktree || pluginInput.project?.worktree || pluginInput.directory || process.cwd())
}

const sharedConfigPath = (configPathOverride?: string) =>
  configPathOverride ? path.resolve(configPathOverride) : sharedGlobalSettingsPath()

const userHomeDir = () => process.env.HOME || process.env.USERPROFILE || process.cwd()

const sharedGlobalSettingsPath = () => {
  return path.join(userHomeDir(), SHARED_SETTINGS_DIR_NAME, SHARED_SETTINGS_FILE_NAME)
}

const readJsonFile = async (configPath: string) => {
  try {
    return JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null
    }
    throw error
  }
}

const readConfigFile = async (configPath: string) => normalizedRawSettings((await readJsonFile(configPath)) ?? {})

const envSettings = (): Record<string, unknown> => ({
  apiKey: process.env.HONCHO_API_KEY || "",
  baseUrl: process.env.HONCHO_URL || process.env.HONCHO_BASE_URL || "",
  peerName: process.env.HONCHO_PEER_NAME || "",
  workspace: process.env.HONCHO_WORKSPACE || process.env.HONCHO_WORKSPACE_ID || "",
  aiPeer: process.env.HONCHO_AI_PEER || "",
})

const resolveSettings = async (configPathOverride?: string) => {
  const configPath = sharedConfigPath(configPathOverride)
  const { globalConfigPath, globalRaw } = await ensureSharedGlobalSettings(configPath)
  return {
    configPath,
    globalConfigPath,
    settings: mergeSettings(normalizeScopedSettings(globalRaw), envSettings()),
  }
}

const writeSettings = async (
  configPath: string,
  settings: Record<string, unknown>,
) => {
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(configPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8")
}

const currentUserName = () => "user"

const rootApiKey = (raw: Record<string, unknown>) => {
  const legacyApiKey = typeof raw[LEGACY_API_KEY_FIELD] === "string" ? expandEnv(raw[LEGACY_API_KEY_FIELD] as string) : ""
  return legacyApiKey
}

const hostDefaults = (settings: HonchoSettings): Record<string, unknown> => {
  const workspace = typeof settings.workspace === "string" && settings.workspace.trim() ? settings.workspace : "opencode"
  const aiPeer = typeof settings.aiPeer === "string" && settings.aiPeer.trim() ? settings.aiPeer : "opencode"
  return {
    workspace,
    aiPeer,
    recallMode: settings.recallMode,
    sessionStrategy: settings.sessionStrategy,
  }
}

const writeSharedGlobalSettings = async (configPath: string, settings: Record<string, unknown>) => {
  const next = { ...settings }
  const apiKey = rootApiKey(next)
  if (apiKey) {
    next[LEGACY_API_KEY_FIELD] = apiKey
  } else {
    delete next[LEGACY_API_KEY_FIELD]
  }
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8")
}

const ensureSharedGlobalSettings = async (configPath = sharedGlobalSettingsPath()) => {
  const sharedRaw = await readJsonFile(configPath)
  const currentShared = sharedRaw ?? {}
  const mergedHostSettings = mergeSettings(normalizeScopedSettings(currentShared))
  let next: Record<string, unknown>

  if (sharedRaw) {
    next = currentShared
  } else {
    next = {
      peerName: currentUserName(),
      baseUrl: mergedHostSettings.baseUrl,
      hosts: {
        opencode: hostDefaults(mergedHostSettings),
      },
    }
    await writeSharedGlobalSettings(configPath, next)
  }

  return {
    globalConfigPath: configPath,
    globalRaw: normalizedRawSettings(next),
  }
}

const resolveGitDir = async (rootDir: string): Promise<string | null> => {
  const directGitDir = path.join(rootDir, ".git")
  try {
    const statTarget = await readFile(directGitDir, "utf-8")
    const prefix = "gitdir:"
    if (statTarget.trim().startsWith(prefix)) {
      const relativeGitDir = statTarget.trim().slice(prefix.length).trim()
      return path.resolve(rootDir, relativeGitDir)
    }
  } catch {
    if (existsSync(directGitDir)) {
      return directGitDir
    }
  }

  return existsSync(directGitDir) ? directGitDir : null
}

const deriveGitBranchLabel = async (rootDir: string): Promise<string | null> => {
  const gitDir = await resolveGitDir(rootDir)
  if (!gitDir) return null

  try {
    const head = (await readFile(path.join(gitDir, "HEAD"), "utf-8")).trim()
    const branchPrefix = "ref: refs/heads/"
    if (head.startsWith(branchPrefix)) {
      return normalizeId(head.slice(branchPrefix.length))
    }
  } catch {
    return null
  }

  return null
}

const deriveSessionScope = async ({
  workspaceId,
  sessionStrategy,
  rootDir,
  repoName,
  currentDirectory,
  sessionId,
}: {
  workspaceId: string
  sessionStrategy: SessionStrategy
  rootDir: string
  repoName: string
  currentDirectory: string
  sessionId: string
}) => {
  if (sessionStrategy === "per-directory") {
    const relativeDirectory = path.relative(rootDir, currentDirectory)
    const directoryLabel =
      relativeDirectory && !relativeDirectory.startsWith("..") && !path.isAbsolute(relativeDirectory)
        ? normalizeId(relativeDirectory.split(path.sep).join("-"))
        : normalizeId(path.basename(currentDirectory))
    return `${workspaceId}:${directoryLabel || normalizeId(repoName)}`
  }

  if (sessionStrategy === "per-session" || sessionStrategy === "chat-instance") {
    return `${workspaceId}:${normalizeId(sessionId)}`
  }

  if (sessionStrategy === "global") {
    return `${workspaceId}:global`
  }

  if (sessionStrategy === "git-branch") {
    const branchLabel = await deriveGitBranchLabel(rootDir)
    return `${workspaceId}:${branchLabel || normalizeId(repoName)}`
  }

  return `${workspaceId}:${normalizeId(repoName)}`
}

const deriveRuntimeHandle = async (
  pluginInput: PluginInput,
  input: Record<string, unknown> | undefined,
  configPathOverride?: string,
): Promise<RuntimeHandle> => {
  const rootDir = deriveProjectRoot(pluginInput)
  const { configPath, globalConfigPath, settings } = await resolveSettings(configPathOverride)
  const sessionId = extractSessionId(input)
  const repoName = path.basename(rootDir)
  const workspaceId = normalizeId(settings.workspace || "opencode")
  const userPeerId = normalizeId(`user:${settings.peerName || currentUserName()}`)
  const rootAgentPeerId = normalizeId(settings.aiPeer || "opencode")
  const activeAgentPeerId = rootAgentPeerId
  const childAgentPeerId = null
  const parentAgentObserverPeerId = null

  const cwd = pluginInput.directory || pluginInput.worktree || rootDir
  const sessionScope = await deriveSessionScope({
    workspaceId,
    sessionStrategy: settings.sessionStrategy,
    rootDir,
    repoName,
    currentDirectory: cwd,
    sessionId,
  })

  const lineage = [activeAgentPeerId]
  if (parentAgentObserverPeerId && parentAgentObserverPeerId !== rootAgentPeerId) {
    lineage.unshift(parentAgentObserverPeerId)
  }

  return {
    rootDir,
    configPath,
    globalConfigPath,
    config: settings,
    workspaceId,
    sessionId,
    sessionKey: normalizeId(`${settings.sessionStrategy}:${sessionScope}:${lineage.join(":")}`),
    userPeerId,
    rootAgentPeerId,
    activeAgentPeerId,
    childAgentPeerId,
    parentAgentObserverPeerId,
  }
}

const deriveSessionStateKey = (handle: Pick<RuntimeHandle, "sessionId" | "sessionKey">) => handle.sessionKey || handle.sessionId

const buildPeerTopology = (handle: Pick<
  RuntimeHandle,
  "config" | "userPeerId" | "rootAgentPeerId" | "activeAgentPeerId" | "childAgentPeerId" | "parentAgentObserverPeerId"
>): PeerTopology => {
  const userPeer: PeerDescription = {
    id: handle.userPeerId,
    observeMe: true,
    observeOthers: false,
  }
  const rootAgentPeer: PeerDescription = {
    id: handle.rootAgentPeerId,
    observeMe: true,
    observeOthers: true,
  }
  return {
    sessionPeerConfigs: {
      [userPeer.id]: { observeMe: true, observeOthers: false },
      [rootAgentPeer.id]: { observeMe: true, observeOthers: true },
    },
    describedPeers: {
      userPeer,
      rootAgentPeer,
      childAgentPeer: null,
      parentAgentObserverPeer: null,
    },
  }
}

const sessionPeerAdditions = (topology: PeerTopology) =>
  Object.entries(topology.sessionPeerConfigs).map(([peerId, config]) => [peerId, config] as const)

const createActiveRuntime = async (
  pluginInput: PluginInput,
  input: Record<string, unknown> | undefined,
  configPathOverride?: string,
): Promise<ActiveRuntime> => {
  const handle = await deriveRuntimeHandle(pluginInput, input, configPathOverride)
  const honcho = new Honcho({
    apiKey: handle.config.apiKey || undefined,
    baseURL: handle.config.baseUrl || undefined,
    workspaceId: handle.workspaceId,
  })
  const userPeer = await honcho.peer(handle.userPeerId, {
    configuration: { observeMe: true },
  })
  const agentPeer = await honcho.peer(handle.activeAgentPeerId, {
    configuration: { observeMe: true },
  })
  const session = await honcho.session(handle.sessionKey)
  await session.addPeers(sessionPeerAdditions(buildPeerTopology(handle)) as never)
  return { ...handle, honcho, session, userPeer, agentPeer }
}

const validateSetupConnection = async ({
  apiKey,
  baseUrl,
  workspaceId,
}: {
  apiKey: string
  baseUrl: string
  workspaceId: string
}) => {
  const honcho = new Honcho({
    apiKey: apiKey || undefined,
    baseURL: baseUrl || undefined,
    workspaceId,
  })
  await honcho.session(normalizeId(`setup-check:${workspaceId}`))
}

const durableConclusionCandidate = (text: string, settings: HonchoSettings) => {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (!DURABLE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return null
  }
  void settings
  return clampText(trimmed, INTERNAL_DIALECTIC_MAX_CHARS)
}

const extractPromptQuery = (input: Record<string, unknown> | undefined) => {
  if (!input) return ""
  if (typeof input.query === "string") return input.query
  if (typeof input.message === "string") return input.message
  if (Array.isArray(input.messages)) {
    for (let index = input.messages.length - 1; index >= 0; index -= 1) {
      const message = input.messages[index]
      if (isRecord(message) && Array.isArray(message.parts)) {
        const text = extractText(message.parts)
        if (text) return text
      }
    }
  }
  return extractText(input.parts)
}

const toUserFacingPeerDescription = (peer: PeerDescription | null): UserFacingPeerDescription | null => {
  if (!peer) {
    return null
  }

  return {
    id: peer.id,
    observe_me: peer.observeMe,
    observe_others: peer.observeOthers,
    ...(peer.sessionScoped ? { session_scoped: true } : {}),
    ...(peer.modelsOnly ? { models_only: peer.modelsOnly } : {}),
  }
}

const describePeers = (handle: RuntimeHandle) => {
  const peers = buildPeerTopology(handle).describedPeers
  return {
    userPeer: toUserFacingPeerDescription(peers.userPeer),
    rootAgentPeer: toUserFacingPeerDescription(peers.rootAgentPeer),
    childAgentPeer: toUserFacingPeerDescription(peers.childAgentPeer),
    parentAgentObserverPeer: toUserFacingPeerDescription(peers.parentAgentObserverPeer),
  }
}

const createSessionState = (): SessionState => ({
  stableContext: null,
  cachedPromptContext: null,
  lastInjectedContext: null,
  lastStableContextRefreshAt: null,
  recentConclusions: [],
  conclusionFingerprints: new Set<string>(),
  capturedAssistantMessageIds: new Set<string>(),
  pendingAssistantMessageIds: new Set<string>(),
  assistantMessageParts: new Map<string, { sessionID: string; parts: Map<string, string> }>(),
  promptCount: 0,
  lastPromptRefreshAt: null,
  lastTopicKey: null,
})

const markAssistantMessageCaptured = async (
  state: SessionState,
  update: { messageId: string } | null,
  persist: () => Promise<void>,
) => {
  if (
    !update ||
    state.capturedAssistantMessageIds.has(update.messageId) ||
    state.pendingAssistantMessageIds.has(update.messageId)
  ) {
    return false
  }

  state.pendingAssistantMessageIds.add(update.messageId)
  try {
    await persist()
    state.capturedAssistantMessageIds.add(update.messageId)
    state.assistantMessageParts.delete(update.messageId)
    return true
  } finally {
    state.pendingAssistantMessageIds.delete(update.messageId)
  }
}

type SearchToolResult =
  | {
      ok: true
      workspace: string
      sessionKey: string
      items: { id: string; peerId: string; content: string }[]
    }
  | {
      ok: false
      workspace?: string
      sessionKey?: string
      items: { id: string; peerId: string; content: string }[]
      error: string
    }

type ChatToolResult =
  | {
      ok: true
      workspace: string
      sessionKey: string
      response: string
    }
  | {
      ok: false
      workspace?: string
      sessionKey?: string
      response: string | null
      error: string
    }

const appendConclusion = (state: SessionState, content: string) => {
  state.recentConclusions.unshift(content)
  if (state.recentConclusions.length > MAX_RECENT_CONCLUSIONS) {
    state.recentConclusions.length = MAX_RECENT_CONCLUSIONS
  }
}

export const createHonchoRuntimePlugin =
  ({ configPath }: RuntimePluginOptions = {}): Plugin =>
  async (pluginInput) => {
    const sessionStates = new Map<string, SessionState>()

    const getState = (stateKey: string) => {
      let current = sessionStates.get(stateKey)
      if (!current) {
        current = createSessionState()
        sessionStates.set(stateKey, current)
      }
      return current
    }

    const log = async (level: "debug" | "info" | "warn" | "error", message: string, extra: Record<string, unknown> = {}) => {
      await pluginInput.client.app.log({
        body: {
          service: RUNTIME_SERVICE,
          level,
          message,
          extra,
        },
      })
    }

    const withRuntime = async <T>(
      input: Record<string, unknown> | undefined,
      action: (runtime: ActiveRuntime) => Promise<T>,
      fallback: T,
    ) => {
      const handle = await deriveRuntimeHandle(pluginInput, input, configPath)
      if (!hasConfiguredAuth(handle.config)) {
        await log("warn", "Honcho runtime is missing an API key and is not configured for a localhost baseUrl.", {
          configPath: handle.configPath,
          globalConfigPath: handle.globalConfigPath,
          workspaceId: handle.workspaceId,
          baseUrl: handle.config.baseUrl,
        })
        return fallback
      }
      try {
        return await action(await createActiveRuntime(pluginInput, input, configPath))
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        await log("error", "Honcho runtime operation failed.", {
          message: detail,
          sessionId: handle.sessionId,
          workspaceId: handle.workspaceId,
        })
        if (isRecord(fallback) && typeof fallback.error === "string") {
          return { ...fallback, error: detail } as T
        }
        return fallback
      }
    }

    const runtimeStatus = async (input: Record<string, unknown> | undefined) => {
      const handle = await deriveRuntimeHandle(pluginInput, input, configPath)
      const state = getState(deriveSessionStateKey(handle))
      return {
        ok: true,
        configPath: handle.configPath,
        projectConfigPath: handle.configPath,
        globalConfigPath: handle.globalConfigPath,
        rootDir: handle.rootDir,
        workspace: handle.workspaceId,
        workspaceName: handle.workspaceId,
        sessionId: handle.sessionId,
        sessionKey: handle.sessionKey,
        sessionName: handle.sessionKey,
        recallMode: handle.config.recallMode,
        sessionStrategy: handle.config.sessionStrategy,
        peerName: handle.config.peerName,
        configured: hasConfiguredAuth(handle.config),
        localMode: isLocalBaseUrl(handle.config.baseUrl),
        baseUrl: handle.config.baseUrl,
        peers: describePeers(handle),
        recentConclusions: state.recentConclusions,
        stableContext: state.stableContext,
        cachedPromptContext: state.cachedPromptContext,
        lastInjectedContext: state.lastInjectedContext,
      }
    }

    const captureMessage = async (
      runtime: ActiveRuntime,
      peer: ActiveRuntime["userPeer"] | ActiveRuntime["agentPeer"],
      content: string,
      metadata: Record<string, unknown>,
      createdAt?: string,
    ) => {
      if (!INTERNAL_SAVE_MESSAGES) return
      const trimmed = clampText(content.trim(), INTERNAL_MESSAGE_MAX_CHARS)
      if (!trimmed) return
      await runtime.session.addMessages(peer.message(trimmed, { metadata, createdAt }))
    }

    const captureCompletedAssistantRecord = async (
      runtime: ActiveRuntime,
      state: SessionState,
      payload: unknown,
      source: string,
    ) => {
      const update = extractCompletedAssistantMessage(payload, state.assistantMessageParts)
      if (!update) {
        return false
      }
      return markAssistantMessageCaptured(state, update, async () => {
        await captureMessage(
          runtime,
          runtime.agentPeer,
          update.text,
          {
            source,
            sessionId: runtime.sessionId,
            messageId: update.messageId,
          },
          update.createdAt,
        )
      })
    }

    const hydrateSessionStartContext = async (runtime: ActiveRuntime, state: SessionState) => {
      const dialecticEnabled = INTERNAL_CONTEXT_REFRESH.useSessionStartDialectic
      const [userContextResult, agentContextResult, summariesResult, userChatResult, agentChatResult] =
        await Promise.allSettled([
          runtime.userPeer.context({
            maxConclusions: 12,
            includeMostFrequent: true,
          }),
          runtime.agentPeer.context({
            maxConclusions: 8,
            includeMostFrequent: true,
          }),
          runtime.session.summaries(),
          dialecticEnabled
            ? runtime.agentPeer.chat(
                `Summarize what you know about ${runtime.userPeerId} in 2-3 sentences. Focus on durable preferences, current projects, and working style.`,
                {
                  target: runtime.userPeer,
                  session: runtime.session,
                  reasoningLevel: INTERNAL_DIALECTIC_REASONING_LEVEL,
                },
              )
            : Promise.resolve(null),
          dialecticEnabled
            ? runtime.agentPeer.chat(
                "Summarize the assistant's recent work context for this project in 2-3 sentences.",
                {
                  session: runtime.session,
                  reasoningLevel: INTERNAL_DIALECTIC_REASONING_LEVEL,
                },
              )
            : Promise.resolve(null),
        ])

      const sections: string[] = []
      if (userContextResult.status === "fulfilled") {
        const block = formatPeerContextBlock(
          "## User Memory Profile",
          parseRepresentation(userContextResult.value.representation),
          userContextResult.value.peerCard,
        )
        if (block) {
          sections.push(block)
        }
      }
      if (agentContextResult.status === "fulfilled") {
        const block = formatPeerContextBlock(
          "## Agent Work Context",
          parseRepresentation(agentContextResult.value.representation),
          agentContextResult.value.peerCard,
        )
        if (block) {
          sections.push(block)
        }
      }
      if (summariesResult.status === "fulfilled") {
        const summary =
          parseSessionSummary(summariesResult.value.shortSummary) ||
          parseSessionSummary(summariesResult.value.longSummary)
        if (summary) {
          sections.push(`## Recent Session Summary\n${summary}`)
        }
      }
      if (userChatResult.status === "fulfilled" && userChatResult.value) {
        sections.push(`## AI Summary Of User\n${clampText(userChatResult.value, 800)}`)
      }
      if (agentChatResult.status === "fulfilled" && agentChatResult.value) {
        sections.push(`## AI Self-Reflection\n${clampText(agentChatResult.value, 800)}`)
      }

      state.stableContext = sections.length > 0 ? sections.join("\n\n") : null
      return (
        userContextResult.status === "fulfilled" ||
        agentContextResult.status === "fulfilled" ||
        summariesResult.status === "fulfilled" ||
        (dialecticEnabled && userChatResult.status === "fulfilled") ||
        (dialecticEnabled && agentChatResult.status === "fulfilled")
      )
    }

    const refreshPromptContext = async (runtime: ActiveRuntime, state: SessionState, query: string) => {
      const topicKey = deriveTopicKey(query)
      if (!shouldRefreshPromptContext(state, topicKey, INTERNAL_CONTEXT_REFRESH)) {
        return state.cachedPromptContext
      }
      const sessionContext = await runtime.session.context({
        summary: true,
        peerPerspective: runtime.agentPeer,
        peerTarget: runtime.userPeer,
        limitToSession: runtime.config.sessionStrategy === "per-session",
        representationOptions: {
          searchQuery: topicKey || undefined,
          searchTopK: 5,
          searchMaxDistance: 0.7,
          maxConclusions: 6,
        },
      })
      const compiled = formatPromptContextBlock(
        parseSessionSummary(sessionContext.summary),
        parseRepresentation(sessionContext.peerRepresentation),
      )
      state.cachedPromptContext = compiled || null
      state.lastPromptRefreshAt = Date.now()
      state.lastTopicKey = topicKey
      state.promptCount = 0
      return state.cachedPromptContext
    }

    const maybeWriteConclusion = async (
      runtime: ActiveRuntime,
      content: string,
      reason: string,
    ) => {
      const state = getState(deriveSessionStateKey(runtime))
      const normalized = fingerprint(content)
      if (!normalized || state.conclusionFingerprints.has(normalized)) {
        return false
      }
      state.conclusionFingerprints.add(normalized)
      appendConclusion(state, content)
      state.lastPromptRefreshAt = null
      await runtime.agentPeer.conclusionsOf(runtime.userPeer).create({
        content,
        sessionId: runtime.session.id,
      })
      await log("info", "Durable Honcho conclusion created.", {
        sessionId: runtime.sessionId,
        sessionKey: runtime.sessionKey,
        reason,
        content,
      })
      return true
    }

    return {
      event: async ({ event }) => {
        const payload = isRecord(event) ? { event, ...(isRecord(event.properties) ? event.properties : {}) } : { event }
        const handle = await deriveRuntimeHandle(pluginInput, payload, configPath)
        const stateKey = deriveSessionStateKey(handle)
        if (event.type === "command.executed") {
          return
        }
        if (event.type === "session.deleted" || event.type === "session.error") {
          sessionStates.delete(stateKey)
          return
        }
        if (event.type === "session.created") {
          await withRuntime(payload, async (runtime) => {
            const state = getState(deriveSessionStateKey(runtime))
            await hydrateSessionStartContext(runtime, state)
            await log("info", "Honcho session initialized for OpenCode.", await runtimeStatus(payload))
          }, undefined)
          return
        }
        if (event.type === "message.part.updated") {
          const state = getState(stateKey)
          upsertAssistantMessagePart(state.assistantMessageParts, payload)
          return
        }
        if (event.type === "message.updated") {
          await withRuntime(payload, async (runtime) => {
            const state = getState(deriveSessionStateKey(runtime))
            await captureCompletedAssistantRecord(runtime, state, payload, `event.${event.type}`)
          }, undefined)
          return
        }
        if (event.type === "session.idle" || event.type === "session.compacted") {
          await withRuntime(payload, async () => {
            await log("info", "Honcho lifecycle boundary observed.", {
              event: event.type,
              ...(await runtimeStatus(payload)),
            })
          }, undefined)
          return
        }
      },
      "command.execute.before": async (input, output) => {
        const command = typeof input.command === "string" ? input.command : ""
        if (!command.startsWith("honcho:") && !command.startsWith("honcho-")) {
          return
        }
        output.parts = output.parts || []
      },
      "shell.env": async (input, output) => {
        const handle = await deriveRuntimeHandle(pluginInput, input, configPath)
        if (handle.config.apiKey) {
          output.env.HONCHO_API_KEY = handle.config.apiKey
        }
        output.env.HONCHO_URL = handle.config.baseUrl
        output.env.HONCHO_WORKSPACE_ID = handle.workspaceId
      },
      "chat.message": async (input, output) => {
        const message = extractText(output.parts)
        if (!message || message.startsWith("/")) {
          return
        }
        await withRuntime(input, async (runtime) => {
          const state = getState(deriveSessionStateKey(runtime))
          state.promptCount += 1
          await captureMessage(runtime, runtime.userPeer, message, {
            source: "chat.message",
            sessionId: runtime.sessionId,
          }, timestampToIso(output.message?.time?.created))
          const candidate = durableConclusionCandidate(message, runtime.config)
          if (candidate) {
            await maybeWriteConclusion(runtime, candidate, "chat.message")
          }
        }, undefined)
      },
      "experimental.chat.system.transform": async (input, output) => {
        const handle = await deriveRuntimeHandle(pluginInput, input, configPath)
        if (handle.config.recallMode === "tools" || !hasConfiguredAuth(handle.config)) {
          return
        }
        const query = extractPromptQuery(input)
        const trimmedQuery = query.trim()
        const hasQuery = trimmedQuery.length > 0
        const state = getState(deriveSessionStateKey(handle))
        const shouldInjectStable = !hasQuery && shouldInjectStableContext(state, INTERNAL_CONTEXT_REFRESH)
        const shouldSkip =
          (hasQuery && shouldSkipContextRetrieval(trimmedQuery, INTERNAL_CONTEXT_REFRESH)) ||
          (!hasQuery && !shouldInjectStable)
        if (shouldSkip) {
          return
        }
        await withRuntime(input, async (runtime) => {
          const state = getState(deriveSessionStateKey(runtime))
          if (!state.stableContext || shouldInjectStable) {
            const stableContextHydrated = await hydrateSessionStartContext(runtime, state)
            if (stableContextHydrated) {
              state.lastStableContextRefreshAt = Date.now()
            }
            if (shouldInjectStable && stableContextHydrated) {
              state.promptCount = 0
            }
          }
          const promptContext =
            hasQuery && (runtime.config.recallMode === "context" || runtime.config.recallMode === "hybrid")
              ? await refreshPromptContext(runtime, state, trimmedQuery)
              : null
          const compiledSections = [state.stableContext, promptContext].filter(
            (value): value is string => Boolean(value && value.trim()),
          )
          if (compiledSections.length === 0) {
            return
          }
          const compiled = compiledSections.join("\n\n")
          state.lastInjectedContext = compiled
          output.system = output.system || []
          output.system.push(
            `## Honcho Memory\nUse this as persistent project and user memory. Prefer it over guessing, but only mention it when relevant to the current task.\n\n${compiled}`,
          )
        }, undefined)
      },
      "experimental.chat.messages.transform": async (_input, output) => {
        void output
      },
      "experimental.session.compacting": async (input, output) => {
        const handle = await deriveRuntimeHandle(pluginInput, input, configPath)
        const state = getState(deriveSessionStateKey(handle))
        output.context = output.context || []
        output.context.push(
          [
            "## Honcho Continuity",
            `Workspace: ${handle.workspaceId}`,
            `Session key: ${handle.sessionKey}`,
            `Recall mode: ${handle.config.recallMode}`,
            `User peer: ${handle.userPeerId} (observe_me=true, observe_others=false)`,
            `Root agent peer: ${handle.rootAgentPeerId} (observe_me=true, observe_others=true)`,
            handle.childAgentPeerId
              ? `Child agent peer: ${handle.childAgentPeerId} (observe_me=true, observe_others=false, session_scoped=true)`
              : "Child agent peer: none",
            handle.parentAgentObserverPeerId
              ? `Parent observer peer: ${handle.parentAgentObserverPeerId} (observe_me=false, observe_others=true, models_only=${handle.childAgentPeerId || "none"})`
              : "Parent observer peer: none",
            state.lastInjectedContext ? `Last injected memory:\n${state.lastInjectedContext}` : "Last injected memory: none",
            state.recentConclusions.length > 0
              ? `Recent durable conclusions:\n- ${state.recentConclusions.join("\n- ")}`
              : "Recent durable conclusions: none",
          ].join("\n"),
        )
      },
      "tool.execute.before": async (_input, output) => {
        output.args = output.args
      },
      "tool.execute.after": async () => {
        return
      },
      tool: {
        honcho_get_config: tool({
          description: "Get the persisted and effective OpenCode Honcho settings, including workspace, peers, and session mapping.",
          args: { field: tool.schema.string().optional() },
          async execute(args, context) {
            const status = await runtimeStatus({ ...args, sessionID: context.sessionID })
            if (args.field) {
              return JSON.stringify({ field: args.field, value: lookupField(status, args.field) }, null, 2)
            }
            return JSON.stringify(status, null, 2)
          },
        }),
        honcho_setup: tool({
          description:
            "Validate Honcho setup for OpenCode and persist shared Honcho credentials or a localhost baseUrl to ~/.honcho/config.json when provided.",
          args: {
            apiKey: tool.schema.string().optional(),
            baseUrl: tool.schema.string().optional(),
            peerName: tool.schema.string().optional(),
            persistGlobal: tool.schema.boolean().optional(),
          },
          async execute(args, context) {
            let resolvedGlobalConfigPath = sharedGlobalSettingsPath()
            try {
              const handle = await deriveRuntimeHandle(pluginInput, { sessionID: context.sessionID }, configPath)
              resolvedGlobalConfigPath = handle.globalConfigPath
              const shouldPersistGlobal = args.persistGlobal !== false
              const globalPersisted = (await readJsonFile(handle.globalConfigPath)) ?? {}
              const nextGlobal = { ...globalPersisted }
              const nextHosts = isRecord(nextGlobal.hosts) ? { ...nextGlobal.hosts } : {}
              const providedApiKey = typeof args.apiKey === "string" ? args.apiKey.trim() : ""
              const providedBaseUrl = typeof args.baseUrl === "string" ? args.baseUrl.trim() : ""
              const providedPeerName = typeof args.peerName === "string" ? args.peerName.trim() : ""
              const effectiveApiKey = providedApiKey || handle.config.apiKey || ""
              const effectiveBaseUrl =
                providedBaseUrl || (providedApiKey ? DEFAULT_SETTINGS.baseUrl : handle.config.baseUrl || DEFAULT_SETTINGS.baseUrl)
              const effectivePeerName = providedPeerName || handle.config.peerName || currentUserName()
              const persistedFields: string[] = []

              if (!isLocalBaseUrl(effectiveBaseUrl) && effectiveApiKey) {
                await validateSetupConnection({
                  apiKey: effectiveApiKey,
                  baseUrl: effectiveBaseUrl,
                  workspaceId: handle.workspaceId,
                })
              }

              if (shouldPersistGlobal) {
                if (effectiveApiKey) {
                  nextGlobal[LEGACY_API_KEY_FIELD] = effectiveApiKey
                  persistedFields.push(LEGACY_API_KEY_FIELD)
                }
                nextGlobal.peerName = effectivePeerName
                if (!persistedFields.includes("peerName")) {
                  persistedFields.push("peerName")
                }
                nextGlobal.baseUrl = effectiveBaseUrl
                const nextResolved = mergeSettings(
                  normalizeScopedSettings(globalPersisted),
                  {
                    baseUrl: effectiveBaseUrl,
                  },
                )
                nextHosts.opencode = hostDefaults(nextResolved)
                nextGlobal.hosts = nextHosts
                if (providedBaseUrl || providedApiKey) {
                  persistedFields.push("baseUrl")
                }
                await writeSharedGlobalSettings(handle.globalConfigPath, nextGlobal)
              }

              const configured = hasConfiguredAuth({
                ...handle.config,
                apiKey: effectiveApiKey,
                baseUrl: effectiveBaseUrl,
              })
              return JSON.stringify(
                {
                  ok: configured,
                  globalConfigPath: handle.globalConfigPath,
                  persistedFields,
                  message: effectiveApiKey
                    ? effectiveBaseUrl === DEFAULT_SETTINGS.baseUrl
                      ? `Honcho setup is ready for cloud mode at ${DEFAULT_SETTINGS.baseUrl}.`
                      : `Honcho setup is ready with endpoint ${effectiveBaseUrl}.`
                    : isLocalBaseUrl(effectiveBaseUrl)
                      ? `Honcho setup is ready for local mode at ${effectiveBaseUrl}.`
                      : "No Honcho API key is configured. Pass one to /honcho:setup <key> or set HONCHO_API_KEY before running setup. For a local Honcho instance, set baseUrl to http://127.0.0.1:8000 or http://localhost:8000.",
                  status: await runtimeStatus({ sessionID: context.sessionID }),
                },
                null,
                2,
              )
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error)
              return JSON.stringify(
                {
                  ok: false,
                  globalConfigPath: resolvedGlobalConfigPath,
                  error: `Failed to validate or persist Honcho setup: ${detail}`,
                  message: "Honcho setup could not be validated or saved. Check the API key, endpoint, and config path, then retry.",
                },
                null,
                2,
              )
            }
          },
        }),
        honcho_status: tool({
          description: "Show effective Honcho status for this OpenCode project, including workspace, peers, sessions, and memory mode.",
          args: {},
          async execute(_args, context) {
            return JSON.stringify(await runtimeStatus({ sessionID: context.sessionID }), null, 2)
          },
        }),
        honcho_set_config: tool({
          description: "Persist a Honcho setting to ~/.honcho/config.json for future OpenCode sessions.",
          args: {
            field: tool.schema.string(),
            value: tool.schema.string(),
            confirm: tool.schema.boolean().optional(),
          },
          async execute(args, context) {
            const handle = await deriveRuntimeHandle(pluginInput, { sessionID: context.sessionID }, configPath)
            let field: string
            try {
              field = parseSettingField(args.field)
            } catch (error) {
              return JSON.stringify(
                { ok: false, error: error instanceof Error ? error.message : String(error) },
                null,
                2,
              )
            }
            const persisted = await readConfigFile(handle.configPath)
            const nextPersisted = { ...persisted }
            const nextValue = parseSettingValue(field, args.value)
            setSettingValue(nextPersisted, field, nextValue)
            await writeSettings(handle.configPath, nextPersisted)
            return JSON.stringify(
              {
                ok: true,
                configPath: handle.configPath,
                field,
                value: nextValue,
                status: await runtimeStatus({ sessionID: context.sessionID }),
              },
              null,
              2,
            )
          },
        }),
        honcho_search: tool({
          description: "Search Honcho session messages for this OpenCode project using the derived workspace and session mapping.",
          args: {
            query: tool.schema.string(),
            max_items: tool.schema.number().optional(),
          },
          async execute(args, context) {
            return JSON.stringify(
              await withRuntime<SearchToolResult>(
                { ...args, sessionID: context.sessionID },
                async (runtime) => {
                  const messages = await runtime.session.search(args.query, {
                    limit: args.max_items ?? 5,
                  })
                  return {
                    ok: true,
                    workspace: runtime.workspaceId,
                    sessionKey: runtime.sessionKey,
                    items: messages.map((message) => ({
                      id: message.id,
                      peerId: message.peerId,
                      content: message.content,
                    })),
                  }
                },
                { ok: false, items: [], error: "Honcho is unavailable for search." },
              ),
              null,
              2,
            )
          },
        }),
        honcho_chat: tool({
          description: "Ask Honcho for a reasoning-backed answer about this project using the current peer and session mapping.",
          args: { query: tool.schema.string() },
          async execute(args, context) {
            return JSON.stringify(
              await withRuntime<ChatToolResult>(
                { ...args, sessionID: context.sessionID },
                async (runtime) => ({
                  ok: true,
                  workspace: runtime.workspaceId,
                  sessionKey: runtime.sessionKey,
                  response:
                    (await runtime.agentPeer.chat(args.query, {
                      target: runtime.userPeer,
                      session: runtime.session,
                      reasoningLevel: INTERNAL_DIALECTIC_REASONING_LEVEL,
                    })) ?? "",
                }),
                { ok: false, response: null, error: "Honcho is unavailable for chat." },
              ),
              null,
              2,
            )
          },
        }),
        honcho_create_conclusion: tool({
          description: "Create a durable Honcho memory for this OpenCode project using the current peer and session mapping.",
          args: { content: tool.schema.string() },
          async execute(args, context) {
            const handle = await deriveRuntimeHandle(pluginInput, { ...args, sessionID: context.sessionID }, configPath)
            if (!hasConfiguredAuth(handle.config)) {
              return JSON.stringify(
                {
                  ok: false,
                  error: "Honcho is not configured with an API key or localhost baseUrl.",
                  workspace: handle.workspaceId,
                  sessionKey: handle.sessionKey,
                },
                null,
                2,
              )
            }

            try {
              const runtime = await createActiveRuntime(pluginInput, { ...args, sessionID: context.sessionID }, configPath)
              const content = clampText(args.content.trim(), INTERNAL_DIALECTIC_MAX_CHARS)
              const created = await maybeWriteConclusion(runtime, content, "tool.create_conclusion")
              return JSON.stringify(
                {
                  ok: created,
                  workspace: runtime.workspaceId,
                  sessionKey: runtime.sessionKey,
                  content,
                },
                null,
                2,
              )
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error)
              await log("error", "Honcho durable write failed.", {
                message: detail,
                sessionId: handle.sessionId,
                workspaceId: handle.workspaceId,
              })
              return JSON.stringify(
                {
                  ok: false,
                  error: detail,
                  workspace: handle.workspaceId,
                  sessionKey: handle.sessionKey,
                },
                null,
                2,
              )
            }
          },
        }),
      },
    }
  }

export const HonchoRuntimePlugin = createHonchoRuntimePlugin()
export const __testing = {
  createSessionState,
  deriveSessionStateKey,
  extractCompletedAssistantMessage,
  honchoSdkImportPath: "@honcho-ai/sdk",
  buildPeerTopology,
  defaultSettings: DEFAULT_SETTINGS,
  deriveSessionScope,
  markAssistantMessageCaptured,
  timestampToIso,
  upsertAssistantMessagePart,
  extractSessionId,
  normalizeId,
  sessionPeerAdditions,
}
export default HonchoRuntimePlugin
