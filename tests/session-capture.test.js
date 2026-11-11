import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createHonchoRuntimePlugin } from "../dist/index.js"

// Drives the OpenCode 1.x hook map against a stand-in Honcho API and asserts on the requests:
// what is saved, what is skipped, what is injected, and that nothing is fetched per turn.

const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })

const page = (items) => json({ items, total: items.length, page: 1, size: 50, pages: 1 })

// `existing`: session ids Honcho already has.
const fakeHoncho = (existing = []) => {
  const calls = []
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(typeof url === "string" ? url : url.toString())
    const method = init.method || "GET"
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null
    calls.push({ method, pathname, body })
    const entity = { id: body?.id, metadata: {}, configuration: {}, created_at: new Date(0).toISOString(), is_active: true }
    if (method === "POST" && pathname.endsWith("/sessions/list")) {
      return page(existing.filter((id) => id === body?.filters?.id).map((id) => ({ ...entity, id })))
    }
    if (method === "POST" && /^\/v3\/workspaces(\/[^/]+\/(sessions|peers))?$/.test(pathname)) return json(entity)
    if (method === "POST" && /\/sessions\/[^/]+\/messages$/.test(pathname)) {
      return json(body.messages.map((m, i) => ({ id: `m${i}`, content: m.content, peer_id: m.peer_id, session_id: "s", workspace_id: "w", metadata: {}, created_at: new Date(0).toISOString(), token_count: 1 })))
    }
    if (method === "GET" && /\/peers\/[^/]+\/card$/.test(pathname)) return json({ peer_card: ["Prefers small, focused PRs"] })
    if (method === "POST" && /\/chat$/.test(pathname)) return json({ content: `answer from ${pathname}` })
    throw new Error(`Unexpected Honcho request: ${method} ${pathname}`)
  }
  return { calls, fetch }
}

const withEnv = async (entries, action) => {
  const saved = Object.fromEntries(Object.keys(entries).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(entries)) value === undefined ? delete process.env[key] : (process.env[key] = value)
  try {
    return await action()
  } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value)
  }
}

test("a session: config moved into hosts.opencode, one Honcho session with scopes, messages saved, directives + card injected once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "honcho-capture-"))
  const repo = path.join(root, "my-repo")
  await mkdir(repo)
  execFileSync("git", ["init", "-q"], { cwd: repo })
  const configPath = path.join(root, "config.json")
  // An older shape: settings at the top level, old keys in the block, another plugin's block.
  const original = {
    apiKey: "hch-test-key",
    peerName: "user",
    hosts: {
      opencode: { workspace: "work", aiPeer: "opencode", observationMode: "unified", sessionStrategy: "per-directory", recallMode: "hybrid", removeUserPrefix: true },
      harness: { apiKey: "other-key", peerName: "user" },
    },
  }
  await writeFile(configPath, JSON.stringify(original))
  const honcho = fakeHoncho()
  const realFetch = globalThis.fetch
  globalThis.fetch = honcho.fetch
  try {
    await withEnv({ HOME: root, OPENCODE_CONFIG_DIR: path.join(root, "oc"), HONCHO_API_KEY: undefined, HONCHO_BASE_URL: undefined, HONCHO_URL: undefined, HONCHO_WORKSPACE: undefined, HONCHO_PEER_NAME: undefined }, async () => {
      const hooks = await createHonchoRuntimePlugin({ configPath })({
        client: { app: { log: async () => undefined } },
        project: { id: "p", worktree: repo },
        directory: repo,
        worktree: repo,
        serverUrl: new URL("http://127.0.0.1:4096"),
        $: {},
      })
      const sessionID = "ses_Abc123"
      await hooks.event({ event: { type: "session.created", properties: { info: { id: sessionID, directory: repo, version: "1.18.25" } } } })

      const config = JSON.parse(await readFile(configPath, "utf-8"))
      expect(config.apiKey).toBe("hch-test-key") // top level untouched
      expect(config.hosts.harness).toEqual(original.hosts.harness) // other hosts untouched
      expect(config.hosts.opencode).toEqual({ workspace: "work", aiPeer: "opencode", apiKey: "hch-test-key", peerName: "user", schemaVersion: 2 })

      const opened = honcho.calls.find((c) => c.pathname === "/v3/workspaces/work/sessions")
      expect(opened.body.id).toBe(sessionID)
      expect(opened.body.peers).toEqual({ user: { observe_me: true, observe_others: false }, opencode: { observe_me: true, observe_others: false } })
      expect(opened.body.scopes).toEqual(["my-repo", os.hostname().split(".")[0].toLowerCase().replace(/[^a-z0-9_-]/g, "-")])

      const prompt = (text, synthetic) =>
        hooks["chat.message"]({ sessionID }, { message: { id: "u", time: { created: 1 } }, parts: [{ type: "text", text }, ...(synthetic ? [{ type: "text", text: synthetic, synthetic: true }] : [])] })
      const turn = honcho.calls.length
      await prompt("I always use bun, never npm.", "Called the Read tool with the following input")
      await hooks["command.execute.before"]({ command: "review", sessionID, arguments: "" }, { parts: [] })
      await prompt("Review the staged diff and list problems.") // the command's expansion
      await prompt("/honcho:status")
      await prompt("x".repeat(50_000))
      for (const [index, text] of ["Noted: bun", "Done."].entries()) {
        const messageID = `msg_${index}`
        await hooks.event({ event: { type: "message.part.updated", properties: { part: { id: `p${index}`, sessionID, messageID, type: "text", text } } } })
        await hooks.event({ event: { type: "message.updated", properties: { info: { id: messageID, sessionID, role: "assistant", time: { created: 2, completed: 3 } } } } })
      }

      const system = []
      for (let i = 0; i < 3; i++) {
        const output = { system: [] }
        await hooks["experimental.chat.system.transform"]({ sessionID, model: {} }, output)
        system.push(output.system)
      }

      const saved = honcho.calls.slice(turn).filter((c) => c.pathname.endsWith("/messages")).flatMap((c) => c.body.messages)
      expect(saved.map((m) => [m.peer_id, m.content.slice(0, 12)])).toEqual([
        ["user", "I always use"],
        ["user", "[Part 1/3] x"],
        ["user", "[Part 2/3] x"],
        ["user", "[Part 3/3] x"],
        ["opencode", "Noted: bun"],
        ["opencode", "Done."],
      ])
      expect(saved[0].content).toBe("I always use bun, never npm.")
      expect(saved.slice(1, 4).reduce((n, m) => n + m.content.replace(/^\[Part \d\/3\] /, "").length, 0)).toBe(50_000)

      // Directives + peer card, identical on every request; the card is fetched once.
      expect(system[0]).toHaveLength(1)
      expect(system[0][0]).toContain("call `honcho_chat`")
      expect(system[0][0]).toContain("`my-repo`")
      expect(system[0][0]).toContain("Profile: Prefers small, focused PRs")
      expect(system[1]).toEqual(system[0])
      expect(system[2]).toEqual(system[0])
      const after = honcho.calls.slice(turn).map((c) => `${c.method} ${c.pathname}`)
      expect(after.filter((p) => p.endsWith("/card"))).toHaveLength(1)
      expect(after.filter((p) => /\/(context|summaries|chat|conclusions)/.test(p))).toEqual([])

      // The chat tool: the user's own view, optionally scoped, or the whole workspace.
      const chat = (args) => hooks.tool.honcho_chat.execute(args, { sessionID })
      expect(await chat({ query: "What package manager?", scope: "my-repo" })).toBe("answer from /v3/workspaces/work/peers/user/chat")
      expect(await chat({ query: "Who is here?", workspace: true, reasoning_level: "low" })).toBe("answer from /v3/workspaces/work/chat")
      const chats = honcho.calls.filter((c) => c.pathname.endsWith("/chat"))
      expect(chats.map((c) => [c.body.scope ?? null, c.body.reasoning_level, c.body.target ?? null])).toEqual([
        ["my-repo", "medium", null],
        [null, "low", null],
      ])
    })
  } finally {
    globalThis.fetch = realFetch
  }
})

test("a session Honcho already has joins no scopes again", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "honcho-resume-"))
  const configPath = path.join(root, "config.json")
  await writeFile(configPath, JSON.stringify({ hosts: { opencode: { apiKey: "hch-test-key", peerName: "user" } } }))
  const honcho = fakeHoncho(["ses_old"])
  const realFetch = globalThis.fetch
  globalThis.fetch = honcho.fetch
  try {
    await withEnv({ HOME: root, HONCHO_API_KEY: undefined, HONCHO_BASE_URL: undefined, HONCHO_URL: undefined }, async () => {
      const hooks = await createHonchoRuntimePlugin({ configPath })({
        client: { app: { log: async () => undefined } },
        directory: root,
        worktree: root,
        serverUrl: new URL("http://127.0.0.1:4096"),
        $: {},
      })
      // A resumed session already has messages; attaching its scopes again would queue a backfill.
      await hooks["chat.message"]({ sessionID: "ses_old" }, { message: { id: "u", time: { created: 1 } }, parts: [{ type: "text", text: "hello again" }] })
      const opened = honcho.calls.find((c) => c.pathname === "/v3/workspaces/opencode/sessions")
      expect(opened.body.id).toBe("ses_old")
      expect(honcho.calls.filter((c) => c.pathname.endsWith("/messages")).flatMap((c) => c.body.messages).map((m) => m.content)).toEqual(["hello again"])
      expect(opened.body.scopes).toBeUndefined()
    })
  } finally {
    globalThis.fetch = realFetch
  }
})
