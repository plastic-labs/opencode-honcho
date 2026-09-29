import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Loads dist/server.js and dist/tui.js the way each OpenCode generation does and drives the
// v2 `setup()` against a recording context. No Honcho traffic: config has no API key, so the
// core skips network work but still registers every hook and tool.

// `subscribe` can be shared between contexts to model one server-wide event stream feeding several
// plugin instances; `sessions` is what `session.get` answers with, keyed by session id.
const fakeContext = ({ directory = process.cwd(), subscribe, sessions = {} } = {}) => {
  const hooks = { session: [], tool: [], shell: [] }
  const tools = []
  const subscribers = []
  const sessionGets = []
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
      get: async ({ sessionID }) => {
        sessionGets.push(sessionID)
        if (!sessions[sessionID]) throw new Error(`session ${sessionID} not found`)
        return sessions[sessionID]
      },
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
  const emit = async (type, data) => {
    while (subscribers.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    subscribers.shift()({ value: { type, data, created: Date.now() }, done: false })
  }
  return { ctx, hooks, tools, find, emit, sessionGets }
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
      await emit("session.step.ended", { sessionID: "ses_a", assistantMessageID: "msg_a" })
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
  // One server, one event stream, one plugin instance per location. Each instance must act only on
  // the sessions of its own location: session events name the location they were published from,
  // turn-boundary events (`session.execution.*`) do not and are resolved through the session API.
  test("two instances over one event stream only act on their own location's sessions", async () => {
    const ENV = [
      "HONCHO_API_KEY",
      "HONCHO_URL",
      "HONCHO_BASE_URL",
      "HONCHO_WORKSPACE",
      "HONCHO_WORKSPACE_ID",
      "HONCHO_PEER_NAME",
      "HONCHO_AI_PEER",
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_HONCHO_TRACE_EVENTS",
    ]
    const savedEnv = Object.fromEntries(ENV.map((key) => [key, process.env[key]]))
    for (const key of ENV) delete process.env[key]
    const savedError = console.error
    const lines = []
    console.error = (...args) => lines.push(args.map(String).join(" "))
    const cleanups = []
    try {
      const root = await mkdtemp(path.join(os.tmpdir(), "honcho-v2-scope-"))
      process.env.OPENCODE_CONFIG_DIR = path.join(root, "opencode")
      process.env.OPENCODE_HONCHO_TRACE_EVENTS = "1"
      const dirA = path.join(root, "a")
      const dirB = path.join(root, "b")
      const linkA = path.join(root, "a-link")
      await mkdir(dirA)
      await mkdir(dirB)
      await symlink(dirA, linkA)
      // No API key and the default (remote) baseUrl: every runtime operation stops at the
      // "missing an API key" warning, which names the workspace, i.e. the instance that tried.
      const configFor = async (name) => {
        const file = path.join(root, `${name}.json`)
        await writeFile(file, JSON.stringify({ peerName: "wire", hosts: { opencode: { workspace: `ws-${name}` } } }))
        return file
      }

      const waiting = []
      const stream = {
        [Symbol.asyncIterator]() {
          return { next: () => new Promise((resolve) => waiting.push(resolve)) }
        },
      }
      const settle = async () => {
        while (waiting.length < 2) await new Promise((resolve) => setTimeout(resolve, 5))
      }
      const emit = async (event) => {
        await settle()
        for (const resolve of waiting.splice(0)) resolve({ value: event, done: false })
        await settle()
      }
      const sessions = { ses_a: { id: "ses_a", location: { directory: dirA } }, ses_b: { id: "ses_b", location: { directory: dirB } } }
      // Instance A is addressed through a symlink with a trailing slash; events carry the real path.
      const a = fakeContext({ directory: `${linkA}/`, subscribe: () => stream, sessions })
      const b = fakeContext({ directory: dirB, subscribe: () => stream, sessions })
      a.ctx.options = { configPath: await configFor("a") }
      b.ctx.options = { configPath: await configFor("b") }
      const mod = await import("../dist/server.js")
      cleanups.push(await mod.default.setup(a.ctx), await mod.default.setup(b.ctx))

      let seq = 0
      const event = (type, data, location) => ({
        id: `evt_${++seq}`,
        created: Date.now(),
        type,
        ...(location ? { location: { directory: location } } : {}),
        data,
      })
      const turn = (sessionID, messageID, location) => [
        event("session.step.started", { sessionID, assistantMessageID: messageID, model: { providerID: "anthropic", id: "claude" } }, location),
        event("session.text.ended", { sessionID, assistantMessageID: messageID, ordinal: 0, text: "pong" }, location),
        event("session.step.ended", { sessionID, assistantMessageID: messageID, finish: "stop" }, location),
        event("session.execution.succeeded", { sessionID }), // never carries a location
      ]
      const parse = (line) => {
        const match = /^\[opencode-honcho\] (\w+): (.*?) (\{.*\})$/.exec(line)
        return match && { level: match[1], message: match[2], extra: JSON.parse(match[3]) }
      }
      const owned = (directory) =>
        lines
          .map(parse)
          .filter((entry) => entry?.message === "event" && entry.extra.directory === directory)
          .map((entry) => [entry.extra.type, entry.extra.sessionId, entry.extra.owned])
      const attempts = (workspace) =>
        lines.map(parse).filter((entry) => entry?.level === "warn" && entry.extra.workspaceId === workspace).length
      const reset = () => lines.splice(0)

      // Session A: created and answered in location A. Only A hydrates and captures.
      await emit(event("session.created", { sessionID: "ses_a", projectID: "prj", location: { directory: dirA } }, dirA))
      for (const e of turn("ses_a", "msg_a1", dirA)) await emit(e)
      expect(owned(`${linkA}/`)).toEqual([
        ["session.created", "ses_a", true],
        ["session.step.started", "ses_a", true],
        ["session.text.ended", "ses_a", true],
        ["session.step.ended", "ses_a", true],
        ["session.execution.succeeded", "ses_a", true],
      ])
      expect(owned(dirB).map((entry) => entry[2])).toEqual([false, false, false, false, false])
      expect(attempts("ws-a")).toBeGreaterThan(0)
      expect(attempts("ws-b")).toBe(0)
      // The unlabelled turn boundary was resolved from what the labelled events said: no lookup.
      expect(a.sessionGets).toEqual([])
      expect(b.sessionGets).toEqual([])
      reset()

      // Session B, with no location on any event: resolved once through session.get, then remembered.
      await emit(event("session.created", { sessionID: "ses_b", projectID: "prj", location: { directory: dirB } }))
      for (const e of turn("ses_b", "msg_b1")) await emit(e)
      expect(owned(`${linkA}/`).map((entry) => entry[2])).toEqual([false, false, false, false, false])
      expect(owned(dirB).map((entry) => entry[2])).toEqual([true, true, true, true, true])
      expect(attempts("ws-a")).toBe(0)
      expect(attempts("ws-b")).toBeGreaterThan(0)
      expect(a.sessionGets).toEqual(["ses_b"])
      expect(b.sessionGets).toEqual(["ses_b"])
      reset()

      // A session that reached this instance's (location-scoped) prompt hook is its own, even when
      // nothing else says where it lives.
      await a.find(a.hooks.session, "prompt")({ sessionID: "ses_c", messageID: "msg_c0", prompt: { text: "hello" }, delivery: {} })
      await emit(event("session.execution.succeeded", { sessionID: "ses_c" }))
      expect(owned(`${linkA}/`)).toEqual([["session.execution.succeeded", "ses_c", true]])
      expect(owned(dirB)).toEqual([["session.execution.succeeded", "ses_c", false]])
      expect(a.sessionGets).toEqual(["ses_b"])
      expect(b.sessionGets).toEqual(["ses_b", "ses_c"]) // looked up, not found, not ours
      reset()

      // Deletion is handled by the owner only, and forgets the session in both instances: the next
      // unlabelled event for it needs a fresh lookup, which fails once the session is gone.
      await emit(event("session.deleted", { sessionID: "ses_a" }, dirA))
      await emit(event("session.deleted", { sessionID: "ses_b" }))
      expect(owned(`${linkA}/`)).toEqual([
        ["session.deleted", "ses_a", true],
        ["session.deleted", "ses_b", false],
      ])
      expect(owned(dirB)).toEqual([
        ["session.deleted", "ses_a", false],
        ["session.deleted", "ses_b", true],
      ])
      delete sessions.ses_a
      delete sessions.ses_b
      reset()
      await emit(event("session.execution.succeeded", { sessionID: "ses_a" }))
      await emit(event("session.execution.succeeded", { sessionID: "ses_b" }))
      expect(owned(`${linkA}/`).map((entry) => entry[2])).toEqual([false, false])
      expect(owned(dirB).map((entry) => entry[2])).toEqual([false, false])
      expect(a.sessionGets).toEqual(["ses_b", "ses_a", "ses_b"])
      expect(b.sessionGets).toEqual(["ses_b", "ses_c", "ses_a", "ses_b"])
      expect(attempts("ws-a")).toBe(0)
      expect(attempts("ws-b")).toBe(0)
    } finally {
      for (const cleanup of cleanups) cleanup()
      console.error = savedError
      for (const key of ENV) {
        if (savedEnv[key] === undefined) delete process.env[key]
        else process.env[key] = savedEnv[key]
      }
    }
  })
})
