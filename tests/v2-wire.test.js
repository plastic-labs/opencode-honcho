import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Loads dist/server.js and dist/tui.js the way each OpenCode generation does and drives the
// v2 `setup()` against a recording context. No Honcho traffic: config has no API key, so the
// core skips network work but still registers every hook and tool.

const fakeContext = () => {
  const hooks = { session: [], tool: [], shell: [] }
  const tools = []
  const subscribers = []
  const hook = (bucket) => async (name, callback) => {
    bucket.push({ name, callback })
    return { dispose: async () => {} }
  }
  const ctx = {
    app: { name: "opencode", version: "2.0.16", channel: "latest" },
    location: { directory: process.cwd(), project: { id: "prj", directory: process.cwd(), canonical: process.cwd() } },
    options: {},
    event: {
      subscribe: ({ signal } = {}) => ({
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              new Promise((resolve) => {
                subscribers.push(resolve)
                signal?.addEventListener("abort", () => resolve({ done: true }), { once: true })
              }),
          }
        },
      }),
    },
    session: { hook: hook(hooks.session) },
    shell: { hook: hook(hooks.shell) },
    tool: {
      hook: hook(hooks.tool),
      transform: async (callback) => {
        callback({ add: (definition) => tools.push(definition), remove: () => {} })
        return { dispose: async () => {} }
      },
    },
  }
  const find = (bucket, name) => bucket.find((entry) => entry.name === name)?.callback
  const emit = async (type, data) => {
    while (subscribers.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    subscribers.shift()({ value: { type, data, created: Date.now() }, done: false })
  }
  return { ctx, hooks, tools, find, emit }
}

describe("OpenCode 2 entrypoints", () => {
  test("server default export satisfies both loaders", async () => {
    const mod = await import("../dist/server.js")
    expect(mod.default.id).toBe("@honcho-ai/opencode-honcho")
    expect(typeof mod.default.setup).toBe("function") // v2 reads id + setup
    expect(typeof mod.default.server).toBe("function") // v1 calls server()
    expect(mod.server).toBe(mod.default.server)
  })

  test("tui default export satisfies both loaders", async () => {
    const mod = await import("../dist/tui.js")
    expect(mod.default.id).toBe("@honcho-ai/opencode-honcho")
    expect(typeof mod.default.tui).toBe("function")
    expect(typeof mod.default.setup).toBe("function")
    expect(mod.__testing.buildCommandsV2({}).map((c) => c.slash.name)).toEqual([
      "honcho:setup",
      "honcho:status",
      "honcho:settings",
      "honcho:config",
      "honcho:import",
    ])
  })

  test("setup registers hooks, tools, and injects the system instruction", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "honcho-v2-"))
    const configPath = path.join(home, "config.json")
    await writeFile(configPath, JSON.stringify({ peerName: "wire", baseUrl: "http://127.0.0.1:9", hosts: { opencode: { recallMode: "tools" } } }))

    const { ctx, hooks, tools, find } = fakeContext()
    ctx.options = { configPath }
    const mod = await import("../dist/server.js")
    const cleanup = await mod.default.setup(ctx)

    expect(hooks.session.map((h) => h.name).sort()).toEqual(["compaction", "context", "prompt"])
    expect(hooks.tool.map((h) => h.name)).toEqual(["execute.after"])
    expect(hooks.shell.map((h) => h.name)).toEqual(["create.before"])
    expect(tools.map((t) => t.name).sort()).toEqual([
      "honcho_chat",
      "honcho_create_conclusion",
      "honcho_get_config",
      "honcho_search",
      "honcho_set_config",
      "honcho_setup",
      "honcho_status",
    ])
    // zod 4 objects implement Standard Schema, which v2 accepts as a tool input schema.
    expect(typeof tools[0].input["~standard"]).toBe("object")

    const context = { sessionID: "ses_wire", agent: "build", model: { providerID: "anthropic", id: "claude" }, system: [], messages: [], options: {}, tools: {} }
    await find(hooks.session, "context")(context)
    expect(context.system).toHaveLength(1) // recallMode=tools: instruction only, no snapshot
    expect(context.system[0].text).toContain("## Honcho Memory")

    const shell = { command: "ls", cwd: home, timeout: 1, shell: "sh", env: {} }
    await find(hooks.shell, "create.before")(shell)
    expect(shell.env.HONCHO_URL).toBe("http://127.0.0.1:9")

    const status = JSON.parse(await tools.find((t) => t.name === "honcho_status").execute({}, { sessionID: "ses_wire" }).then((r) => r.content))
    expect(status.telemetry.hostVersion).toBe("2.0.16")
    expect(status.configured).toBe(true)

    expect(typeof cleanup).toBe("function")
    await cleanup()
  })
})

describe("OpenCode 2 cleanup", () => {
  test("cleanup waits for an in-flight assistant capture", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "honcho-v2-"))
    const configPath = path.join(home, "config.json")
    await writeFile(configPath, JSON.stringify({ peerName: "wire", hosts: { opencode: { recallMode: "tools" } } }))
    const keys = ["HOME", "OPENCODE_CONFIG_DIR", "HONCHO_API_KEY", "HONCHO_URL", "HONCHO_BASE_URL", "HONCHO_WORKSPACE", "HONCHO_PEER_NAME"]
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    for (const key of keys) delete process.env[key]
    process.env.HOME = home
    process.env.OPENCODE_CONFIG_DIR = path.join(home, "opencode")
    process.env.HONCHO_API_KEY = "test-key"

    // Answers every Honcho call; message writes wait on `gate` so they can be observed in flight.
    let release
    let gate = null
    const writes = []
    const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
    const savedFetch = globalThis.fetch
    globalThis.fetch = async (url, init = {}) => {
      const { pathname } = new URL(String(url))
      const body = typeof init.body === "string" ? JSON.parse(init.body) : {}
      if (/\/sessions\/[^/]+\/messages$/.test(pathname)) {
        writes.push(body)
        await gate
        return json([{ id: "msg", content: "", created_at: new Date().toISOString() }])
      }
      if (/\/sessions\/[^/]+\/peers$/.test(pathname)) return new Response(null, { status: 204 })
      return json({ id: body.id, metadata: {}, configuration: {}, created_at: new Date().toISOString(), is_active: true })
    }
    const savedError = console.error
    console.error = () => {}

    let cleanup
    try {
      const { ctx, emit } = fakeContext()
      ctx.options = { configPath }
      const mod = await import("../dist/server.js")
      cleanup = await mod.default.setup(ctx)

      gate = new Promise((resolve) => (release = resolve))
      const turn = { sessionID: "ses_a", assistantMessageID: "msg_a" }
      await emit("session.text.ended", { ...turn, ordinal: 0, text: "pong" })
      await emit("session.step.ended", turn)
      while (writes.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))

      let settled = false
      const closing = cleanup().then(() => (settled = true))
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(settled).toBe(false)
      release()
      await closing
      expect(JSON.stringify(writes)).toContain("pong")
    } finally {
      release?.()
      await cleanup?.()
      globalThis.fetch = savedFetch
      console.error = savedError
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  })
})
