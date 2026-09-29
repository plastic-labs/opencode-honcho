import { z } from "zod"
import { createHonchoCore, ensureHonchoSkillInstalled, type HostAdapter, type HostLogLevel } from "../index.js"
import { isRecord, timestampToIso } from "../core.js"
import type { Model, Plugin } from "@opencode/plugin"

type ModelRef = Model.Ref
type PluginContext = Plugin.Context
type PluginDefinition = Plugin.Plugin
/** One event from `ctx.event.subscribe()`. */
type V2Event = ReturnType<PluginContext["event"]["subscribe"]> extends AsyncIterable<infer E> ? E : never

export const PLUGIN_ID = "@honcho-ai/opencode-honcho"

// Upper bound on how long the cleanup waits for in-flight Honcho writes before letting go.
const SETTLE_TIMEOUT_MS = 15_000

const modelId = (model: ModelRef | undefined) => {
  if (!model || typeof model.id !== "string" || !model.id.trim()) return null
  const provider = typeof model.providerID === "string" ? model.providerID.trim() : ""
  return provider ? `${provider}/${model.id.trim()}` : model.id.trim()
}

const eventData = (event: V2Event): Record<string, unknown> => {
  const data: unknown = event.data
  return isRecord(data) ? data : {}
}
const str = (value: unknown) => (typeof value === "string" && value ? value : null)

/**
 * Logger for the v2 path. Always stderr: the OpenCode 2 server can run with stdout as its RPC
 * transport (`serve --stdio`), so a plugin must never write to stdout.
 */
const consoleHost = (directory: string, worktree: string | undefined): HostAdapter => ({
  directory,
  worktree,
  log: async (level: HostLogLevel, message: string, extra: Record<string, unknown> = {}) => {
    console.error(`[opencode-honcho] ${level}: ${message} ${JSON.stringify(extra)}`)
  },
})

// One live runtime per plugin location. OpenCode 2 instantiates the plugin once per location and
// hot-reloads it by running the old generation's cleanup and then the new setup; a stale event
// loop must not keep capturing after that, while other locations keep running untouched.
const OWNER = Symbol.for("@honcho-ai/opencode-honcho.v2.generation")
const generations = (): Map<string, number> => {
  const g = globalThis as Record<symbol, Map<string, number> | undefined>
  return (g[OWNER] ??= new Map())
}
const nextGeneration = (location: string) => {
  const next = (generations().get(location) ?? 0) + 1
  generations().set(location, next)
  return next
}
const isCurrentGeneration = (location: string, generation: number) => generations().get(location) === generation

export const setup = async (ctx: PluginContext) => {
  const location = ctx.location.directory
  const generation = nextGeneration(location)
  const configPath = typeof ctx.options?.configPath === "string" ? ctx.options.configPath : undefined
  const core = createHonchoCore(consoleHost(ctx.location.directory, ctx.location.project?.directory), configPath)
  core.setHostVersion(ctx.app.version)

  // Prompt-specific recall per session. The v1 path appends it to the user message; on v2 the
  // prompt hook's edits become the persisted user text, so it rides in the request context instead.
  const pendingRecall = new Map<string, string>()

  // Work that has to land before this instance goes away. `opencode run --standalone` tears the
  // process down as soon as the reply is complete, so a Honcho write still in flight when the
  // cleanup below resolves is lost. The cleanup awaits this set, never the event stream.
  const inflight = new Set<Promise<unknown>>()
  const track = <T>(work: Promise<T>) => {
    inflight.add(work)
    work.then(() => inflight.delete(work), () => inflight.delete(work))
    return work
  }
  const settle = async () => {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS
    while (inflight.size > 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining)
        timer.unref?.()
      })
      await Promise.race([Promise.allSettled(Array.from(inflight)), timeout])
      clearTimeout(timer)
      // Let the event loop pull an event that was already queued behind the one that just settled.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  // Sessions this instance has hydrated. Under `opencode run --standalone` the plugin is loaded
  // inside the request that creates the session, after `session.created` has been published, so
  // that event never reaches this subscriber. The first hook for a session hydrates it instead;
  // whichever of the hook or the event arrives first wins, the other is a no-op.
  const hydrated = new Set<string>()
  const ensureSessionReady = async (sessionID: string) => {
    if (hydrated.has(sessionID)) return
    hydrated.add(sessionID)
    // Best effort, attempted even when Honcho is not configured.
    await ensureHonchoSkillInstalled()
    await core.hydrateSession({ sessionID })
  }

  await ctx.session.hook("prompt", async (event) => {
    const text = typeof event.prompt.text === "string" ? event.prompt.text.trim() : ""
    if (!text) return
    await ensureSessionReady(event.sessionID)
    const block = await core.captureUserPrompt(
      { sessionID: event.sessionID },
      text,
      timestampToIso(Date.now()),
      "session.prompt",
    )
    if (block) pendingRecall.set(event.sessionID, block)
    await core.log("debug", "Honcho captured user prompt.", { sessionId: event.sessionID, recall: Boolean(block) })
  })

  await ctx.session.hook("context", async (event) => {
    core.rememberSessionModel(event.sessionID, modelId(event.model))
    const blocks = await core.systemBlocks({ sessionID: event.sessionID })
    if (blocks.length === 0) return
    for (const text of blocks) event.system.push({ type: "text", text })
    const recall = pendingRecall.get(event.sessionID)
    if (recall) event.messages.push({ role: "user", content: [{ type: "text", text: recall }] })
  })

  await ctx.session.hook("compaction", async (event) => {
    event.system.push({ type: "text", text: await core.continuityBlock({ sessionID: event.sessionID }) })
  })

  await ctx.shell.hook("create.before", async (event) => {
    Object.assign(event.env, await core.shellEnv({}))
  })

  await ctx.tool.hook("execute.after", async (event) => {
    await core.captureToolActivity(event.sessionID, event.tool, event.input, event.id, "tool.execute.after")
  })

  await ctx.tool.transform((editor) => {
    for (const spec of core.toolSpecs) {
      editor.add({
        name: spec.name,
        description: spec.description,
        input: z.object(spec.args),
        options: { codemode: false },
        execute: async (input, context) => ({
          content: await spec.execute(isRecord(input) ? input : {}, context.sessionID),
        }),
      })
    }
  })

  const handleEvent = async (event: V2Event) => {
    const data = eventData(event)
    const sessionID = str(data.sessionID)
    if (!sessionID) return
    if (process.env.OPENCODE_HONCHO_TRACE_EVENTS) await core.log("debug", "event", { type: event.type, sessionId: sessionID })
    switch (event.type) {
      case "session.created": {
        await ensureSessionReady(sessionID)
        return
      }
      case "session.step.started": {
        const model = isRecord(data.model) ? (data.model as ModelRef) : undefined
        core.rememberSessionModel(sessionID, modelId(model))
        return
      }
      case "session.text.ended": {
        const messageId = str(data.assistantMessageID)
        const text = typeof data.text === "string" ? data.text : ""
        if (messageId) await core.stashAssistantText(sessionID, messageId, String(data.ordinal ?? 0), text)
        return
      }
      case "session.step.ended": {
        const messageId = str(data.assistantMessageID)
        if (messageId) {
          const captured = await core.flushAssistantMessage(sessionID, messageId, timestampToIso(event.created), "event.session.step.ended")
          if (captured) await core.log("debug", "Honcho captured assistant message.", { sessionId: sessionID, messageId })
        }
        return
      }
      case "session.execution.succeeded":
      case "session.execution.interrupted":
      case "session.execution.failed": {
        // Turn boundary: flush anything a step did not close. On a stop, whatever the user saw
        // before it is what gets remembered.
        for (const messageId of await core.pendingAssistantMessageIds(sessionID)) {
          const captured = await core.flushAssistantMessage(sessionID, messageId, timestampToIso(event.created), `event.${event.type}`)
          if (captured) await core.log("debug", "Honcho captured assistant message.", { sessionId: sessionID, messageId, event: event.type })
        }
        return
      }
      case "session.deleted": {
        pendingRecall.delete(sessionID)
        await core.dropSessionState({ sessionID })
        return
      }
      case "session.compaction.ended": {
        const handle = await core.deriveHandle({ sessionID })
        await core.log("info", "Honcho lifecycle boundary observed.", {
          event: event.type,
          sessionId: handle.sessionId,
          sessionKey: handle.sessionKey,
        })
        return
      }
      default:
        return
    }
  }

  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (!isCurrentGeneration(location, generation)) break
        try {
          await track(handleEvent(event))
        } catch (error) {
          await core.log("error", "Honcho event handling failed.", {
            event: event.type,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        await core.log("error", "Honcho event subscription ended.", {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  })()

  await core.log("info", "Honcho plugin loaded for OpenCode v2.", {
    version: ctx.app.version,
    channel: ctx.app.channel,
    directory: ctx.location.directory,
  })

  // Wait for in-flight work, then abort the stream. Never await the stream itself: waiting on it
  // here stalls plugin reloads. OpenCode 2 awaits the promise this returns (`Plugin.Cleanup` is
  // `() => Promise<void> | void`), which under `opencode run --standalone` is the only thing
  // holding the process open while the reply is still being written to Honcho.
  return async () => {
    if (inflight.size > 0) {
      await core.log("debug", "Honcho plugin unloading; waiting for in-flight work.", { pending: inflight.size })
    }
    await settle()
    controller.abort()
  }
}

export const definition: PluginDefinition = { id: PLUGIN_ID, setup }
