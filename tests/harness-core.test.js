import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"

import { createHonchoRuntimePlugin, __testing } from "../dist/index.js"

// Coverage for the @honcho-ai/harness-plugin-core integration: shared config resolution
// (HONCHO_CONFIG_PATH, schema v0/v1, env precedence, timeoutMs, enabled) and telemetry headers.

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
  HONCHO_ENDPOINT: undefined,
  HONCHO_WORKSPACE: undefined,
  HONCHO_WORKSPACE_ID: undefined,
  HONCHO_PEER_NAME: undefined,
  HONCHO_AI_PEER: undefined,
  HONCHO_TIMEOUT_MS: undefined,
  HONCHO_ENABLED: undefined,
  HONCHO_CONFIG_PATH: undefined,
}

const makeDirs = async (label) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), `honcho-core-root-${label}-`))
  const homeDir = await mkdtemp(path.join(os.tmpdir(), `honcho-core-home-${label}-`))
  return { rootDir, homeDir, sharedConfigPath: path.join(homeDir, ".honcho", "config.json") }
}

const writeConfig = async (configPath, value) => {
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(configPath, JSON.stringify(value, null, 2))
}

const statusOf = async (hooks, rootDir) =>
  JSON.parse(await hooks.tool.honcho_status.execute({}, toolContext(rootDir)))

const pluginVersion = async () =>
  JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8")).version

const runtimeVersion = async () =>
  JSON.parse(
    await readFile(new URL("../node_modules/@honcho-ai/harness-plugin-core/package.json", import.meta.url), "utf-8"),
  ).version

test("__testing exposes the identity the plugin reports to Honcho", async () => {
  expect(__testing.hostId).toBe("opencode")
  expect(__testing.pluginVersion).toBe(await pluginVersion())
  expect(__testing.harnessRuntimeVersion).toBe(await runtimeVersion())
})

test("HONCHO_CONFIG_PATH points the plugin at an alternate shared config", async () => {
  const { rootDir, homeDir, sharedConfigPath } = await makeDirs("config-path")
  const altPath = path.join(homeDir, "alt", "honcho.json")
  await writeConfig(altPath, {
    apiKey: "alt-key",
    peerName: "alt-peer",
    hosts: { opencode: { workspace: "alt-ws" } },
  })

  await withEnv({ ...CLEAN_SHARED_ENV, HOME: homeDir, HONCHO_CONFIG_PATH: altPath }, async () => {
    const hooks = await createPluginHarness(rootDir)
    const status = await statusOf(hooks, rootDir)

    expect(status.configPath).toBe(altPath)
    expect(status.globalConfigPath).toBe(altPath)
    expect(status.configured).toBe(true)
    expect(status.peerName).toBe("alt-peer")
    expect(status.workspace).toBe("alt-ws")
    expect(existsSync(sharedConfigPath)).toBe(false)
  })
})

test("schema v1 files (auth.apiKey, host timeoutMs) resolve through the shared runtime", async () => {
  const { rootDir, homeDir, sharedConfigPath } = await makeDirs("schema-v1")
  await writeConfig(sharedConfigPath, {
    schemaVersion: 1,
    peerName: "v1-peer",
    baseUrl: "https://custom.example/",
    auth: { apiKey: "v1-key" },
    hosts: { opencode: { workspace: "v1-ws", timeoutMs: 5000 } },
  })

  await withEnv({ ...CLEAN_SHARED_ENV, HOME: homeDir }, async () => {
    const hooks = await createPluginHarness(rootDir)
    const status = await statusOf(hooks, rootDir)

    expect(status.configured).toBe(true)
    expect(status.enabled).toBe(true)
    expect(status.peerName).toBe("v1-peer")
    expect(status.workspace).toBe("v1-ws")
    expect(status.baseUrl).toBe("https://custom.example")
    expect(status.timeoutMs).toBe(5000)
    expect(Array.isArray(status.configWarnings)).toBe(true)
  })
})

test("schema v0 aliases (environmentUrl, workspaceId) are migrated on read without rewriting the file", async () => {
  const { rootDir, homeDir, sharedConfigPath } = await makeDirs("schema-v0")
  const initial = { environmentUrl: "http://localhost:8000", workspaceId: "v0-ws", peerName: "v0-peer" }
  await writeConfig(sharedConfigPath, initial)

  await withEnv({ ...CLEAN_SHARED_ENV, HOME: homeDir }, async () => {
    const hooks = await createPluginHarness(rootDir)
    const status = await statusOf(hooks, rootDir)

    expect(status.baseUrl).toBe("http://localhost:8000")
    expect(status.localMode).toBe(true)
    expect(status.configured).toBe(true)
    expect(status.workspace).toBe("v0-ws")
    expect(status.timeoutMs).toBe(30000)
    expect(JSON.parse(await readFile(sharedConfigPath, "utf-8"))).toEqual(initial)
  })
})

test("hosts.opencode.enabled=false makes hooks and memory tools inert while config tools keep working", async () => {
  const { rootDir, homeDir, sharedConfigPath } = await makeDirs("disabled")
  await writeConfig(sharedConfigPath, {
    apiKey: "disabled-key",
    peerName: "disabled-peer",
    hosts: { opencode: { workspace: "disabled-ws", enabled: false } },
  })
  const fetch = createHonchoFetch()

  await withMockFetch(fetch, () =>
    withEnv({ ...CLEAN_SHARED_ENV, HOME: homeDir }, async () => {
      const hooks = await createPluginHarness(rootDir)

      const status = await statusOf(hooks, rootDir)
      expect(status.enabled).toBe(false)
      expect(status.configured).toBe(true)

      const search = JSON.parse(await hooks.tool.honcho_search.execute({ query: "anything" }, toolContext(rootDir)))
      expect(search.ok).toBe(false)
      expect(search.error).toMatch(/disabled/i)

      const conclusion = JSON.parse(
        await hooks.tool.honcho_create_conclusion.execute({ content: "remember this" }, toolContext(rootDir)),
      )
      expect(conclusion.ok).toBe(false)
      expect(conclusion.error).toMatch(/disabled/i)

      const system = { system: [] }
      await hooks["experimental.chat.system.transform"]({ sessionID: "ses_test", model: { id: "m" } }, system)
      expect(system.system).toEqual([])

      await hooks["chat.message"](
        { sessionID: "ses_test", model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } },
        { message: { time: { created: 0 } }, parts: [{ type: "text", text: "hello from a disabled install" }] },
      )

      const shellEnv = { env: {} }
      await hooks["shell.env"]({ sessionID: "ses_test" }, shellEnv)
      expect(shellEnv.env).toEqual({})

      const compacting = { context: [] }
      await hooks["experimental.session.compacting"]({ sessionID: "ses_test" }, compacting)
      expect(compacting.context).toEqual([])

      expect(fetch.calls).toHaveLength(0)

      const reenabled = JSON.parse(
        await hooks.tool.honcho_set_config.execute({ field: "enabled", value: "true" }, toolContext(rootDir)),
      )
      expect(reenabled.ok).toBe(true)
      expect(reenabled.status.enabled).toBe(true)
      const persisted = JSON.parse(await readFile(sharedConfigPath, "utf-8"))
      expect(persisted.hosts.opencode.enabled).toBe(true)
    }),
  )
})

test("HONCHO_ENABLED and HONCHO_TIMEOUT_MS override the shared config file", async () => {
  const { rootDir, homeDir, sharedConfigPath } = await makeDirs("env-overrides")
  await writeConfig(sharedConfigPath, {
    apiKey: "file-key",
    peerName: "file-peer",
    hosts: { opencode: { workspace: "file-ws", timeoutMs: 5000 } },
  })

  await withEnv(
    { ...CLEAN_SHARED_ENV, HOME: homeDir, HONCHO_ENABLED: "false", HONCHO_TIMEOUT_MS: "1234" },
    async () => {
      const hooks = await createPluginHarness(rootDir)
      const status = await statusOf(hooks, rootDir)

      expect(status.enabled).toBe(false)
      expect(status.timeoutMs).toBe(1234)
    },
  )
})

test("honcho_set_config accepts timeoutMs as a positive number and rejects junk", async () => {
  const { rootDir, homeDir, sharedConfigPath } = await makeDirs("set-timeout")

  await withEnv({ ...CLEAN_SHARED_ENV, HOME: homeDir }, async () => {
    const hooks = await createPluginHarness(rootDir)

    const ok = JSON.parse(
      await hooks.tool.honcho_set_config.execute({ field: "timeoutMs", value: "5000" }, toolContext(rootDir)),
    )
    expect(ok.ok).toBe(true)
    expect(ok.value).toBe(5000)
    expect(ok.status.timeoutMs).toBe(5000)
    expect(JSON.parse(await readFile(sharedConfigPath, "utf-8")).hosts.opencode.timeoutMs).toBe(5000)

    const junk = JSON.parse(
      await hooks.tool.honcho_set_config.execute({ field: "timeoutMs", value: "soon" }, toolContext(rootDir)),
    )
    expect(junk.ok).toBe(false)
    expect(junk.error).toMatch(/positive number/i)

    const notBoolean = JSON.parse(
      await hooks.tool.honcho_set_config.execute({ field: "enabled", value: "maybe" }, toolContext(rootDir)),
    )
    expect(notBoolean.ok).toBe(false)
    expect(notBoolean.error).toMatch(/boolean/i)
  })
})

test("every Honcho request carries host, plugin, runtime, and current agent model telemetry headers", async () => {
  const { rootDir, homeDir } = await makeDirs("telemetry")
  const fetch = createHonchoFetch()
  const expectedPlugin = await pluginVersion()
  const expectedRuntime = await runtimeVersion()

  await withMockFetch(fetch, () =>
    withEnv({ ...CLEAN_SHARED_ENV, HOME: homeDir, HONCHO_API_KEY: "telemetry-key" }, async () => {
      const hooks = await createPluginHarness(rootDir)

      await hooks["chat.message"](
        { sessionID: "ses_test", model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } },
        { message: { time: { created: 0 } }, parts: [{ type: "text", text: "let us continue the refactor" }] },
      )

      expect(fetch.calls.length).toBeGreaterThan(0)
      for (const call of fetch.calls) {
        expect(call.headers.get("X-Honcho-Host")).toBe("opencode")
        expect(call.headers.get("X-Honcho-Plugin")).toBe(expectedPlugin)
        expect(call.headers.get("X-Honcho-Runtime")).toBe(expectedRuntime)
        expect(call.headers.get("X-Honcho-Agent-Model")).toBe("claude-sonnet-4-5")
      }

      // Model changes mid-session are pushed onto the cached client (setTelemetryHeaders).
      const before = fetch.calls.length
      await hooks["chat.message"](
        { sessionID: "ses_test", model: { providerID: "anthropic", modelID: "claude-opus-4" } },
        { message: { time: { created: 1 } }, parts: [{ type: "text", text: "and now with a different model" }] },
      )
      const later = fetch.calls.slice(before)
      expect(later.length).toBeGreaterThan(0)
      for (const call of later) {
        expect(call.headers.get("X-Honcho-Agent-Model")).toBe("claude-opus-4")
      }

      const status = await statusOf(hooks, rootDir)
      expect(status.telemetry).toEqual({
        host: "opencode",
        pluginVersion: expectedPlugin,
        model: "claude-opus-4",
        runtimeVersion: expectedRuntime,
      })
    }),
  )
})
