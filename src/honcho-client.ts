import { Honcho } from "@honcho-ai/sdk"
import { telemetryHeaders, type TelemetryIdentity } from "@honcho-ai/harness-plugin-core"
import { PLUGIN_VERSION } from "./version.js"

/** Host name sent as `X-Honcho-Host: opencode/<version> (<platform>)`. */
export const HOST_ID = "opencode"

/** Integration name sent as `X-Honcho-Plugin: opencode-honcho/<version>`. */
export const PLUGIN_ID = "opencode-honcho"

export { PLUGIN_VERSION }

/** The identity fields only the running host knows: its version and the agent model in use. */
export type TelemetryOverrides = Pick<TelemetryIdentity, "hostVersion" | "model">

export type HonchoClientOptions = TelemetryOverrides & {
  apiKey: string
  baseUrl: string
  workspaceId: string
}

export const telemetryIdentity = (overrides: TelemetryOverrides = {}): TelemetryIdentity => ({
  host: HOST_ID,
  plugin: PLUGIN_ID,
  pluginVersion: PLUGIN_VERSION,
  ...(overrides.hostVersion ? { hostVersion: overrides.hostVersion } : {}),
  ...(overrides.model ? { model: overrides.model } : {}),
})

/**
 * Every Honcho client the plugin builds goes through here so the telemetry headers ride on
 * every request. The runtime builds one per hook, so the identity is always current.
 */
export const createHonchoClient = (options: HonchoClientOptions) =>
  new Honcho({
    apiKey: options.apiKey || undefined,
    baseURL: options.baseUrl || undefined,
    workspaceId: options.workspaceId,
    defaultHeaders: telemetryHeaders(telemetryIdentity(options)),
  })
