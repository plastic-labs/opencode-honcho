import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdtemp } from "node:fs/promises"

import { planOpenCodeImport, transcriptSourceFromV2Client } from "../dist/import.js"

test("import walks every project with scope=project and reads whole transcripts in order", async () => {
  const now = Date.now()
  const dir = await mkdtemp(path.join(os.tmpdir(), "honcho-import-"))
  const text = (id, body, extra = {}) => ({ id, sessionID: "s", messageID: id, type: "text", text: body, ...extra })
  const calls = []
  const client = {
    project: { list: async () => ({ data: [{ id: "global", worktree: "/" }, { id: "repo", worktree: dir }] }) },
    session: {
      list: async (params) => {
        calls.push(params)
        return { data: params.directory === "/" ? [{ id: "a", directory: os.homedir(), title: "A", time: { created: now, updated: now } }] : [] }
      },
      // Served newest-first with a tool-only message and an ignored part to prove filtering + sorting.
      messages: async (params) => {
        calls.push(params)
        return {
          data: [
            { info: { id: "m3", role: "assistant", time: { created: now + 2 } }, parts: [{ id: "p3", sessionID: "s", messageID: "m3", type: "tool" }] },
            { info: { id: "m2", role: "assistant", time: { created: now + 1 } }, parts: [text("p2", "hi back")] },
            { info: { id: "m1", role: "user", time: { created: now } }, parts: [text("p1", " hello "), text("p1b", "hidden", { ignored: true })] },
          ],
        }
      },
    },
  }

  const plan = await planOpenCodeImport({
    client,
    workspaceId: "ws",
    sessionStrategy: "per-session",
    agentPeerId: "opencode",
    statePath: path.join(dir, "state.json"),
    days: 7,
    includeMessages: true,
  })

  expect(calls.map((c) => c.directory)).toEqual(["/", dir, undefined])
  expect(calls[0]).toMatchObject({ scope: "project", roots: true, limit: expect.any(Number) })
  expect(calls[0].start).toBeGreaterThan(now - 8 * 86_400_000)
  expect(calls[2]).toEqual({ sessionID: "a" })
  expect(plan.sessions[0].messages).toEqual([
    { role: "user", content: "hello", createdAt: new Date(now).toISOString() },
    { role: "assistant", content: "hi back", createdAt: new Date(now + 1).toISOString() },
  ])
})

test("v2 source pages sessions newest-first until the window, then reads transcripts oldest-first", async () => {
  const now = Date.now()
  const dir = await mkdtemp(path.join(os.tmpdir(), "honcho-import-v2-"))
  const calls = []
  const session = (id, updated, extra = {}) => ({ id, title: `S${id}`, projectID: "p", location: { directory: dir }, time: { created: updated, updated }, ...extra })
  const client = {
    session: {
      list: async (params) => {
        calls.push(params)
        return params.cursor
          ? { data: [session("old", now - 40 * 86_400_000)], cursor: {} } // outside the 7 day window: stop
          : { data: Array.from({ length: 200 }, (_, i) => session(`s${i}`, now - i)), cursor: { next: "c1" } }
      },
    },
    message: {
      list: async (params) => {
        calls.push(params)
        return {
          data: [
            { id: "m1", type: "user", text: " hello ", time: { created: now } },
            { id: "m2", type: "assistant", content: [{ type: "reasoning", text: "x" }, { type: "text", text: "hi back" }], time: { created: now + 1 } },
            { id: "m3", type: "assistant", content: [{ type: "tool", name: "read" }], time: { created: now + 2 } },
            { id: "m4", type: "compaction", time: { created: now + 3 } },
          ],
          cursor: {},
        }
      },
    },
  }

  const plan = await planOpenCodeImport({
    source: transcriptSourceFromV2Client(client),
    workspaceId: "ws",
    sessionStrategy: "per-session",
    agentPeerId: "opencode",
    statePath: path.join(dir, "state.json"),
    days: 7,
    includeMessages: true,
  })

  expect(calls[0]).toEqual({ order: "desc", limit: 200, parentID: null })
  expect(calls[1]).toEqual({ cursor: "c1", limit: 200 })
  expect(calls[2]).toEqual({ sessionID: "s0", order: "asc", limit: 200 })
  expect(plan.sessions).toHaveLength(200)
  expect(plan.sessions[0].messages).toEqual([
    { role: "user", content: "hello", createdAt: new Date(now).toISOString() },
    { role: "assistant", content: "hi back", createdAt: new Date(now + 1).toISOString() },
  ])
})
