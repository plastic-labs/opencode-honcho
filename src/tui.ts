import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const PACKAGE_ID = "@honcho-ai/opencode-honcho"
const DEFAULT_BASE_URL = "https://api.honcho.dev"
const SHARED_SETTINGS_DIR_NAME = ".honcho"
const SHARED_SETTINGS_FILE_NAME = "config.json"

type GlobalSettings = {
  apiKey?: string
  peerName?: string
  baseUrl?: string
  hosts?: {
    opencode?: {
      workspace?: string
      aiPeer?: string
      recallMode?: "hybrid" | "context" | "tools"
      observationMode?: "directional" | "unified"
      sessionStrategy?: "per-repo" | "per-directory" | "per-session" | "global" | "git-branch" | "chat-instance"
    }
  }
}

const globalSettingsPath = () =>
  path.join(process.env.HOME || process.env.USERPROFILE || homedir(), SHARED_SETTINGS_DIR_NAME, SHARED_SETTINGS_FILE_NAME)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const isLocalBaseUrl = (value: string) => {
  if (!value.trim()) return false
  try {
    const url = new URL(value)
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  } catch {
    return false
  }
}

const readGlobalSettings = async (): Promise<GlobalSettings> => {
  const configPath = globalSettingsPath()
  try {
    const raw = await readFile(configPath, "utf-8")
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? (parsed as GlobalSettings) : {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {}
    }
    throw error
  }
}

const writeGlobalSettings = async (settings: GlobalSettings) => {
  const configPath = globalSettingsPath()
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(configPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8")
  return configPath
}

const normalizeSettings = (settings: GlobalSettings) => ({
  baseUrl:
    typeof settings.baseUrl === "string" && settings.baseUrl.trim()
      ? settings.baseUrl
      : DEFAULT_BASE_URL,
  apiKey:
    typeof settings.apiKey === "string" && settings.apiKey.trim() ? settings.apiKey.trim() : "",
})

const validateCloudApiKey = (value: string) =>
  value.trim() ? null : "Honcho Cloud requires a Honcho API key. Enter a non-empty key or choose Self-hosted / local."

const statusMessage = (settings: GlobalSettings) => {
  const normalized = normalizeSettings(settings)
  const configured = Boolean(normalized.apiKey) || isLocalBaseUrl(normalized.baseUrl)
  const deployment = isLocalBaseUrl(normalized.baseUrl)
    ? "Local / self-hosted"
    : normalized.baseUrl === DEFAULT_BASE_URL
      ? "Honcho Cloud"
      : "Custom endpoint"
  return [
    `Configured: ${configured ? "yes" : "no"}`,
    `Deployment: ${deployment}`,
    `Base URL: ${normalized.baseUrl}`,
    `API key: ${normalized.apiKey ? "set" : "not set"}`,
    `Config path: ${globalSettingsPath()}`,
    "",
    configured ? "Honcho is ready for OpenCode." : "Run /honcho:setup to finish configuration.",
  ].join("\n")
}

const saveSettings = async (partial: Partial<GlobalSettings>) => {
  const current = await readGlobalSettings()
  const partialHost = partial.hosts?.opencode
  const nextApiKey =
    typeof partial.apiKey === "string"
      ? partial.apiKey
      : typeof current.apiKey === "string"
        ? current.apiKey
        : undefined
  const nextPeerName =
    typeof partial.peerName === "string" && partial.peerName.trim()
      ? partial.peerName.trim()
      : typeof current.peerName === "string" && current.peerName.trim()
        ? current.peerName.trim()
        : "user"
  const next: GlobalSettings = {
    baseUrl:
      typeof partial.baseUrl === "string"
        ? partial.baseUrl
        : typeof current.baseUrl === "string"
          ? current.baseUrl
          : DEFAULT_BASE_URL,
    peerName: nextPeerName,
    apiKey: nextApiKey,
    hosts: {
      ...current.hosts,
      opencode: {
        workspace: partialHost?.workspace ?? current.hosts?.opencode?.workspace ?? "opencode",
        aiPeer: partialHost?.aiPeer ?? current.hosts?.opencode?.aiPeer ?? "opencode",
        recallMode: partialHost?.recallMode ?? current.hosts?.opencode?.recallMode ?? "hybrid",
        observationMode: partialHost?.observationMode ?? current.hosts?.opencode?.observationMode ?? "directional",
        sessionStrategy: partialHost?.sessionStrategy ?? current.hosts?.opencode?.sessionStrategy ?? "per-directory",
      },
    },
  }
  return writeGlobalSettings(next)
}

const openStatusDialog = async (api: Parameters<TuiPlugin>[0]) => {
  const settings = await readGlobalSettings()
  api.ui.dialog.replace(() =>
    api.ui.DialogAlert({
      title: "Honcho Status",
      message: statusMessage(settings),
    }),
  )
}

const openLocalApiKeyPrompt = (api: Parameters<TuiPlugin>[0], baseUrl: string) => {
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Optional Honcho API key",
      placeholder: "Leave blank for local unauthenticated mode",
      onConfirm: async (apiKey) => {
        const configPath = await saveSettings({
          apiKey: apiKey.trim(),
          baseUrl,
        })
        api.ui.dialog.replace(() =>
          api.ui.DialogAlert({
            title: "Honcho configured",
            message: [
              `Saved settings to ${configPath}`,
              `Base URL: ${baseUrl}`,
              `API key: ${apiKey.trim() ? "set" : "not required for localhost mode"}`,
            ].join("\n"),
          }),
        )
      },
      onCancel: () => api.ui.dialog.clear(),
    }),
  )
}

const openLocalBaseUrlPrompt = (api: Parameters<TuiPlugin>[0]) => {
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Honcho API base URL",
      placeholder: "http://127.0.0.1:8000",
      value: "http://127.0.0.1:8000",
      onConfirm: (baseUrl) => openLocalApiKeyPrompt(api, baseUrl.trim() || "http://127.0.0.1:8000"),
      onCancel: () => api.ui.dialog.clear(),
    }),
  )
}

const openCloudApiKeyPrompt = (api: Parameters<TuiPlugin>[0]) => {
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Honcho API key",
      placeholder: "hch_...",
      onConfirm: async (apiKey) => {
        const validationError = validateCloudApiKey(apiKey)
        if (validationError) {
          api.ui.dialog.replace(() =>
            api.ui.DialogAlert({
              title: "Honcho setup incomplete",
              message: validationError,
            }),
          )
          return
        }
        const configPath = await saveSettings({
          apiKey: apiKey.trim(),
          baseUrl: DEFAULT_BASE_URL,
        })
        api.ui.dialog.replace(() =>
          api.ui.DialogAlert({
            title: "Honcho configured",
            message: [
              `Saved settings to ${configPath}`,
              `Base URL: ${DEFAULT_BASE_URL}`,
              `API key: ${apiKey.trim() ? "set" : "not set"}`,
            ].join("\n"),
          }),
        )
      },
      onCancel: () => api.ui.dialog.clear(),
    }),
  )
}

const openSetupDialog = (api: Parameters<TuiPlugin>[0]) => {
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Configure Honcho",
      flat: true,
      options: [
        {
          title: "Honcho Cloud",
          value: "cloud",
          description: "Use the default Honcho Cloud endpoint",
        },
        {
          title: "Self-hosted / local",
          value: "local",
          description: "Use a custom or localhost Honcho base URL",
        },
      ],
      onSelect: (option) => {
        if (option.value === "local") {
          openLocalBaseUrlPrompt(api)
          return
        }
        openCloudApiKeyPrompt(api)
      },
    }),
  )
}

const tui: TuiPlugin = async (api) => {
  api.command.register(() => [
    {
      title: "Honcho Setup",
      value: "honcho.setup",
      description: "Configure Honcho Cloud or local settings for OpenCode",
      category: "Honcho",
      slash: {
        name: "honcho:setup",
      },
      onSelect: () => openSetupDialog(api),
    },
    {
      title: "Honcho Status",
      value: "honcho.status",
      description: "Show Honcho configuration status for OpenCode",
      category: "Honcho",
      slash: {
        name: "honcho:status",
      },
      onSelect: () => {
        void openStatusDialog(api)
      },
    },
    {
      title: "Honcho Settings",
      value: "honcho.settings",
      description: "Show Honcho defaults and config path information",
      category: "Honcho",
      slash: {
        name: "honcho:settings",
      },
      onSelect: () => {
        void openStatusDialog(api)
      },
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id: PACKAGE_ID,
  tui,
}

export const __testing = {
  normalizeSettings,
  saveSettings,
  statusMessage,
  validateCloudApiKey,
}

export default plugin
