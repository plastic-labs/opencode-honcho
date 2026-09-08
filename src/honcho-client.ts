import { Honcho } from "@honcho-ai/sdk"
import {
  setTelemetryHeaders,
  telemetryHeaders,
  type TelemetryIdentity,
} from "@honcho-ai/harness-plugin-core"
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

/** Every Honcho client the plugin builds goes through here so the telemetry headers ride on every request. */
export const createHonchoClient = (options: HonchoClientOptions) =>
  new Honcho({
    apiKey: options.apiKey || undefined,
    baseURL: options.baseUrl || undefined,
    workspaceId: options.workspaceId,
    defaultHeaders: telemetryHeaders(telemetryIdentity(options)),
  })

/** Refresh identity headers on a live client, e.g. when the agent model changes mid-session. */
export const updateClientTelemetry = (honcho: Honcho, overrides: TelemetryOverrides) =>
  setTelemetryHeaders(honcho.http.defaultHeaders, telemetryIdentity(overrides))

const clientKey = (options: HonchoClientOptions) => [options.baseUrl, options.workspaceId, options.apiKey].join(" ")

/** One client per (endpoint, workspace, key); reuse keeps X-Honcho-Agent-Model current. */
export const createHonchoClientCache = () => {
  const clients = new Map<string, Honcho>()
  return {
    get(options: HonchoClientOptions) {
      const key = clientKey(options)
      let honcho = clients.get(key)
      if (!honcho) {
        honcho = createHonchoClient(options)
        clients.set(key, honcho)
      } else {
        updateClientTelemetry(honcho, options)
      }
      return honcho
    },
    clear() {
      clients.clear()
    },
  }
}
