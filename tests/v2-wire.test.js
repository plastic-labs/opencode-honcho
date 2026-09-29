import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
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
      // Honors the abort signal the way the real stream does: a pending next() ends on abort.
      subscribe: ({ signal } = {}) => ({
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              new Promise((resolve) => {
                if (signal?.aborted) return resolve({ value: undefined, done: true })
                subscribers.push(resolve)
                signal?.addEventListener("abort", () => resolve({ value: undefined, done: true }), { once: true })
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
  // Delivers one bus event once the plugin's loop is waiting for the next one.
  const emit = async (type, data) => {
    await until(() => subscribers.length > 0, `a subscriber for ${type}`)
    subscribers.shift()({ value: { type, data, created: Date.now() }, done: false })
  }
  return { ctx, hooks, tools, find, emit }
}

const until = async (condition, what) => {
  for (let i = 0; i < 400; i += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

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

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

// Minimal Honcho API: enough for runtime activation, session-start hydration, and message writes.
// `hold()` makes message writes wait until released, to observe work that is still in flight.
const createHonchoFetch = () => {
  const calls = []
  let gate = null
  const fetch = async (url, init = {}) => {
    const target = new URL(typeof url === "string" ? url : url.toString())
    const method = init.method || "GET"
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null
    calls.push({ method, pathname: target.pathname, body })
    const p = target.pathname
    const created_at = new Date(0).toISOString()
    if (method === "POST" && p === "/v3/workspaces") return jsonResponse({ id: body.id, metadata: {}, configuration: {} })
    if (method === "POST" && /^\/v3\/workspaces\/[^/]+\/peers$/.test(p)) return jsonResponse({ id: body.id, metadata: {}, configuration: {}, created_at })
    if (method === "POST" && /^\/v3\/workspaces\/[^/]+\/sessions$/.test(p)) return jsonResponse({ id: body.id, metadata: {}, configuration: {}, created_at, is_active: true })
    if (method === "POST" && /\/sessions\/[^/]+\/peers$/.test(p)) return new Response(null, { status: 204 })
    if (method === "POST" && /\/sessions\/[^/]+\/messages$/.test(p)) {
      if (gate) await gate
      return jsonResponse([{ id: "msg-created", content: "", created_at: new Date().toISOString() }])
    }
    if (method === "GET" && /\/peers\/[^/]+\/context$/.test(p)) return jsonResponse({ peer_id: "p", target_id: null, representation: "Prefers short replies.", peer_card: [] })
    if (method === "GET" && /\/sessions\/[^/]+\/summaries$/.test(p)) return jsonResponse({ id: "s", short_summary: null, long_summary: null })
    if (method === "POST" && /\/peers\/[^/]+\/chat$/.test(p)) return jsonResponse({ content: "Known user." })
    if (method === "GET" && /\/sessions\/[^/]+\/context$/.test(p)) return jsonResponse({ messages: [], summary: null, peer_representation: null, peer_card: null })
    throw new Error(`Unexpected Honcho request in test: ${method} ${p}`)
  }
  fetch.calls = calls
  fetch.hold = () => {
    let release
    gate = new Promise((resolve) => (release = resolve))
    return () => {
      gate = null
      release()
    }
  }
  return fetch
}

// Runs `action` against a v2 context wired to the fake Honcho API, with a throwaway HOME and
// OPENCODE_CONFIG_DIR and the plugin's stderr log lines collected in `logs`.
const withV2Harness = async (action) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "honcho-v2-"))
  const configDir = path.join(home, "opencode")
  const configPath = path.join(home, "config.json")
  await writeFile(configPath, JSON.stringify({ peerName: "wire", hosts: { opencode: { recallMode: "tools" } } }))
  const fetch = createHonchoFetch()
  const logs = []
  const originalFetch = globalThis.fetch
  const originalError = console.error
  globalThis.fetch = fetch
  console.error = (...args) => logs.push(args.join(" "))
  try {
    return await withEnv(
      { HOME: home, OPENCODE_CONFIG_DIR: configDir, HONCHO_API_KEY: "test-key", HONCHO_URL: undefined, HONCHO_BASE_URL: undefined, HONCHO_WORKSPACE: undefined, HONCHO_PEER_NAME: undefined },
      async () => {
        const harness = fakeContext()
        harness.ctx.options = { configPath }
        const mod = await import("../dist/server.js")
        return action({ ...harness, mod, fetch, logs, skillsDir: path.join(configDir, "skills") })
      },
    )
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalError
  }
}

const promptInput = (sessionID, text) => ({ sessionID, messageID: "msg_user", prompt: { text }, delivery: "immediate" })
const countMatching = (fetch, pattern) => fetch.calls.filter((c) => pattern.test(`${c.method} ${c.pathname}`)).length

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

// `opencode run --standalone` loads the plugin inside the request that creates the session, so
// `session.created` is published before the plugin subscribes, and the process is torn down as
// soon as the reply is complete. Both paths have to work without that event.
describe("OpenCode 2 standalone session lifecycle", () => {
  test("prompt hook hydrates a session that never emitted session.created and installs the skill", async () => {
    await withV2Harness(async ({ ctx, hooks, find, mod, fetch, logs, emit, skillsDir }) => {
      const cleanup = await mod.default.setup(ctx)
      expect(existsSync(path.join(skillsDir, "honcho-memory", "SKILL.md"))).toBe(false)

      await find(hooks.session, "prompt")(promptInput("ses_standalone", "Reply with exactly: pong"))

      // Session-start hydration ran (peer context, session summaries) before the prompt was written.
      const trail = fetch.calls.map((c) => `${c.method} ${c.pathname}`)
      const firstContext = trail.findIndex((p) => /^GET .*\/peers\/[^/]+\/context$/.test(p))
      const firstMessage = trail.findIndex((p) => /^POST .*\/messages$/.test(p))
      expect(firstContext).toBeGreaterThanOrEqual(0)
      expect(countMatching(fetch, /^GET .*\/sessions\/[^/]+\/summaries$/)).toBe(1)
      expect(firstMessage).toBeGreaterThan(firstContext)
      expect(logs.filter((l) => l.includes("Honcho session initialized for OpenCode."))).toHaveLength(1)
      expect(existsSync(path.join(skillsDir, "honcho-memory", "SKILL.md"))).toBe(true)

      // A late session.created for the same session, or another prompt, does not hydrate again.
      const hydrations = countMatching(fetch, /^GET .*\/peers\/[^/]+\/context$/)
      await emit("session.created", { sessionID: "ses_standalone" })
      await find(hooks.session, "prompt")(promptInput("ses_standalone", "And again"))
      await cleanup()
      expect(countMatching(fetch, /^GET .*\/peers\/[^/]+\/context$/)).toBe(hydrations)
      expect(logs.filter((l) => l.includes("Honcho session initialized for OpenCode."))).toHaveLength(1)
    })
  })

  test("cleanup resolves only after the in-flight assistant capture has landed", async () => {
    await withV2Harness(async ({ ctx, hooks, find, mod, fetch, logs, emit }) => {
      const cleanup = await mod.default.setup(ctx)
      await find(hooks.session, "prompt")(promptInput("ses_standalone", "Reply with exactly: pong"))
      const writesBefore = countMatching(fetch, /^POST .*\/messages$/)

      const release = fetch.hold()
      await emit("session.text.ended", { sessionID: "ses_standalone", assistantMessageID: "msg_asst", ordinal: 0, text: "pong" })
      await emit("session.step.streamed", { sessionID: "ses_standalone", assistantMessageID: "msg_asst" })
      await emit("session.step.ended", { sessionID: "ses_standalone", assistantMessageID: "msg_asst" })
      await until(() => countMatching(fetch, /^POST .*\/messages$/) === writesBefore + 1, "the assistant write to start")

      // The host runs cleanup at this point under `opencode run`; it must not resolve while the
      // write is still in flight, and must resolve once it lands.
      let settled = false
      const closing = cleanup().then(() => (settled = true))
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(settled).toBe(false)
      release()
      await closing
      expect(settled).toBe(true)

      const write = fetch.calls.filter((c) => c.method === "POST" && /\/messages$/.test(c.pathname)).at(-1)
      expect(JSON.stringify(write.body)).toContain("pong")
      expect(logs.filter((l) => l.includes("Honcho captured assistant message."))).toHaveLength(1)
    })
  })
})
