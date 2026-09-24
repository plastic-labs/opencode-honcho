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
      subscribe: () => ({
        [Symbol.asyncIterator]() {
          return { next: () => new Promise((resolve) => subscribers.push(resolve)) }
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
  return { ctx, hooks, tools, find }
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
    cleanup()
  })
})
