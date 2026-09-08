import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdtemp, readFile } from "node:fs/promises"

import { createHonchoRuntimePlugin, __testing } from "../dist/index.js"

const withEnv = async (entries, action) => {
  const previous = new Map()
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await action()
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const withMockFetch = async (implementation, action) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = implementation
  try {
    return await action()
  } finally {
    globalThis.fetch = originalFetch
  }
}

const jsonResponse = (value, init = {}) =>
  new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  })

// Minimal Honcho API stand-in that records the headers on every request.
const createHonchoFetch = () => {
  const calls = []
  const fetch = async (url, init = {}) => {
    const target = new URL(typeof url === "string" ? url : url.toString())
    const method = init.method || "GET"
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null
    const headers = new Headers(init.headers ?? {})
    calls.push({ method, pathname: target.pathname, body, headers })

    if (method === "POST" && target.pathname === "/v3/workspaces") {
      return jsonResponse({ id: body.id, metadata: {}, configuration: {} })
    }
    if (method === "POST" && /^\/v3\/workspaces\/[^/]+\/peers$/.test(target.pathname)) {
      return jsonResponse({ id: body.id, metadata: {}, configuration: {}, created_at: new Date(0).toISOString() })
    }
    if (method === "POST" && /^\/v3\/workspaces\/[^/]+\/sessions$/.test(target.pathname)) {
      return jsonResponse({
        id: body.id,
        metadata: {},
        configuration: {},
        created_at: new Date(0).toISOString(),
        is_active: true,
      })
    }
    if (method === "POST" && /\/sessions\/[^/]+\/peers$/.test(target.pathname)) {
      return new Response(null, { status: 204 })
    }
    if (method === "POST" && /\/sessions\/[^/]+\/messages$/.test(target.pathname)) {
      return jsonResponse([])
    }
    throw new Error(`Unexpected Honcho request in test: ${method} ${target.pathname}`)
  }
  fetch.calls = calls
  return fetch
}

const createPluginHarness = async (rootDir) => {
  const plugin = createHonchoRuntimePlugin()
  return plugin({
    client: { app: { log: async () => undefined } },
    project: { id: "opencode", worktree: rootDir },
    directory: rootDir,
    worktree: rootDir,
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: {},
  })
}

const toolContext = (rootDir) => ({
  sessionID: "ses_test",
  messageID: "msg_test",
  agent: "build",
  directory: rootDir,
  worktree: rootDir,
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
})

const CLEAN_SHARED_ENV = {
  USER: "test-user",
  USERNAME: undefined,
  XDG_CONFIG_HOME: undefined,
  HONCHO_API_KEY: undefined,
  HONCHO_URL: undefined,
  HONCHO_BASE_URL: undefined,
  HONCHO_WORKSPACE: undefined,
  HONCHO_WORKSPACE_ID: undefined,
  HONCHO_PEER_NAME: undefined,
  HONCHO_AI_PEER: undefined,
  HONCHO_ENABLED: undefined,
  HONCHO_CONFIG_PATH: undefined,
}

const makeDirs = async (label) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), `honcho-telemetry-root-${label}-`))
  const homeDir = await mkdtemp(path.join(os.tmpdir(), `honcho-telemetry-home-${label}-`))
  return { rootDir, homeDir }
}

const statusOf = async (hooks, rootDir) =>
  JSON.parse(await hooks.tool.honcho_status.execute({}, toolContext(rootDir)))

const pluginVersion = async () =>
  JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8")).version

test("__testing exposes the identity the plugin reports to Honcho", async () => {
  expect(__testing.hostId).toBe("opencode")
  expect(__testing.pluginId).toBe("opencode-honcho")
  // The bundled dist cannot read package.json at runtime, so the constant must track it.
  expect(__testing.pluginVersion).toBe(await pluginVersion())
})

test("extractModelId reports providerID/modelID from user and assistant message shapes", () => {
  expect(__testing.extractModelId({ model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } })).toBe(
    "anthropic/claude-sonnet-4-5",
  )
  expect(__testing.extractModelId({ providerID: "openai", modelID: "gpt-5" })).toBe("openai/gpt-5")
  expect(__testing.extractModelId({ model: { providerID: "openrouter", id: "google/gemini-flash" } })).toBe(
    "openrouter/google/gemini-flash",
  )
  expect(__testing.extractModelId({ model: { modelID: "  " } })).toBeNull()
  expect(__testing.extractModelId({})).toBeNull()
  expect(__testing.extractModelId(undefined)).toBeNull()
})

test("a client built without host version or model sends only host and plugin headers", () => {
  const honcho = __testing.createHonchoClient({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:8000",
    workspaceId: "telemetry-test",
  })
  expect(honcho.http.defaultHeaders["X-Honcho-Host"]).toBe(`opencode (${process.platform})`)
  expect(honcho.http.defaultHeaders["X-Honcho-Plugin"]).toBe(`opencode-honcho/${__testing.pluginVersion}`)
  expect(honcho.http.defaultHeaders["X-Honcho-Agent-Model"]).toBeUndefined()
})

test("every Honcho request carries host, plugin, and current agent model telemetry headers", async () => {
  const { rootDir, homeDir } = await makeDirs("headers")
  const fetch = createHonchoFetch()
  const expectedPlugin = await pluginVersion()

  await withMockFetch(fetch, () =>
    withEnv({ ...CLEAN_SHARED_ENV, HOME: homeDir, HONCHO_API_KEY: "telemetry-key" }, async () => {
      const hooks = await createPluginHarness(rootDir)

      // OpenCode never hands the plugin its version directly; Session.version on the
      // session.created event names the running version.
      await hooks.event({
        event: { type: "session.created", properties: { info: { id: "ses_test", version: "1.18.23" } } },
      })
      expect(fetch.calls.length).toBeGreaterThan(0)
      for (const call of fetch.calls) {
        expect(call.headers.get("X-Honcho-Host")).toBe(`opencode/1.18.23 (${process.platform})`)
        expect(call.headers.get("X-Honcho-Plugin")).toBe(`opencode-honcho/${expectedPlugin}`)
        expect(call.headers.has("X-Honcho-Agent-Model")).toBe(false)
      }

      // Without an explicit -m, chat.message has no input.model; the resolved model lives on the user message.
      let before = fetch.calls.length
      await hooks["chat.message"](
        { sessionID: "ses_test" },
        {
          message: { time: { created: 0 }, model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } },
          parts: [{ type: "text", text: "let us continue the refactor" }],
        },
      )
      let later = fetch.calls.slice(before)
      expect(later.length).toBeGreaterThan(0)
      for (const call of later) {
        expect(call.headers.get("X-Honcho-Host")).toBe(`opencode/1.18.23 (${process.platform})`)
        expect(call.headers.get("X-Honcho-Plugin")).toBe(`opencode-honcho/${expectedPlugin}`)
        expect(call.headers.get("X-Honcho-Agent-Model")).toBe("anthropic/claude-sonnet-4-5")
      }

      // The completed assistant message names the model that answered; it is pushed onto the
      // cached client (setTelemetryHeaders) and tracks mid-session model switches.
      before = fetch.calls.length
      await hooks.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "msg_1",
              sessionID: "ses_test",
              role: "assistant",
              providerID: "anthropic",
              modelID: "claude-opus-4",
              time: { created: 1, completed: 2 },
            },
          },
        },
      })
      later = fetch.calls.slice(before)
      expect(later.length).toBeGreaterThan(0)
      for (const call of later) {
        expect(call.headers.get("X-Honcho-Agent-Model")).toBe("anthropic/claude-opus-4")
      }

      // The system hook also runs for OpenCode's title-generation agent, so it is not a model source.
      before = fetch.calls.length
      await hooks["experimental.chat.system.transform"](
        { sessionID: "ses_test", model: { providerID: "openrouter", id: "google/gemini-flash" } },
        { system: [] },
      )
      for (const call of fetch.calls.slice(before)) {
        expect(call.headers.get("X-Honcho-Agent-Model")).toBe("anthropic/claude-opus-4")
      }

      // A resumed session may carry the older version that created it; it does not override the known version.
      await hooks.event({
        event: { type: "session.updated", properties: { info: { id: "ses_old", version: "1.17.0" } } },
      })

      const status = await statusOf(hooks, rootDir)
      expect(status.telemetry).toEqual({
        host: "opencode",
        hostVersion: "1.18.23",
        plugin: "opencode-honcho",
        pluginVersion: expectedPlugin,
        model: "anthropic/claude-opus-4",
      })
    }),
  )
})
