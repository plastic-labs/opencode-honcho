import { Honcho } from "@honcho-ai/sdk"
import {
  setTelemetryHeaders,
  telemetryHeaders,
  version as HARNESS_RUNTIME_VERSION,
  type TelemetryIdentity,
} from "@honcho-ai/harness-plugin-core"
import { PLUGIN_VERSION } from "./version.js"

/** Host name reported to Honcho and used for the `hosts.<host>` config block. */
export const HOST_ID = "opencode"

export { HARNESS_RUNTIME_VERSION, PLUGIN_VERSION }

export type TelemetryOverrides = Pick<TelemetryIdentity, "hostVersion" | "model">

export type HonchoClientOptions = TelemetryOverrides & {
  apiKey: string
  baseUrl: string
  workspaceId: string
  timeoutMs: number
}

/** Identity every request carries: host + plugin version, plus whatever the caller knows. */
export const telemetryIdentity = (overrides: TelemetryOverrides = {}): TelemetryIdentity => ({
  host: HOST_ID,
  pluginVersion: PLUGIN_VERSION,
  ...(overrides.hostVersion ? { hostVersion: overrides.hostVersion } : {}),
  ...(overrides.model ? { model: overrides.model } : {}),
})

export const createHonchoClient = (options: HonchoClientOptions) =>
  new Honcho({
    apiKey: options.apiKey || undefined,
    baseURL: options.baseUrl || undefined,
    workspaceId: options.workspaceId,
    timeout: options.timeoutMs,
    defaultHeaders: telemetryHeaders(telemetryIdentity(options)),
  })

/** Refresh identity headers on a live client, e.g. when the agent model changes mid-session. */
export const updateClientTelemetry = (honcho: Honcho, overrides: TelemetryOverrides) =>
  setTelemetryHeaders(honcho.http.defaultHeaders, telemetryIdentity(overrides))

const clientKey = (options: HonchoClientOptions) =>
  [options.baseUrl, options.workspaceId, options.timeoutMs, options.apiKey].join(" ")

/**
 * One Honcho client per (endpoint, workspace, timeout, key). Reusing the client lets
 * `updateClientTelemetry` keep `X-Honcho-Agent-Model` current without rebuilding it.
 */
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
