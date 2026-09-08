import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import { __testing } from "../dist/index.js"

const packageVersion = async () =>
  JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8")).version

test("plugin version constant matches package.json", async () => {
  expect(__testing.pluginVersion).toBe(await packageVersion())
})

test("telemetry headers identify host and plugin, omit the agent model", async () => {
  const headers = __testing.getTelemetryHeaders()
  expect(headers["X-Honcho-Host"]).toBe(`opencode (${process.platform})`)
  expect(headers["X-Honcho-Plugin"]).toBe(`opencode-honcho/${await packageVersion()}`)
  expect(headers["X-Honcho-Agent-Model"]).toBeUndefined()
})

test("telemetry headers ride along on every client's default headers", () => {
  const honcho = __testing.createHonchoClient({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:8000",
    workspaceId: "telemetry-test",
  })
  expect(honcho.http.defaultHeaders).toMatchObject(__testing.getTelemetryHeaders())
})

test("telemetry headers reach the wire on Honcho requests", async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    calls.push(new Headers(init?.headers))
    return new Response(JSON.stringify({ id: "ses_test", workspace_id: "telemetry-test" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  try {
    const honcho = __testing.createHonchoClient({
      apiKey: "test-key",
      baseUrl: "http://127.0.0.1:8000",
      workspaceId: "telemetry-test",
    })
    await honcho.session("telemetry-session")
  } finally {
    globalThis.fetch = originalFetch
  }
  expect(calls.length).toBeGreaterThan(0)
  for (const headers of calls) {
    expect(headers.get("X-Honcho-Host")).toBe(`opencode (${process.platform})`)
    expect(headers.get("X-Honcho-Plugin")).toMatch(/^opencode-honcho\/\d+\.\d+\.\d+$/)
    expect(headers.has("X-Honcho-Agent-Model")).toBe(false)
  }
})
