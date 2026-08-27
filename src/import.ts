import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { Honcho } from "@honcho-ai/sdk"
import {
  SHARED_SETTINGS_DIR_NAME,
  clampText,
  deriveSessionScope,
  findProjectRoot,
  honchoSessionKey,
  isRecord,
  timestampToIso,
  userHomeDir,
  type SessionStrategy,
} from "./core.js"

export type ImportMessage = {
  role: "user" | "assistant"
  content: string
  createdAt?: string
}

export type OpenCodeSessionRow = {
  id: string
  directory: string
  title: string
  parentId: string | null
  timeCreated: number
  timeUpdated: number
}

export type PlannedImportSession = {
  id: string
  title: string
  directory: string
  honchoSessionKey: string
  timeUpdated: number
  messageCount: number
  alreadyImported: boolean
  skippedReason?: string
  messages: ImportMessage[]
}

export type ImportPlan = {
  ok: true
  dbPath: string
  days: number
  sessionCount: number
  messageCount: number
  skippedCount: number
  alreadyImportedCount: number
  sessions: Array<Omit<PlannedImportSession, "messages"> & { messages?: ImportMessage[] }>
}

export type ImportUploadResult = ImportPlan & {
  dryRun: boolean
  uploadedSessions: number
  uploadedMessages: number
  errors: string[]
}

type ImportState = {
  imported: Record<string, number>
}

const IMPORT_STATE_FILE_NAME = "opencode-import-state.json"
const MAX_IMPORT_MESSAGE_CHARS = 25_000
const ADD_MESSAGES_BATCH = 40

export const defaultOpenCodeDbPath = () =>
  process.env.OPENCODE_DB_PATH ||
  path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "opencode", "opencode.db")

export const defaultImportStatePath = () =>
  process.env.HONCHO_IMPORT_STATE_PATH ||
  path.join(userHomeDir(), SHARED_SETTINGS_DIR_NAME, IMPORT_STATE_FILE_NAME)

const importStateKey = (workspaceId: string, sessionId: string) => `${workspaceId}::${sessionId}`

const loadImportState = async (statePath: string): Promise<ImportState> => {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf-8"))
    return isRecord(parsed) && isRecord(parsed.imported)
      ? { imported: parsed.imported as Record<string, number> }
      : { imported: {} }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { imported: {} }
    }
    throw error
  }
}

const saveImportState = async (statePath: string, state: ImportState) => {
  await mkdir(path.dirname(statePath), { recursive: true })
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8")
}

const importedSessionKey = async ({
  workspaceId,
  sessionStrategy,
  directory,
  sessionId,
  agentPeerId,
}: {
  workspaceId: string
  sessionStrategy: SessionStrategy
  directory: string
  sessionId: string
  agentPeerId: string
}) => {
  const rootDir = findProjectRoot(directory)
  const scope = await deriveSessionScope({
    workspaceId,
    sessionStrategy,
    rootDir,
    repoName: path.basename(rootDir),
    currentDirectory: directory,
    sessionId,
  })
  return honchoSessionKey(sessionStrategy, scope, [agentPeerId])
}

const parseMessageData = (raw: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

const extractTextFromParts = (parts: Array<{ data: string }>) => {
  const texts: string[] = []
  for (const part of parts) {
    const parsed = parseMessageData(part.data)
    if (!parsed || parsed.type !== "text" || typeof parsed.text !== "string") continue
    if (parsed.ignored === true) continue
    const text = parsed.text.trim()
    if (text) texts.push(text)
  }
  return texts.join("\n").trim()
}

export const extractImportMessages = (
  messages: Array<{ id: string; timeCreated: number; data: string }>,
  partsByMessage: Map<string, Array<{ data: string }>>,
): ImportMessage[] => {
  const out: ImportMessage[] = []
  for (const message of messages) {
    const parsed = parseMessageData(message.data)
    const role = parsed?.role === "assistant" ? "assistant" : parsed?.role === "user" ? "user" : null
    if (!role) continue
    const content = clampText(extractTextFromParts(partsByMessage.get(message.id) || []), MAX_IMPORT_MESSAGE_CHARS)
    if (!content) continue
    const created =
      isRecord(parsed?.time) && typeof parsed.time.created === "number" ? parsed.time.created : message.timeCreated
    out.push({ role, content, createdAt: timestampToIso(created) })
  }
  return out
}

const readSessionsFromDb = (dbPath: string, days: number, includeSubagents: boolean): OpenCodeSessionRow[] => {
  const db = new Database(dbPath, { readonly: true })
  try {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const rows = db
      .query(
        `SELECT id, directory, title, parent_id AS parentId, time_created AS timeCreated, time_updated AS timeUpdated
         FROM session
         WHERE time_updated >= ?
         ORDER BY time_updated DESC`,
      )
      .all(cutoff) as Array<{
      id: string
      directory: string
      title: string
      parentId: string | null
      timeCreated: number
      timeUpdated: number
    }>
    return rows.filter((row) => includeSubagents || !row.parentId)
  } finally {
    db.close()
  }
}

const readSessionTranscript = (dbPath: string, sessionId: string): ImportMessage[] => {
  const db = new Database(dbPath, { readonly: true })
  try {
    const messages = db
      .query(
        `SELECT id, time_created AS timeCreated, data FROM message WHERE session_id = ? ORDER BY time_created, id`,
      )
      .all(sessionId) as Array<{ id: string; timeCreated: number; data: string }>
    const parts = db
      .query(
        `SELECT message_id AS messageId, data FROM part WHERE session_id = ? ORDER BY time_created, id`,
      )
      .all(sessionId) as Array<{ messageId: string; data: string }>
    const partsByMessage = new Map<string, Array<{ data: string }>>()
    for (const part of parts) {
      const list = partsByMessage.get(part.messageId) || []
      list.push({ data: part.data })
      partsByMessage.set(part.messageId, list)
    }
    return extractImportMessages(messages, partsByMessage)
  } finally {
    db.close()
  }
}

export type PlanImportOptions = {
  workspaceId: string
  sessionStrategy: SessionStrategy
  agentPeerId: string
  dbPath?: string
  statePath?: string
  days?: number
  includeSubagents?: boolean
  force?: boolean
  includeMessages?: boolean
}

export const planOpenCodeImport = async (options: PlanImportOptions): Promise<ImportPlan> => {
  const dbPath = options.dbPath || defaultOpenCodeDbPath()
  const statePath = options.statePath || defaultImportStatePath()
  const days = options.days && options.days > 0 ? options.days : 30
  if (!existsSync(dbPath)) {
    throw new Error(`OpenCode database not found at ${dbPath}`)
  }

  const state = await loadImportState(statePath)
  const rows = readSessionsFromDb(dbPath, days, options.includeSubagents === true)
  const sessions: PlannedImportSession[] = []

  for (const row of rows) {
    const messages = readSessionTranscript(dbPath, row.id)
    const alreadyImported = state.imported[importStateKey(options.workspaceId, row.id)] === row.timeUpdated
    const skippedReason =
      messages.length === 0 ? "no text messages" : alreadyImported && !options.force ? "already imported" : undefined
    sessions.push({
      id: row.id,
      title: row.title,
      directory: row.directory,
      honchoSessionKey: await importedSessionKey({
        workspaceId: options.workspaceId,
        sessionStrategy: options.sessionStrategy,
        directory: row.directory,
        sessionId: row.id,
        agentPeerId: options.agentPeerId,
      }),
      timeUpdated: row.timeUpdated,
      messageCount: messages.length,
      alreadyImported,
      skippedReason,
      messages,
    })
  }

  const uploadable = sessions.filter((session) => !session.skippedReason)
  return {
    ok: true,
    dbPath,
    days,
    sessionCount: uploadable.length,
    messageCount: uploadable.reduce((sum, session) => sum + session.messageCount, 0),
    skippedCount: sessions.filter((session) => session.skippedReason && session.skippedReason !== "already imported").length,
    alreadyImportedCount: sessions.filter((session) => session.alreadyImported).length,
    sessions: sessions.map((session) =>
      options.includeMessages ? session : { ...session, messages: undefined },
    ),
  }
}

const addMessagesBatched = async (
  session: Awaited<ReturnType<Honcho["session"]>>,
  messages: ReturnType<Awaited<ReturnType<Honcho["peer"]>>["message"]>[],
) => {
  for (let index = 0; index < messages.length; index += ADD_MESSAGES_BATCH) {
    await session.addMessages(messages.slice(index, index + ADD_MESSAGES_BATCH))
  }
}

export type ExecuteImportOptions = PlanImportOptions & {
  honcho: Honcho
  userPeerId: string
  agentObserveMe: boolean
  statePath?: string
}

export const executeOpenCodeImport = async (options: ExecuteImportOptions): Promise<ImportUploadResult> => {
  const plan = await planOpenCodeImport({ ...options, includeMessages: true })
  const statePath = options.statePath || defaultImportStatePath()
  const state = await loadImportState(statePath)
  const userPeer = await options.honcho.peer(options.userPeerId, { configuration: { observeMe: true } })
  const agentPeer = await options.honcho.peer(options.agentPeerId, {
    configuration: { observeMe: options.agentObserveMe === true },
  })

  let uploadedSessions = 0
  let uploadedMessages = 0
  const errors: string[] = []

  for (const sessionPlan of plan.sessions) {
    if (sessionPlan.skippedReason || !sessionPlan.messages) continue
    try {
      const session = await options.honcho.session(sessionPlan.honchoSessionKey)
      await session.addPeers([
        [options.userPeerId, { observeMe: true, observeOthers: false }],
        [options.agentPeerId, { observeMe: options.agentObserveMe === true, observeOthers: true }],
      ] as never)
      const payload = sessionPlan.messages.map((message) => {
        const peer = message.role === "user" ? userPeer : agentPeer
        return peer.message(message.content, {
          createdAt: message.createdAt,
          metadata: {
            backfill: true,
            source: "opencode.db",
            openCodeSessionId: sessionPlan.id,
          },
        })
      })
      await addMessagesBatched(session, payload)
      state.imported[importStateKey(options.workspaceId, sessionPlan.id)] = sessionPlan.timeUpdated
      await saveImportState(statePath, state)
      uploadedSessions += 1
      uploadedMessages += sessionPlan.messageCount
    } catch (error) {
      errors.push(`${sessionPlan.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    ...plan,
    sessions: plan.sessions.map(({ messages: _messages, ...session }) => session),
    dryRun: false,
    uploadedSessions,
    uploadedMessages,
    errors,
  }
}
