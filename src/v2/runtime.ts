import { z } from "zod"
import { createHonchoCore, type HostAdapter, type HostLogLevel } from "../index.js"
import { isRecord, timestampToIso } from "../core.js"
import { createCommandMatcher, isGeneratedPrompt } from "./commands.js"
import type { Model, Plugin } from "@opencode/plugin"

type ModelRef = Model.Ref
type PluginContext = Plugin.Context
type PluginDefinition = Plugin.Plugin
/** One event from `ctx.event.subscribe()`. */
type V2Event = ReturnType<PluginContext["event"]["subscribe"]> extends AsyncIterable<infer E> ? E : never

export const PLUGIN_ID = "@honcho-ai/opencode-honcho"

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

const eventLocationDirectory = (event: V2Event) => {
  const location: unknown = isRecord(event) ? event.location : undefined
  return isRecord(location) ? str(location.directory) : null
}

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
  const configPath =
    typeof ctx.options?.configPath === "string" ? ctx.options.configPath : process.env.OPENCODE_HONCHO_CONFIG_PATH || undefined
  const core = createHonchoCore(consoleHost(ctx.location.directory, ctx.location.project?.directory), configPath)
  core.setHostVersion(ctx.app.version)
  const trace = Boolean(process.env.OPENCODE_HONCHO_TRACE_EVENTS)

  const here = ctx.location.directory
  const sessionDirectories = new Map<string, string>()
  const ownsSession = (event: V2Event, sessionID: string) => {
    const published = eventLocationDirectory(event)
    if (published) sessionDirectories.set(sessionID, published)
    return (published ?? sessionDirectories.get(sessionID)) === here
  }

  // `opencode run` creates its session before this instance's event stream is live, so
  // session.created can be missed. The first prompt of a session not seen yet asks OpenCode
  // for its directory and whether it is a subagent's (those are skipped).
  const seen = new Set<string>()
  const learnSession = async (sessionID: string) => {
    if (seen.has(sessionID)) return
    seen.add(sessionID)
    try {
      const info = await ctx.session.get({ sessionID })
      core.noteSession(sessionID, info.location?.directory ?? null, info.parentID ?? null)
    } catch (error) {
      await core.log("debug", "Honcho could not read the OpenCode session.", {
        sessionId: sessionID,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // 2.x sends a slash command's expansion through this same hook, untagged; see ./commands.ts.
  const isCommandExpansion = createCommandMatcher(here)

  await ctx.session.hook("prompt", async (event) => {
    sessionDirectories.set(event.sessionID, here)
    await learnSession(event.sessionID)
    const text = typeof event.prompt.text === "string" ? event.prompt.text : ""
    if (trace) await core.log("debug", "prompt", { sessionId: event.sessionID, metadata: event.metadata ?? null, text: text.slice(0, 120) })
    if (isGeneratedPrompt(event.metadata) || isCommandExpansion(text)) {
      await core.log("debug", "Honcho skipped a generated or slash command prompt.", { sessionId: event.sessionID })
      return
    }
    await core.captureUserPrompt(event.sessionID, text, timestampToIso(Date.now()), "session.prompt")
  })

  // Directives and the peer card, fetched once per session; nothing else is added per request.
  await ctx.session.hook("context", async (event) => {
    core.rememberSessionModel(event.sessionID, modelId(event.model))
    const block = await core.sessionStartBlock(event.sessionID)
    if (block) event.system.push({ type: "text", text: block })
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
    const owned = ownsSession(event, sessionID)
    if (event.type === "session.deleted") sessionDirectories.delete(sessionID)
    if (trace) {
      await core.log("debug", "event", {
        type: event.type,
        sessionId: sessionID,
        location: eventLocationDirectory(event),
        directory: ctx.location.directory,
        owned,
      })
    }
    if (!owned) return
    switch (event.type) {
      case "session.created": {
        seen.add(sessionID)
        const sessionLocation = isRecord(data.location) ? str(data.location.directory) : null
        await core.sessionCreated(sessionID, sessionLocation ?? here, str(data.parentID))
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
        if (messageId) core.stashAssistantText(sessionID, messageId, String(data.ordinal ?? 0), text)
        return
      }
      case "session.step.ended": {
        const messageId = str(data.assistantMessageID)
        if (messageId) await core.flushAssistantMessage(sessionID, messageId, timestampToIso(event.created), "event.session.step.ended")
        return
      }
      case "session.execution.succeeded":
      case "session.execution.interrupted":
      case "session.execution.failed": {
        // Turn boundary: flush anything a step did not close. On a stop, whatever the user saw
        // before it is what gets remembered.
        for (const messageId of core.pendingAssistantMessageIds(sessionID)) {
          await core.flushAssistantMessage(sessionID, messageId, timestampToIso(event.created), `event.${event.type}`)
        }
        return
      }
      case "session.deleted": {
        core.forgetSession(sessionID)
        return
      }
      default:
        return
    }
  }

  const controller = new AbortController()
  const inflight = new Set<Promise<void>>()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (!isCurrentGeneration(location, generation)) break
        const work = handleEvent(event)
        inflight.add(work)
        try {
          await work
        } catch (error) {
          await core.log("error", "Honcho event handling failed.", {
            event: event.type,
            message: error instanceof Error ? error.message : String(error),
          })
        } finally {
          inflight.delete(work)
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

  // `opencode run --standalone` exits once this resolves, so wait for writes still in flight.
  // Never await the stream itself: that stalls plugin reloads.
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SETTLE_TIMEOUT_MS)
    })
    await Promise.race([Promise.allSettled([...inflight]), timeout]).finally(() => clearTimeout(timer))
    controller.abort()
  }
}

export const definition: PluginDefinition = { id: PLUGIN_ID, setup }
