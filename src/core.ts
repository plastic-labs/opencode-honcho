import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir, hostname } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import {
  DEFAULT_BASE_URL,
  configPath as sharedConfigPath,
  ensureFreshCredential,
  normalizeBaseUrl,
  isCloud,
  migrateHost,
  opencodeHonchoReader,
  pickCredential,
  readConfigFile,
  resolveConfig,
  type Credential,
  type HostConfig,
} from "@honcho-ai/harness-plugin-core"

/** This plugin's block in `~/.honcho/config.json`: `hosts.opencode`. */
export const HOST = "opencode"

/**
 * How opencode-honcho 0.2.1 and earlier read the file. Until `hosts.opencode` is migrated,
 * every read and write goes through it, so the plugin keeps the key, server, workspace and
 * peer (`user-<peerName>` unless `removeUserPrefix` was set) that the old version used.
 */
export const LEGACY = opencodeHonchoReader

export const DEFAULTS = { workspace: "opencode", aiPeer: "opencode" } as const

/** Keys earlier versions kept in `hosts.opencode` that this one no longer reads. */
export const DEAD_HOST_KEYS = [
  "recallMode",
  "observationMode",
  "sessionStrategy",
  "removeUserPrefix",
  "agentObserveMe",
  "linkedHosts",
  "globalOverride",
  "observation",
] as const

/** Both peers join every session with Honcho's defaults: each models itself, neither models the other. */
export const PEER_CONFIG = { observeMe: true, observeOthers: false } as const

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const timestampToIso = (value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return new Date(value).toISOString()
}

export const userHomeDir = () => process.env.HOME || process.env.USERPROFILE || homedir()

/** `OPENCODE_HONCHO_CONFIG_PATH` (or a plugin option), else the shared `~/.honcho/config.json`. */
export const resolveConfigPath = (override?: string) => {
  const explicit = override || process.env.OPENCODE_HONCHO_CONFIG_PATH
  return explicit ? path.resolve(explicit) : sharedConfigPath()
}

export const readConfig = (configPath: string) => readConfigFile({ HONCHO_CONFIG_PATH: configPath })

/** Honcho ids allow letters, digits, `_` and `-`; anything else becomes `-`. */
export const toHonchoId = (value: string, fallback: string) =>
  value.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || fallback

/** The Honcho session for an OpenCode session: its own id, sanitized. */
export const honchoSessionId = (openCodeSessionId: string) => toHonchoId(openCodeSessionId, "session")

// HONCHO_URL predates HONCHO_BASE_URL in this plugin; keep honoring it.
const configEnv = () => ({
  ...process.env,
  HONCHO_BASE_URL: process.env.HONCHO_BASE_URL || process.env.HONCHO_URL,
})

export type Settings = {
  configPath: string
  peerName: string
  workspace: string
  aiPeer: string
  /** Honcho API origin; the SDK appends `/v3`. */
  baseUrl: string
  /** Bearer to send. Empty only for a self-hosted Honcho without auth. */
  token: string
  auth: Omit<Credential, "token"> | null
  /** A credential, or a self-hosted baseUrl (which may run without auth). */
  configured: boolean
  /** Problems in the config file; `honcho doctor` fixes them. */
  warnings: string[]
}

/**
 * Settings for this plugin, highest wins: `HONCHO_*` env → `hosts.opencode` → defaults.
 * Nothing is read from the top level. With `refresh`, an OAuth grant near expiry is
 * refreshed first, so call this before each batch of requests.
 */
export const loadSettings = async (configPath: string, { refresh = true } = {}): Promise<Settings> => {
  const env = configEnv()
  const file = readConfig(configPath)
  const resolved = resolveConfig(file, { host: HOST, env, defaults: DEFAULTS, legacy: LEGACY })
  const credential = refresh
    ? await ensureFreshCredential({ path: configPath, host: HOST, baseUrl: resolved.baseUrl, env, legacy: LEGACY })
    : pickCredential(file, { host: HOST, baseUrl: resolved.baseUrl, env, legacy: LEGACY })
  const peerName = toHonchoId(resolved.peerName, "user")
  const aiPeer = toHonchoId(resolved.aiPeer, DEFAULTS.aiPeer)
  const warnings = [...resolved.warnings]
  if (peerName === aiPeer) {
    warnings.push(`peerName and aiPeer are both "${peerName}"; set different values in hosts.${HOST} so the user and the assistant stay separate peers.`)
  }
  const { token, ...auth } = credential ?? { token: "" }
  return {
    configPath,
    peerName,
    workspace: toHonchoId(resolved.workspace, DEFAULTS.workspace),
    aiPeer,
    baseUrl: resolved.baseUrl,
    token,
    auth: credential ? (auth as Omit<Credential, "token">) : null,
    configured: (Boolean(credential) || !isCloud(resolved.baseUrl)) && peerName !== aiPeer,
    warnings,
  }
}

/** Settings a user can change in hosts.opencode (besides signing in). */
export const HOST_FIELDS = ["peerName", "workspace", "aiPeer", "baseUrl", "apiKey"] as const
export type HostField = (typeof HOST_FIELDS)[number]

/** A hosts.opencode patch for one field. Blank removes the key; so does Honcho cloud's own URL. */
export const hostFieldPatch = (field: HostField, raw: string): Partial<HostConfig> => {
  const value = raw.trim()
  if (field === "baseUrl") {
    const url = value ? normalizeBaseUrl(value) : ""
    return { baseUrl: url && url !== DEFAULT_BASE_URL ? url : undefined }
  }
  return { [field]: value || undefined }
}

/**
 * Write what opencode-honcho 0.2.1 was using into `hosts.opencode`, once, and drop the keys
 * this version no longer reads. Leaves the top level and other hosts' blocks alone. Returns
 * the settings it moved or removed; empty when the block is already current.
 */
export const migrateConfig = async (configPath: string) => {
  try {
    return await migrateHost(configPath, HOST, DEAD_HOST_KEYS, LEGACY)
  } catch {
    // Never block a session on this; the next start tries again.
    return []
  }
}

const execFileAsync = promisify(execFile)

/** Repository name for `cwd`, shared by every linked worktree; the directory name outside git. */
export const repoName = async (cwd: string) => {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd, timeout: 5000 })
    const dir = path.resolve(cwd, stdout.trim())
    return path.basename(dir) === ".git" ? path.basename(path.dirname(dir)) : path.basename(dir).replace(/\.git$/, "")
  } catch {
    return path.basename(path.resolve(cwd))
  }
}

const scopeName = (value: string) => value.toLowerCase().replace(/[^a-z0-9_-]/g, "-")

/** Scopes a new session joins: its repository and this machine's short hostname. */
export const sessionScopes = async (cwd: string) => {
  const names = [await repoName(cwd), hostname().split(".")[0]].map(scopeName).filter((name) => /[a-z0-9]/.test(name))
  return [...new Set(names)]
}

// Under Honcho's 25k-char per-message cap, with room for the [Part i/N] prefix.
const MAX_MESSAGE_CHARS = 24_000

/** Split a long message into `[Part i/N]` chunks at line or word boundaries. Never truncates. */
export const chunkContent = (content: string, maxSize = MAX_MESSAGE_CHARS): string[] => {
  if (content.length <= maxSize) return [content]
  const chunks: string[] = []
  let remaining = content
  while (remaining.length > 0) {
    if (remaining.length <= maxSize) {
      chunks.push(remaining)
      break
    }
    let split = remaining.lastIndexOf("\n", maxSize)
    if (split < maxSize * 0.25) split = remaining.lastIndexOf(" ", maxSize)
    if (split < maxSize * 0.25) split = maxSize
    chunks.push(remaining.slice(0, split))
    remaining = remaining.slice(split).trimStart()
  }
  return chunks.map((chunk, index) => `[Part ${index + 1}/${chunks.length}] ${chunk}`)
}

// "/compact", "/honcho:status", "/review 12". A prompt that opens with an absolute path
// ("/tmp is full") is text, so a name that exists at the filesystem root is not a command.
const SLASH_COMMAND = /^\/([\w:-]+)(?:\s|$)/

export const isSlashCommand = (prompt: string) => {
  const name = SLASH_COMMAND.exec(prompt.trim())?.[1]
  if (!name) return false
  return name.includes(":") || !existsSync(`/${name}`)
}
