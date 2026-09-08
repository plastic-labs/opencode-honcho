import { Honcho } from "@honcho-ai/sdk"
import { telemetryHeaders } from "@honcho-ai/harness-plugin-core"
import { PLUGIN_VERSION } from "./version.js"

/** Host name sent as `X-Honcho-Host: opencode (<platform>)`. */
export const HOST_ID = "opencode"

/** Integration name sent as `X-Honcho-Plugin: opencode-honcho/<version>`. */
export const PLUGIN_ID = "opencode-honcho"

export { PLUGIN_VERSION }

export type HonchoClientOptions = {
  apiKey: string
  baseUrl: string
  workspaceId: string
}

/** Identity headers (`X-Honcho-Host`, `X-Honcho-Plugin`) so server-side telemetry can attribute traffic. */
export const getTelemetryHeaders = () =>
  telemetryHeaders({ host: HOST_ID, plugin: PLUGIN_ID, pluginVersion: PLUGIN_VERSION })

/** Every Honcho client the plugin builds goes through here so the telemetry headers ride on every request. */
export const createHonchoClient = ({ apiKey, baseUrl, workspaceId }: HonchoClientOptions) =>
  new Honcho({
    apiKey: apiKey || undefined,
    baseURL: baseUrl || undefined,
    workspaceId,
    defaultHeaders: getTelemetryHeaders(),
  })
