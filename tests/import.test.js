import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import os from "node:os"
import path from "node:path"
import { mkdtemp } from "node:fs/promises"

import { extractImportMessages, planOpenCodeImport } from "../src/import.ts"

const seedOpenCodeDb = (dbPath) => {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `)
  const now = Date.now()
  db.run(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
     VALUES (?, 'proj', NULL, 'slug', ?, 'Marker session', '1', ?, ?)`,
    ["ses_keep", path.dirname(dbPath), now - 1000, now - 1000],
  )
  db.run(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
     VALUES (?, 'proj', 'ses_keep', 'child', ?, 'Subagent', '1', ?, ?)`,
    ["ses_child", path.dirname(dbPath), now - 500, now - 500],
  )
  db.run(
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 'ses_keep', ?, ?, ?)`,
    ["msg_user", now - 900, now - 900, JSON.stringify({ role: "user", time: { created: now - 900 } })],
  )
  db.run(
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 'ses_keep', ?, ?, ?)`,
    ["msg_assistant", now - 800, now - 800, JSON.stringify({ role: "assistant", time: { created: now - 800 } })],
  )
  db.run(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, 'msg_user', 'ses_keep', ?, ?, ?)`,
    ["part_user", now - 900, now - 900, JSON.stringify({ type: "text", text: "The test marker is blue." })],
  )
  db.run(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, 'msg_assistant', 'ses_keep', ?, ?, ?)`,
    ["part_assistant", now - 800, now - 800, JSON.stringify({ type: "text", text: "Noted, I will remember the blue marker." })],
  )
  db.close()
}

test("import extracts user/assistant text, skips slash commands and subagent sessions", async () => {
  expect(
    extractImportMessages(
      [
        { id: "1", timeCreated: 1, data: JSON.stringify({ role: "user", time: { created: 1 } }) },
        { id: "2", timeCreated: 2, data: JSON.stringify({ role: "user", time: { created: 2 } }) },
        { id: "3", timeCreated: 3, data: JSON.stringify({ role: "assistant", time: { created: 3 } }) },
      ],
      new Map([
        ["1", [{ data: JSON.stringify({ type: "text", text: "/honcho:status" }) }]],
        ["2", [{ data: JSON.stringify({ type: "text", text: "The test marker is blue." }) }]],
        ["3", [{ data: JSON.stringify({ type: "reasoning", text: "thinking" }) }, { data: JSON.stringify({ type: "text", text: "Got it." }) }]],
      ]),
    ),
  ).toEqual([
    { role: "user", content: "The test marker is blue.", createdAt: new Date(2).toISOString() },
    { role: "assistant", content: "Got it.", createdAt: new Date(3).toISOString() },
  ])

  const rootDir = await mkdtemp(path.join(os.tmpdir(), "honcho-import-plan-"))
  const dbPath = path.join(rootDir, "opencode.db")
  seedOpenCodeDb(dbPath)
  const plan = await planOpenCodeImport({
    workspaceId: "opencode",
    sessionStrategy: "per-directory",
    agentPeerId: "opencode",
    dbPath,
    statePath: path.join(rootDir, "state.json"),
  })
  expect(plan.sessionCount).toBe(1)
  expect(plan.sessions.some((session) => session.id === "ses_child")).toBe(false)
})
