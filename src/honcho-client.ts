import { readFileSync } from "node:fs"
import { Honcho } from "@honcho-ai/sdk"
import { setTelemetryHeaders, telemetryHeaders, type TelemetryIdentity } from "@honcho-ai/harness-plugin-core"

/** Host name sent as `X-Honcho-Host: opencode/<version> (<platform>)`. */
export const HOST_ID = "opencode"

/** Integration name sent as `X-Honcho-Plugin: opencode-honcho/<version>`. */
export const PLUGIN_ID = "opencode-honcho"

/** OAuth client registered for this plugin in Honcho cloud. */
export const OAUTH_CLIENT_ID = "opencode-honcho"

/** The honcho CLI's client, used for sign-in until Honcho cloud knows this plugin's own. */
export const CLI_OAUTH_CLIENT_ID = "honcho-cli"

let pluginVersion: string | undefined

/**
 * Plugin version from package.json, which sits one directory above both `src/` and the bundled
 * `dist/`. Read lazily and guarded so a bad path can never stop the plugin from loading.
 */
export const getPluginVersion = (): string => {
  if (pluginVersion) return pluginVersion
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version?: unknown }
    if (typeof pkg.version === "string" && pkg.version) return (pluginVersion = pkg.version)
  } catch {
    // fall through to "unknown"; the next call retries
  }
  return "unknown"
}

/** The identity fields only the running host knows: its version and the agent model in use. */
export type TelemetryOverrides = Pick<TelemetryIdentity, "hostVersion" | "model">

export type HonchoClientOptions = TelemetryOverrides & {
  apiKey: string
  baseUrl: string
  workspaceId: string
  timeout?: number
  maxRetries?: number
}

export const telemetryIdentity = (overrides: TelemetryOverrides = {}): TelemetryIdentity => ({
  host: HOST_ID,
  plugin: PLUGIN_ID,
  pluginVersion: getPluginVersion(),
  ...(overrides.hostVersion ? { hostVersion: overrides.hostVersion } : {}),
  ...(overrides.model ? { model: overrides.model } : {}),
})

/** Every Honcho client the plugin builds goes through here so the telemetry headers ride on every request. */
export const createHonchoClient = (options: HonchoClientOptions) =>
  new Honcho({
    apiKey: options.apiKey || undefined,
    baseURL: options.baseUrl || undefined,
    workspaceId: options.workspaceId,
    timeout: options.timeout,
    maxRetries: options.maxRetries,
    defaultHeaders: telemetryHeaders(telemetryIdentity(options)),
  })

/**
 * Point a long-lived client at the current credential and agent model. Sessions and peers share
 * the client's HTTP object, so they pick both up; an OAuth refresh supersedes the old token.
 */
export const refreshClient = (honcho: Honcho, apiKey: string, overrides: TelemetryOverrides = {}) => {
  const http = honcho.http as unknown as { apiKey?: string; defaultHeaders: Record<string, string> }
  http.apiKey = apiKey || undefined
  setTelemetryHeaders(http.defaultHeaders, telemetryIdentity(overrides))
}
