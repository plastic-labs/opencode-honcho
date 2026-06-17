import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const PACKAGE_ID = "@honcho-ai/opencode-honcho"
const DEFAULT_BASE_URL = "https://api.honcho.dev"
const SHARED_SETTINGS_DIR_NAME = ".honcho"
const SHARED_SETTINGS_FILE_NAME = "config.json"

const SHARED_CONFIG_PRESETS: Record<string, readonly string[]> = {
  recallmode: ["hybrid", "context", "tools"],
  observationmode: ["directional"],
  peermodel: ["classic", "hierarchical"],
  sessionstrategy: ["per-repo", "per-directory", "per-session", "global", "git-branch", "chat-instance"],
  dialecticreasoninglevel: ["minimal", "low", "medium", "high", "max"],
}

const MODE_EDITABLE_FIELD_PATHS = [
  "apiKey",
  "baseUrl",
  "peerName",
  "hosts.opencode.workspace",
  "hosts.opencode.aiPeer",
  "hosts.opencode.recallMode",
  "hosts.opencode.sessionStrategy",
] as const

type GlobalSettings = {
  apiKey?: string
  peerName?: string
  baseUrl?: string
  hosts?: {
    opencode?: {
      workspace?: string
      aiPeer?: string
      recallMode?: "hybrid" | "context" | "tools"
      sessionStrategy?: "per-repo" | "per-directory" | "per-session" | "global" | "git-branch" | "chat-instance"
    }
  }
}

const globalSettingsPath = () =>
  path.join(process.env.HOME || process.env.USERPROFILE || homedir(), SHARED_SETTINGS_DIR_NAME, SHARED_SETTINGS_FILE_NAME)

const sharedConfigPath = () =>
  path.join(process.env.HOME || process.env.USERPROFILE || homedir(), SHARED_SETTINGS_DIR_NAME, SHARED_SETTINGS_FILE_NAME)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

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

const readSharedConfig = async (): Promise<Record<string, unknown> | null> => {
  const configPath = sharedConfigPath()
  try {
    const raw = await readFile(configPath, "utf-8")
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed)) {
      throw new Error(`${configPath} must contain a JSON object at the top level.`)
    }
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null
    }
    throw error
  }
}

const writeSharedConfig = async (settings: Record<string, unknown>) => {
  const configPath = sharedConfigPath()
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(configPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8")
  return configPath
}

const listSharedConfigFields = (value: Record<string, unknown>, prefix = ""): string[] =>
  Object.entries(value).flatMap(([key, entryValue]) => {
    const nextKey = prefix ? `${prefix}.${key}` : key
    if (isRecord(entryValue) && Object.keys(entryValue).length > 0) {
      return listSharedConfigFields(entryValue, nextKey)
    }
    return [nextKey]
  })

const getNestedValue = (value: Record<string, unknown>, fieldPath: string): unknown =>
  fieldPath.split(".").reduce<unknown>((current, part) => {
    if (!isRecord(current)) return undefined
    return current[part]
  }, value)

const setNestedValue = (value: Record<string, unknown>, fieldPath: string, nextValue: unknown) => {
  const parts = fieldPath.split(".")
  let current: Record<string, unknown> = value
  for (const part of parts.slice(0, -1)) {
    const existing = current[part]
    if (!isRecord(existing)) {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }
  current[parts.at(-1) as string] = nextValue
}

const resolveSharedConfigField = (config: Record<string, unknown>, field: string) => {
  const canonical = listSharedConfigFields(config).find(
    (candidate) => candidate.toLowerCase() === field.trim().toLowerCase(),
  )
  if (!canonical) {
    throw new Error(`Field '${field}' does not exist in ${sharedConfigPath()}.`)
  }
  return canonical
}

const modeEditableFieldPaths = () => [...MODE_EDITABLE_FIELD_PATHS]

const sharedConfigPresetOptions = (fieldPath: string, currentValue: unknown) => {
  const presetKey = fieldPath.split(".").at(-1)?.toLowerCase() || fieldPath.toLowerCase()
  if (SHARED_CONFIG_PRESETS[presetKey]) {
    return [...SHARED_CONFIG_PRESETS[presetKey]]
  }
  if (typeof currentValue === "boolean") {
    return ["true", "false"]
  }
  return []
}

const parseSharedConfigValue = (currentValue: unknown, rawValue: string) => {
  const trimmed = rawValue.trim()
  if (typeof currentValue === "boolean") {
    return trimmed.toLowerCase() === "true"
  }
  if (typeof currentValue === "number") {
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) {
      throw new Error(`Expected a number for this field, received '${rawValue}'.`)
    }
    return parsed
  }
  return trimmed
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
  peerName: typeof settings.peerName === "string" ? settings.peerName.trim() : "",
})

const validateCloudApiKey = (value: string) =>
  value.trim() ? null : "Honcho Cloud requires a Honcho API key. Enter a non-empty key or choose Self-hosted / local."

const deriveLiveStatus = (api: Parameters<TuiPlugin>[0], settings: GlobalSettings) => {
  const openCodeSessionId =
    api.route?.current?.name === "session" && typeof api.route.current.params?.sessionID === "string"
      ? api.route.current.params.sessionID
      : undefined
  const configuredWorkspace = settings.hosts?.opencode?.workspace
  const liveWorkspace =
    typeof configuredWorkspace === "string" && configuredWorkspace.trim()
      ? configuredWorkspace.trim()
      : path.basename(api.state?.path?.worktree || api.state?.path?.directory || "opencode")
  return {
    workspaceName: liveWorkspace,
    openCodeSessionId,
  }
}

const statusMessage = (
  settings: GlobalSettings,
  liveStatus?: { workspaceName?: string; openCodeSessionId?: string },
) => {
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
    `Peer name: ${normalized.peerName || "user"}`,
    ...(liveStatus?.workspaceName ? [`Workspace: ${liveStatus.workspaceName}`] : []),
    ...(liveStatus?.openCodeSessionId ? [`OpenCode session: ${liveStatus.openCodeSessionId}`] : []),
    `Config path: ${globalSettingsPath()}`,
    "",
    configured ? "Honcho is ready for OpenCode." : "Run /honcho:setup to finish configuration.",
  ].join("\n")
}

const settingsMessage = (settings: GlobalSettings) => {
  const host = settings.hosts?.opencode || {}
  return [
    `Config path: ${globalSettingsPath()}`,
    `API key: ${settings.apiKey?.trim() ? "set" : "not set"}`,
    `Peer name: ${settings.peerName?.trim() || "user"}`,
    `Base URL: ${settings.baseUrl?.trim() || DEFAULT_BASE_URL}`,
    `Workspace: ${host.workspace || "opencode"}`,
    `AI peer: ${host.aiPeer || "opencode"}`,
    `Recall mode: ${host.recallMode || "hybrid"}`,
    `Session strategy: ${host.sessionStrategy || "per-directory"}`,
  ].join("\n")
}

const saveSettings = async (partial: Partial<GlobalSettings>) => {
  const current = await readGlobalSettings()
  const sharedRaw = (await readSharedConfig()) ?? {}
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
  const currentHosts = isRecord(sharedRaw.hosts) ? { ...sharedRaw.hosts } : {}
  const currentOpenCodeHost = isRecord(currentHosts.opencode) ? currentHosts.opencode : {}
  currentHosts.opencode = {
    ...currentOpenCodeHost,
    workspace: partialHost?.workspace ?? current.hosts?.opencode?.workspace ?? "opencode",
    aiPeer: partialHost?.aiPeer ?? current.hosts?.opencode?.aiPeer ?? "opencode",
    recallMode: partialHost?.recallMode ?? current.hosts?.opencode?.recallMode ?? "hybrid",
    sessionStrategy: partialHost?.sessionStrategy ?? current.hosts?.opencode?.sessionStrategy ?? "per-directory",
  }

  const next: GlobalSettings & Record<string, unknown> = {
    ...sharedRaw,
    baseUrl:
      typeof partial.baseUrl === "string"
        ? partial.baseUrl
        : typeof current.baseUrl === "string"
          ? current.baseUrl
          : DEFAULT_BASE_URL,
    peerName: nextPeerName,
    hosts: currentHosts,
  }
  if (typeof nextApiKey === "string") {
    next.apiKey = nextApiKey
  } else {
    delete next.apiKey
  }
  return writeGlobalSettings(next)
}

const openStatusDialog = async (api: Parameters<TuiPlugin>[0]) => {
  const settings = await readGlobalSettings()
  const liveStatus = deriveLiveStatus(api, settings)
  api.ui.dialog.replace(() =>
    api.ui.DialogAlert({
      title: "Honcho Status",
      message: statusMessage(settings, liveStatus),
    }),
  )
}

const openSettingsDialog = async (api: Parameters<TuiPlugin>[0]) => {
  const settings = await readGlobalSettings()
  api.ui.dialog.replace(() =>
    api.ui.DialogAlert({
      title: "Honcho Settings",
      message: settingsMessage(settings),
    }),
  )
}

const openSetupConfirmation = async (
  api: Parameters<TuiPlugin>[0],
  partial: Partial<GlobalSettings>,
  summaryLines: string[],
) => {
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Peer name",
      placeholder: "Your Honcho peer name",
      value: typeof partial.peerName === "string" ? partial.peerName : "",
      onConfirm: async (peerName) => {
        const configPath = await saveSettings({
          ...partial,
          peerName: peerName.trim(),
        })
        api.ui.dialog.replace(() =>
          api.ui.DialogAlert({
            title: "Honcho configured",
            message: [`Saved settings to ${configPath}`, ...summaryLines, `Peer name: ${peerName.trim() || "user"}`].join(
              "\n",
            ),
          }),
        )
      },
      onCancel: () => api.ui.dialog.clear(),
    }),
  )
}

const openLocalApiKeyPrompt = (api: Parameters<TuiPlugin>[0], baseUrl: string) => {
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Optional Honcho API key",
      placeholder: "Leave blank for local unauthenticated mode",
      onConfirm: async (apiKey) => {
        await openSetupConfirmation(
          api,
          {
            apiKey: apiKey.trim(),
            baseUrl,
          },
          [`Base URL: ${baseUrl}`, `API key: ${apiKey.trim() ? "set" : "not required for localhost mode"}`],
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
        await openSetupConfirmation(
          api,
          {
            apiKey: apiKey.trim(),
            baseUrl: DEFAULT_BASE_URL,
          },
          [`Base URL: ${DEFAULT_BASE_URL}`, `API key: ${apiKey.trim() ? "set" : "not set"}`],
        )
      },
      onCancel: () => api.ui.dialog.clear(),
    }),
  )
}

const openModeValueDialog = async (
  api: Parameters<TuiPlugin>[0],
  config: Record<string, unknown>,
  fieldPath: string,
) => {
  const currentValue = getNestedValue(config, fieldPath)
  const presetOptions = sharedConfigPresetOptions(fieldPath, currentValue)

  const persistValue = async (rawValue: string) => {
    try {
      const nextConfig = structuredClone(config)
      const nextValue = parseSharedConfigValue(currentValue, rawValue)
      setNestedValue(nextConfig, fieldPath, nextValue)
      const configPath = await writeSharedConfig(nextConfig)
      api.ui.dialog.replace(() =>
        api.ui.DialogAlert({
      title: "Honcho config updated",
          message: [`Saved settings to ${configPath}`, `Field: ${fieldPath}`, `Value: ${String(nextValue)}`].join("\n"),
        }),
      )
    } catch (error) {
      api.ui.dialog.replace(() =>
        api.ui.DialogAlert({
          title: "Honcho config update failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }

  if (presetOptions.length > 0) {
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect({
        title: `What should it be set to: ${presetOptions.join(", ")}`,
        flat: true,
        options: presetOptions.map((option) => ({
          title: option,
          value: option,
        })),
        onSelect: (option) => {
          void persistValue(String(option.value))
        },
      }),
    )
    return
  }

  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "What should it be set to:",
      value: currentValue === undefined ? "" : String(currentValue),
      onConfirm: (value) => {
        void persistValue(value)
      },
      onCancel: () => api.ui.dialog.clear(),
    }),
  )
}

const openModeDialog = async (api: Parameters<TuiPlugin>[0]) => {
  let config: Record<string, unknown> | null
  try {
    config = await readSharedConfig()
  } catch (error) {
    api.ui.dialog.replace(() =>
      api.ui.DialogAlert({
        title: "Honcho config invalid",
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return
  }
  if (!config) {
    api.ui.dialog.replace(() =>
      api.ui.DialogAlert({
        title: "Honcho config missing",
        message: `The config does not exist at ${sharedConfigPath()}.`,
      }),
    )
    return
  }

  const fieldPaths = modeEditableFieldPaths()
  if (fieldPaths.length === 0) {
    api.ui.dialog.replace(() =>
      api.ui.DialogAlert({
        title: "Honcho config empty",
        message: `No editable fields were found in ${sharedConfigPath()}.`,
      }),
    )
    return
  }

  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Which field should be modified?",
      options: fieldPaths.map((fieldPath) => ({
        title: fieldPath,
        value: fieldPath,
      })),
      onSelect: (option) => {
        void openModeValueDialog(api, config, String(option.value))
      },
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

const buildCommands = (api: Parameters<TuiPlugin>[0]) => [
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
    description: "Show Honcho runtime health for the current OpenCode session",
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
    description: "Show effective Honcho config values for OpenCode",
    category: "Honcho",
    slash: {
      name: "honcho:settings",
    },
    onSelect: () => {
      void openSettingsDialog(api)
    },
  },
  {
    title: "Honcho Config",
    value: "honcho.config",
    description: "Edit shared Honcho config fields from ~/.honcho/config.json",
    category: "Honcho",
    slash: {
      name: "honcho:config",
    },
    onSelect: () => {
      void openModeDialog(api)
    },
  },
]

const tui: TuiPlugin = async (api) => {
  api.command.register(() => buildCommands(api))
}

const plugin: TuiPluginModule & { id: string } = {
  id: PACKAGE_ID,
  tui,
}

export const __testing = {
  buildCommands,
  deriveLiveStatus,
  normalizeSettings,
  modeEditableFieldPaths,
  readSharedConfig,
  resolveSharedConfigField,
  saveSettings,
  settingsMessage,
  sharedConfigPath,
  sharedConfigPresetOptions,
  statusMessage,
  validateCloudApiKey,
}

export default plugin
