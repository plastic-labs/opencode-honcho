import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Loads dist/server.js and dist/tui.js the way each OpenCode generation does and drives the
// v2 `setup()` against a recording context. No Honcho traffic: config has no API key, so the
// core skips network work but still registers every hook and tool.

// A shared `subscribe` models one server-wide stream feeding several instances.
const fakeContext = ({ directory = process.cwd(), subscribe } = {}) => {
  const hooks = { session: [], tool: [], shell: [] }
  const tools = []
  const subscribers = []
  const hook = (bucket) => async (name, callback) => {
    bucket.push({ name, callback })
    return { dispose: async () => {} }
  }
  const ctx = {
    app: { name: "opencode", version: "2.0.16", channel: "latest" },
    location: { directory, project: { id: "prj", directory, canonical: directory } },
    options: {},
    event: {
      subscribe:
        subscribe ??
        (({ signal } = {}) => ({
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise((resolve) => {
                  subscribers.push(resolve)
                  signal?.addEventListener("abort", () => resolve({ done: true }), { once: true })
                }),
            }
          },
        })),
    },
    session: {
      hook: hook(hooks.session),
    },
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
  const emit = async (type, data, location) => {
    while (subscribers.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    const event = { type, data, created: Date.now(), ...(location ? { location: { directory: location } } : {}) }
    subscribers.shift()({ value: event, done: false })
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
  test("cleanup waits for an in-flight Honcho write", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "honcho-v2-"))
    const configPath = path.join(dir, "config.json")
    await writeFile(configPath, JSON.stringify({ apiKey: "test-key", peerName: "wire" }))

    // Every Honcho request waits on the gate, then fails; the plugin logs and moves on.
    let release
    const gate = new Promise((resolve) => (release = resolve))
    let requests = 0
    const realFetch = globalThis.fetch
    const realError = console.error
    globalThis.fetch = async () => {
      requests += 1
      await gate
      throw new Error("stubbed")
    }
    console.error = () => {}
    try {
      const { ctx, emit } = fakeContext()
      ctx.options = { configPath }
      const cleanup = await (await import("../dist/server.js")).default.setup(ctx)
      await emit("session.step.ended", { sessionID: "ses_a", assistantMessageID: "msg_a" }, ctx.location.directory)
      while (requests === 0) await new Promise((resolve) => setTimeout(resolve, 5))

      let settled = false
      const closing = cleanup().then(() => (settled = true))
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(settled).toBe(false)
      release()
      await closing
    } finally {
      release()
      globalThis.fetch = realFetch
      console.error = realError
    }
  })
})

describe("OpenCode 2 event scoping", () => {
  test("an instance only acts on events from its own location", async () => {
    const keys = ["HONCHO_API_KEY", "HONCHO_URL", "HONCHO_BASE_URL", "OPENCODE_CONFIG_DIR", "OPENCODE_HONCHO_TRACE_EVENTS"]
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    const root = await mkdtemp(path.join(os.tmpdir(), "honcho-v2-scope-"))
    const configPath = path.join(root, "config.json")
    await writeFile(configPath, JSON.stringify({ peerName: "wire" }))
    for (const key of keys) delete process.env[key]
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "opencode")
    process.env.OPENCODE_HONCHO_TRACE_EVENTS = "1"
    const savedError = console.error
    const lines = []
    console.error = (...args) => lines.push(args.map(String).join(" "))
    const waiting = []
    const stream = { [Symbol.asyncIterator]: () => ({ next: () => new Promise((resolve) => waiting.push(resolve)) }) }
    const a = fakeContext({ directory: "/work/a", subscribe: () => stream })
    const b = fakeContext({ directory: "/work/b", subscribe: () => stream })
    a.ctx.options = { configPath }
    b.ctx.options = { configPath }
    const mod = await import("../dist/server.js")
    const cleanups = []
    const emit = async (type, sessionID, location) => {
      while (waiting.length < 2) await new Promise((resolve) => setTimeout(resolve, 5))
      const event = { id: type, created: Date.now(), type, ...(location ? { location: { directory: location } } : {}), data: { sessionID } }
      for (const resolve of waiting.splice(0)) resolve({ value: event, done: false })
      while (waiting.length < 2) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const ownedBy = () =>
      lines
        .map((line) => /event (\{.*\})$/.exec(line))
        .filter(Boolean)
        .map((match) => JSON.parse(match[1]))
        .filter((e) => e.owned)
        .map((e) => `${e.directory}:${e.type}:${e.sessionId}`)
    try {
      cleanups.push(await mod.default.setup(a.ctx))
      cleanups.push(await mod.default.setup(b.ctx))
      await emit("session.created", "ses_a", "/work/a")
      await emit("session.execution.succeeded", "ses_a") // carries no location: follows the session
      await emit("session.created", "ses_b", "/work/b")
      await emit("session.execution.succeeded", "ses_unknown")
      expect(ownedBy()).toEqual([
        "/work/a:session.created:ses_a",
        "/work/a:session.execution.succeeded:ses_a",
        "/work/b:session.created:ses_b",
      ])
    } finally {
      for (const cleanup of cleanups) cleanup()
      console.error = savedError
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  })
})
