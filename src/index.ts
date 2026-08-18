import { Plugin } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  createHonchoRuntimePlugin,
  type RuntimePluginOptions,
} from "./v1/index.js"

const PACKAGE_ID = "@honcho-ai/opencode-honcho"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readTextPart = (part: unknown) => {
  if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
    return null
  }
  return part.text
}

const readVisibleTextPart = (part: unknown) => {
  const text = readTextPart(part)
  if (!text) return null
  if (isRecord(part) && part.ignored === true) return null
  return text.trim() || null
}

const extractText = (parts: unknown) =>
  Array.isArray(parts)
    ? parts
        .map(readVisibleTextPart)
        .filter((value): value is string => Boolean(value))
        .join("\n")
        .trim()
    : ""

const extractQueryFromMessages = (messages: unknown) => {
  if (!Array.isArray(messages)) return ""
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message) || message.role !== "user") continue
    const content = message.content
    if (!Array.isArray(content)) {
      if (typeof content === "string") return content
      continue
    }
    const text = extractText(content)
    if (text) return text
  }
  return ""
}

const mapV1ToolResult = (result: unknown): { content: string } => {
  if (typeof result === "string") return { content: result }
  if (isRecord(result) && typeof result.output === "string") {
    return { content: result.output }
  }
  return { content: String(result) }
}

const createV1PluginInput = (ctx: any, directory: string) => ({
  client: {
    app: {
      log: async (body: any) => {
        const level = body?.level ?? "info"
        const message = body?.message ?? ""
        const extra = body?.extra
        const formatted = extra
          ? `${message} ${JSON.stringify(extra)}`
          : message
        if (level === "error") {
          console.error(`[${body?.service ?? PACKAGE_ID}] ${formatted}`)
        } else if (level === "warn") {
          console.warn(`[${body?.service ?? PACKAGE_ID}] ${formatted}`)
        } else {
          console.log(`[${body?.service ?? PACKAGE_ID}] ${formatted}`)
        }
      },
    },
  },
  project: {
    id: "opencode",
    worktree: directory,
  },
  directory,
  worktree: directory,
  serverUrl: new URL("http://127.0.0.1:4096"),
  $: {},
  experimental_workspace: {
    register: () => {},
  },
})

const getDirectoryFromSession = async (
  ctx: any,
  sessionID: string,
): Promise<string | undefined> => {
  try {
    const session = await ctx.session.get(sessionID)
    const directory = session?.location?.directory
    if (typeof directory === "string") return directory
  } catch {
    // fall through
  }
  return undefined
}

const mapV2EventToV1 = (event: unknown) => {
  if (!isRecord(event)) return event
  const data = isRecord(event.data) ? event.data : {}
  return {
    ...event,
    properties: data,
  }
}

export default Plugin.define({
  id: PACKAGE_ID,
  setup: async (ctx) => {
    const configPath =
      typeof ctx.options.configPath === "string" ? ctx.options.configPath : undefined
    const options: RuntimePluginOptions = { configPath }

    const v1InstancesByDirectory = new Map<
      string,
      Promise<Awaited<ReturnType<ReturnType<typeof createHonchoRuntimePlugin>>>>
    >()

    const getV1Instance = async (directory: string) => {
      let pending = v1InstancesByDirectory.get(directory)
      if (!pending) {
        const makeHooks = createHonchoRuntimePlugin(options)
        pending = makeHooks(createV1PluginInput(ctx, directory) as any).catch((error) => {
          v1InstancesByDirectory.delete(directory)
          throw error
        })
        v1InstancesByDirectory.set(directory, pending)
      }
      return pending
    }

    // Prime a dummy instance to read the tool definitions synchronously inside
    // the transform callback. The executors will re-resolve the correct
    // directory at runtime.
    const dummyDirectory = process.cwd()
    const dummyInstance = await getV1Instance(dummyDirectory)
    const v1ToolDefinitions = dummyInstance.tool ?? {}

    // Register tools using the v2 API.
    await ctx.tool.transform((tools) => {
      for (const [name, definition] of Object.entries(v1ToolDefinitions)) {
        if (!definition) continue
        const argsSchema = z.object(definition.args as any)
        const inputSchema = z.toJSONSchema(argsSchema)

        tools.add({
          name,
          description: definition.description,
          input: inputSchema as any,
          execute: async (args: Record<string, unknown>, toolCtx: any) => {
            const instance = await getV1Instance(toolCtx.directory)
            const v1Tool = instance.tool?.[name]
            if (!v1Tool) {
              throw new Error(`Honcho tool "${name}" is not available.`)
            }
            const result = await v1Tool.execute(args, {
              sessionID: toolCtx.sessionID,
              messageID: toolCtx.messageID,
              agent: toolCtx.agent,
              directory: toolCtx.directory,
              worktree: toolCtx.worktree,
              abort: toolCtx.abort,
              metadata: () => {},
              ask: async () => {},
            })
            return mapV1ToolResult(result)
          },
        })
      }
    })

    // Inject Honcho memory into system prompts.
    await ctx.session.hook("context", async (event) => {
      const directory = await getDirectoryFromSession(ctx, event.sessionID)
      if (!directory) return
      const instance = await getV1Instance(directory)
      if (!instance["experimental.chat.system.transform"]) return

      const input: any = {
        sessionID: event.sessionID,
        agent: event.agent,
        model: event.model,
      }
      const query = extractQueryFromMessages(event.messages)
      if (query) input.query = query

      const output: { system: string[] } = { system: [] }
      await instance["experimental.chat.system.transform"](input, output)

      for (const text of output.system) {
        if (!text.trim()) continue
        event.system.push({ type: "text", text })
      }
    })

    // Inject Honcho env vars into shell sessions.
    await ctx.shell.hook("create.before", async (event) => {
      const instance = await getV1Instance(event.cwd)
      if (!instance["shell.env"]) return
      const input = { cwd: event.cwd }
      const output: { env: Record<string, string> } = { env: {} }
      await instance["shell.env"](input, output)
      Object.assign(event.env, output.env)
    })

    // Forward v2 public events to the v1 event hook. This keeps session
    // lifecycle logging and assistant-message capture working when the event
    // shapes overlap.
    if (dummyInstance.event && (ctx as any).event?.subscribe) {
      const subscribe = (ctx as any).event.subscribe as (cb: (event: unknown) => void | Promise<void>) => Promise<{ dispose: () => Promise<void> }>
      await subscribe(async (event) => {
        try {
          const v1Event = mapV2EventToV1(event)
          const sessionID =
            typeof (v1Event as any).sessionID === "string"
              ? (v1Event as any).sessionID
              : typeof (v1Event as any).data?.sessionID === "string"
                ? (v1Event as any).data.sessionID
                : undefined
          const directory = sessionID
            ? await getDirectoryFromSession(ctx, sessionID)
            : dummyDirectory
          if (!directory) return
          const instance = await getV1Instance(directory)
          if (!instance.event) return
          await instance.event({ event: v1Event } as any)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          console.error(`[${PACKAGE_ID}] v2 event forwarding failed: ${detail}`)
        }
      })
    }

    // Register slash commands for the v2 command palette.
    if ((ctx as any).command?.transform) {
      const commandTransform = (ctx as any).command.transform as typeof ctx.tool.transform
      await commandTransform((commands: any) => {
        commands.update("honcho:setup", (command: any) => {
          command.description = "Configure Honcho Cloud or local settings for OpenCode"
          command.template = "Run the honcho_setup tool to configure Honcho. Ask the user for their API key, base URL, and peer name if needed."
        })
        commands.update("honcho:status", (command: any) => {
          command.description = "Show effective Honcho status for the current OpenCode project"
          command.template = "Run the honcho_status tool and summarize the current Honcho workspace, session, and peer configuration."
        })
        commands.update("honcho:settings", (command: any) => {
          command.description = "Show effective Honcho config values"
          command.template = "Run the honcho_get_config tool and show the effective Honcho settings for OpenCode."
        })
        commands.update("honcho:config", (command: any) => {
          command.description = "Update a persisted Honcho setting"
          command.template = "Ask the user which Honcho config field they want to update and what value to set, then run the honcho_set_config tool."
        })
      })
    }

    // Best-effort user-message capture: the v2 "context" hook gives us the
    // full message list before each model dispatch. We capture any user
    // message we have not seen yet through the v1 chat.message hook.
    const MAX_CAPTURED_MESSAGE_IDS = 1000
    const capturedMessageIds = new Set<string>()
    await ctx.session.hook("context", async (event) => {
      if (!Array.isArray(event.messages)) return
      const directory = await getDirectoryFromSession(ctx, event.sessionID)
      if (!directory) return
      const instance = await getV1Instance(directory)
      if (!instance["chat.message"]) return

      for (const message of event.messages) {
        if (!isRecord(message) || message.role !== "user") continue

        const content = message.content
        const text = Array.isArray(content) ? extractText(content) : typeof content === "string" ? content : ""
        if (!text) continue

        const messageID =
          typeof message.id === "string" ? message.id : `${event.sessionID}-${Bun.hash(text)}`
        if (capturedMessageIds.has(messageID)) continue

        await instance["chat.message"](
          { sessionID: event.sessionID, messageID },
          {
            message: message as any,
            parts: Array.isArray(content) ? content : [{ type: "text", text }],
          },
        )

        if (capturedMessageIds.size >= MAX_CAPTURED_MESSAGE_IDS) {
          const oldest = capturedMessageIds.values().next().value
          if (typeof oldest === "string") {
            capturedMessageIds.delete(oldest)
          }
        }
        capturedMessageIds.add(messageID)
      }
    })
  },
})
