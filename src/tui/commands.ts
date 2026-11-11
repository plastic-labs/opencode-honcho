import {
  DEFAULT_BASE_URL,
  OAuthError,
  isCloud,
  normalizeBaseUrl,
  pollForToken,
  requestDeviceCode,
  saveGrant,
  saveHost,
  suggestPeerName,
  type HostConfig,
  type OAuthTransport,
} from "@honcho-ai/harness-plugin-core"
import { CLI_OAUTH_CLIENT_ID, OAUTH_CLIENT_ID, createHonchoClient } from "../honcho-client.js"
import { executeOpenCodeImport, planOpenCodeImport } from "../import.js"
import {
  HOST,
  HOST_FIELDS,
  honchoSessionId,
  hostFieldPatch,
  isRecord,
  loadSettings,
  migrateConfig,
  readConfig,
  resolveConfigPath,
  LEGACY,
  type HostField,
  type Settings,
} from "../core.js"
import type { TuiCommandSpec, TuiSession } from "./dialogs.js"

export { resolveConfigPath }

/** Settings after moving an older config into hosts.opencode, the same way the runtime does. */
const currentSettings = async (refresh = false) => {
  const configPath = resolveConfigPath()
  await migrateConfig(configPath)
  return loadSettings(configPath, { refresh })
}

const hostBlock = (configPath: string): Record<string, unknown> => {
  const file = readConfig(configPath)
  const hosts = isRecord(file.hosts) ? file.hosts : {}
  return isRecord(hosts[HOST]) ? hosts[HOST] : {}
}

export const describeAuth = (s: Pick<Settings, "auth" | "baseUrl">) => {
  const auth = s.auth
  if (!auth) return isCloud(s.baseUrl) ? "not signed in" : "none (self-hosted without auth)"
  if (auth.source === "env") return "HONCHO_API_KEY env var"
  if (auth.source === "apiKey") return "API key"
  if (auth.reauthRequired) return "Honcho sign-in expired; run /honcho:login"
  const minutes = auth.expiresAt ? Math.round((auth.expiresAt - Date.now() / 1000) / 60) : 0
  return minutes > 0 ? `signed in with Honcho (token refreshes in ${minutes}m)` : "signed in with Honcho (token refreshes on next use)"
}

export const statusMessage = (s: Settings, live: { openCodeSessionId?: string } = {}) =>
  [
    `Configured: ${s.configured ? "yes" : "no"}`,
    `Auth: ${describeAuth(s)}`,
    `Base URL: ${s.baseUrl}${isCloud(s.baseUrl) ? " (Honcho Cloud)" : " (self-hosted)"}`,
    `Workspace: ${s.workspace}`,
    `Peer name: ${s.peerName}`,
    `AI peer: ${s.aiPeer}`,
    ...(live.openCodeSessionId ? [`Honcho session: ${honchoSessionId(live.openCodeSessionId)}`] : []),
    `Config: hosts.${HOST} in ${s.configPath}`,
    "",
    s.configured ? "Honcho is ready for OpenCode." : "Run /honcho:setup or /honcho:login to finish configuration.",
    ...s.warnings.map((warning) => `\n${warning} Run \`honcho doctor\` to fix it.`),
  ].join("\n")

/** What is saved in hosts.opencode, with secrets masked. */
export const settingsMessage = (configPath: string) => {
  const block = hostBlock(configPath)
  const oauth = isRecord(block.oauth) ? block.oauth : null
  const show = (key: string) => (typeof block[key] === "string" && block[key] ? String(block[key]) : "(default)")
  return [
    `Config: hosts.${HOST} in ${configPath}`,
    `apiKey: ${typeof block.apiKey === "string" && block.apiKey ? "set" : "not set"}`,
    `oauth: ${oauth ? `signed in (client ${String(oauth.clientId || "?")})` : "not signed in"}`,
    `peerName: ${show("peerName")}`,
    `workspace: ${show("workspace")}`,
    `aiPeer: ${show("aiPeer")}`,
    `baseUrl: ${typeof block.baseUrl === "string" && block.baseUrl ? block.baseUrl : `(Honcho Cloud, ${DEFAULT_BASE_URL})`}`,
  ].join("\n")
}

export const validateCloudApiKey = (value: string) =>
  value.trim() ? null : "Honcho Cloud requires a Honcho API key. Enter a non-empty key, or sign in with /honcho:login."

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Start a device sign-in with this plugin's own OAuth client, or the honcho CLI's while Honcho
 * cloud does not know ours yet. Polling must use the client the code was issued to.
 */
export const startDeviceSignIn = async (transport: OAuthTransport = {}) => {
  try {
    return { clientId: OAUTH_CLIENT_ID, device: await requestDeviceCode({ ...transport, clientId: OAUTH_CLIENT_ID, source: "opencode" }) }
  } catch (error) {
    if (!(error instanceof OAuthError) || (error.code !== "invalid_client" && error.code !== "unauthorized_client")) throw error
    return { clientId: CLI_OAUTH_CLIENT_ID, device: await requestDeviceCode({ ...transport, clientId: CLI_OAUTH_CLIENT_ID, source: "opencode" }) }
  }
}

/** Device sign-in to Honcho Cloud; the grant is saved to hosts.opencode.oauth. */
export const runLogin = async (session: TuiSession, intro: string[] = []) => {
  const configPath = resolveConfigPath()
  const s = await currentSettings()
  if (!isCloud(s.baseUrl)) {
    await session.dialogs.alert({
      title: "Honcho sign-in",
      message: `Sign-in is for Honcho Cloud. This config points at ${s.baseUrl}; a self-hosted Honcho uses an API key (/honcho:setup).`,
    })
    return false
  }
  let signIn: Awaited<ReturnType<typeof startDeviceSignIn>>
  try {
    signIn = await startDeviceSignIn()
  } catch (error) {
    await session.dialogs.alert({
      title: "Honcho sign-in",
      message: `Could not start sign-in: ${error instanceof Error ? error.message : String(error)}\nYou can paste an API key from app.honcho.dev with /honcho:setup instead.`,
    })
    return false
  }
  const { device, clientId } = signIn
  let cancelled = false
  let finished = false
  const polling = pollForToken(device, {
    clientId,
    sleep: async (ms) => {
      await delay(ms)
      if (cancelled) throw new OAuthError("access_denied", "Sign-in cancelled.")
    },
  })
  void session.dialogs
    .alert({
      title: "Sign in to Honcho",
      message: [
        ...intro,
        `Open ${device.verificationUriComplete}`,
        `and confirm the code ${device.userCode}.`,
        "",
        "Waiting for approval. Close this dialog to cancel.",
      ].join("\n"),
    })
    .then(() => {
      if (!finished) cancelled = true
    })
  try {
    const tokens = await polling
    finished = true
    await saveGrant(configPath, HOST, tokens)
    await session.dialogs.alert({
      title: "Signed in to Honcho",
      message: `Saved the sign-in to hosts.${HOST} in ${configPath}. New OpenCode sessions use it.`,
    })
    return true
  } catch (error) {
    finished = true
    if (cancelled) return false
    await session.dialogs.alert({
      title: "Honcho sign-in failed",
      message: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

export const runSetup = async (session: TuiSession) => {
  const mode = await session.dialogs.select<"login" | "cloud" | "local">({
    title: "Configure Honcho",
    options: [
      { title: "Sign in to Honcho Cloud", value: "login", description: "Approve OpenCode in your browser" },
      { title: "Honcho Cloud API key", value: "cloud", description: "Paste a key from app.honcho.dev" },
      { title: "Self-hosted", value: "local", description: "Your own Honcho server" },
    ],
  })
  if (!mode) return

  const configPath = resolveConfigPath()
  await migrateConfig(configPath)
  const patch: Partial<HostConfig> = {}
  if (mode === "local") {
    const entered = await session.dialogs.prompt({
      title: "Honcho API base URL",
      placeholder: "http://127.0.0.1:8000",
      value: "http://127.0.0.1:8000",
    })
    if (entered === undefined) return
    const baseUrl = normalizeBaseUrl(entered.trim() || "http://127.0.0.1:8000")
    const apiKey = await session.dialogs.prompt({
      title: "Honcho API key (optional)",
      placeholder: "Leave blank if your server runs without auth",
    })
    if (apiKey === undefined) return
    patch.baseUrl = baseUrl === DEFAULT_BASE_URL ? undefined : baseUrl
    if (apiKey.trim()) patch.apiKey = apiKey.trim()
  } else {
    patch.baseUrl = undefined
    if (mode === "cloud") {
      const apiKey = await session.dialogs.prompt({ title: "Honcho API key", placeholder: "hch-..." })
      if (apiKey === undefined) return
      const validationError = validateCloudApiKey(apiKey)
      if (validationError) {
        await session.dialogs.alert({ title: "Honcho setup incomplete", message: validationError })
        return
      }
      patch.apiKey = apiKey.trim()
    }
  }

  // The user's name in Honcho: what other Honcho plugins already use, else $USER.
  const block = hostBlock(configPath)
  const suggested = typeof block.peerName === "string" && block.peerName ? block.peerName : suggestPeerName(readConfig(configPath))
  const peerName = await session.dialogs.prompt({ title: "Your name in Honcho (peerName)", value: suggested })
  if (peerName === undefined) return
  if (peerName.trim()) patch.peerName = peerName.trim()

  await saveHost(configPath, HOST, patch, LEGACY)
  const summary = [`Saved to hosts.${HOST} in ${configPath}`, `Peer name: ${peerName.trim() || suggested}`]
  if (mode === "login") {
    await runLogin(session, [...summary, ""])
    return
  }
  const s = await currentSettings()
  await session.dialogs.alert({ title: "Honcho configured", message: [...summary, "", statusMessage(s)].join("\n") })
}

export const runStatus = async (session: TuiSession) => {
  const s = await currentSettings()
  await session.dialogs.alert({ title: "Honcho Status", message: statusMessage(s, session.liveStatus()) })
}

export const runSettings = async (session: TuiSession) => {
  const configPath = resolveConfigPath()
  await migrateConfig(configPath)
  await session.dialogs.alert({ title: "Honcho Settings", message: settingsMessage(configPath) })
}

export const runConfig = async (session: TuiSession) => {
  const configPath = resolveConfigPath()
  await migrateConfig(configPath)
  const field = await session.dialogs.select<HostField>({
    title: `Which hosts.${HOST} field should change?`,
    options: HOST_FIELDS.map((value) => ({
      title: value,
      value,
      description: value === "baseUrl" ? "self-hosted only; blank = Honcho Cloud" : value === "apiKey" ? "blank removes it" : "blank = default",
    })),
  })
  if (!field) return
  const block = hostBlock(configPath)
  const current = field === "apiKey" ? "" : typeof block[field] === "string" ? String(block[field]) : ""
  const value = await session.dialogs.prompt({ title: `${field}:`, value: current })
  if (value === undefined) return
  try {
    await saveHost(configPath, HOST, hostFieldPatch(field, value), LEGACY)
    await session.dialogs.alert({
      title: "Honcho config updated",
      message: [`Saved ${field} to hosts.${HOST} in ${configPath}.`, "Open sessions keep the old value until restarted."].join("\n"),
    })
  } catch (error) {
    await session.dialogs.alert({
      title: "Honcho config update failed",
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

const formatImportPreview = (plan: Awaited<ReturnType<typeof planOpenCodeImport>>) => {
  const lines = [
    `Source: ${plan.source}`,
    `Window: last ${plan.days} days`,
    `Ready to import: ${plan.sessionCount} session(s), ${plan.messageCount} message(s)`,
    `Already imported: ${plan.alreadyImportedCount}`,
    `Skipped empty: ${plan.skippedCount}`,
    "",
  ]
  for (const session of plan.sessions.filter((item) => !item.skippedReason).slice(0, 12)) {
    lines.push(`- ${session.title} (${session.messageCount} msg)`)
  }
  if (plan.sessionCount > 12) lines.push(`- … and ${plan.sessionCount - 12} more`)
  return lines.join("\n")
}

export const runImport = async (session: TuiSession) => {
  const s = await currentSettings(true)
  if (!s.configured) {
    await session.dialogs.alert({
      title: "Honcho import",
      message: "Run /honcho:setup before importing local OpenCode transcripts.",
    })
    return
  }

  let plan: Awaited<ReturnType<typeof planOpenCodeImport>>
  try {
    plan = await planOpenCodeImport({ source: session.transcripts, workspaceId: s.workspace })
  } catch (error) {
    await session.dialogs.alert({
      title: "Honcho import",
      message: error instanceof Error ? error.message : String(error),
    })
    return
  }

  const preview = formatImportPreview(plan)
  if (plan.sessionCount === 0) {
    await session.dialogs.alert({ title: "Honcho import", message: `${preview}\n\nNothing new to import.` })
    return
  }

  const choice = await session.dialogs.select<"preview" | "upload">({
    title: "Import local OpenCode transcripts into Honcho?",
    options: [
      { title: "Preview only", value: "preview", description: "Do not upload" },
      { title: "Upload now", value: "upload", description: "Sends conversation content to Honcho" },
    ],
  })
  if (choice !== "upload") {
    if (choice === "preview") await session.dialogs.alert({ title: "Honcho import preview", message: preview })
    return
  }

  try {
    const honcho = createHonchoClient({ apiKey: s.token, baseUrl: s.baseUrl, workspaceId: s.workspace })
    const result = await executeOpenCodeImport({
      source: session.transcripts,
      workspaceId: s.workspace,
      honcho,
      userPeerId: s.peerName,
      agentPeerId: s.aiPeer,
    })
    await session.dialogs.alert({
      title: "Honcho import",
      message: [
        `Imported ${result.uploadedMessages} message(s) across ${result.uploadedSessions} session(s) into ${s.workspace}.`,
        result.errors.length > 0
          ? `${result.errors.length} session(s) failed.`
          : "Honcho will reason over them; no restart needed.",
      ].join("\n"),
    })
  } catch (error) {
    await session.dialogs.alert({
      title: "Honcho import failed",
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

export const COMMANDS: readonly TuiCommandSpec[] = [
  {
    id: "honcho.setup",
    title: "Honcho Setup",
    description: "Connect OpenCode to Honcho Cloud (sign in or API key) or a self-hosted Honcho",
    slash: "honcho:setup",
    run: runSetup,
  },
  {
    id: "honcho.login",
    title: "Honcho Login",
    description: "Sign in to Honcho Cloud in your browser",
    slash: "honcho:login",
    run: async (session) => {
      await runLogin(session)
    },
  },
  {
    id: "honcho.status",
    title: "Honcho Status",
    description: "Show Honcho status for the current OpenCode session",
    slash: "honcho:status",
    run: runStatus,
  },
  {
    id: "honcho.settings",
    title: "Honcho Settings",
    description: "Show what is saved in hosts.opencode in ~/.honcho/config.json",
    slash: "honcho:settings",
    run: runSettings,
  },
  {
    id: "honcho.config",
    title: "Honcho Config",
    description: "Edit one hosts.opencode field in ~/.honcho/config.json",
    slash: "honcho:config",
    run: runConfig,
  },
  {
    id: "honcho.import",
    title: "Honcho Import",
    description: "Preview or import local OpenCode transcripts into Honcho",
    slash: "honcho:import",
    run: runImport,
  },
]

export const runGuarded = async (session: TuiSession, command: TuiCommandSpec) => {
  try {
    await command.run(session)
  } catch (error) {
    await session.dialogs.alert({
      title: command.title,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
