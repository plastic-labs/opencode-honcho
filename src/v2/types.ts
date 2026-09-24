/**
 * Structural types for the slice of the OpenCode v2 plugin API this plugin uses.
 *
 * Kept local (instead of depending on `@opencode/plugin`) so the package stays light and loads
 * on both OpenCode 1.x and 2.x. Shapes mirror `@opencode/plugin` 2.0.x:
 *   packages/plugin/src/promise/{plugin,session,tool,shell,event}.ts and src/tui/context.ts.
 */

export type ModelRef = { providerID: string; id: string; variant?: string }

export type SystemPart = { type: "text"; text: string; cache?: unknown; metadata?: Record<string, unknown> }

export type Registration = { dispose: () => Promise<void> }

export type SessionPromptEvent = {
  readonly sessionID: string
  readonly messageID: string
  prompt: { text: string; files?: unknown[]; agents?: unknown[]; skills?: unknown[] }
  metadata?: Record<string, unknown>
  delivery: "steer" | "queue"
}

export type SessionContextEvent = {
  readonly sessionID: string
  readonly agent: string
  readonly model: ModelRef
  system: SystemPart[]
  messages: unknown[]
  options: Record<string, unknown>
  tools: Record<string, { description: string; input: unknown }>
}

export type SessionCompactionEvent = SessionContextEvent & {
  result?: { summary: string }
}

export type SessionHooks = {
  prompt: SessionPromptEvent
  context: SessionContextEvent
  compaction: SessionCompactionEvent
}

export type ToolExecuteAfterEvent = {
  readonly tool: string
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly input: unknown
} & ({ readonly status: "completed"; result: unknown } | { readonly status: "error"; error: unknown })

export type ToolHooks = {
  "execute.after": ToolExecuteAfterEvent
}

export type ShellCreateBeforeEvent = {
  command: string
  cwd: string
  timeout: number
  shell: string
  env: Record<string, string | undefined>
}

export type ShellHooks = {
  "create.before": ShellCreateBeforeEvent
}

export type Hooks<Spec> = <Name extends keyof Spec>(
  name: Name,
  callback: (event: Spec[Name]) => Promise<void> | void,
) => Promise<Registration>

export type ToolExecuteContext = {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
}

export type ToolDefinition = {
  readonly name: string
  readonly description: string
  /** JSON Schema or a Standard Schema (zod 4 objects qualify). */
  readonly input: unknown
  readonly options?: { codemode?: boolean; namespace?: string; permission?: string }
  readonly execute: (input: unknown, context: ToolExecuteContext) => Promise<{ content?: string; output?: unknown }>
}

export type ToolEditor = {
  add(tool: ToolDefinition): void
  remove(id: string): void
}

/** Envelope delivered by `ctx.event.subscribe()`. */
export type V2Event = {
  readonly id: string
  readonly type: string
  readonly created: number
  readonly data: unknown
  readonly location?: { directory: string }
  readonly metadata?: Record<string, unknown>
}

export type PluginContext = {
  readonly app: { name: string; version: string; channel: string }
  readonly location: {
    directory: string
    workspaceID?: string
    project: { id: string; directory: string; canonical: string }
  }
  readonly options: Readonly<Record<string, unknown>>
  readonly event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<V2Event>
  }
  readonly session: {
    hook: Hooks<SessionHooks>
  }
  readonly shell: {
    hook: Hooks<ShellHooks>
  }
  readonly tool: {
    hook: Hooks<ToolHooks>
    transform(callback: (editor: ToolEditor) => void): Promise<Registration>
  }
}

export type Cleanup = () => Promise<void> | void

export type PluginDefinition = {
  readonly id: string
  readonly setup: (context: PluginContext) => Promise<Cleanup | void> | Cleanup | void
}

// ---- TUI (CLI plugin) context: the subset used by src/tui.ts ----

export type TuiDialogSelectOption<Value> = {
  title: string
  value: Value
  description?: string
}

export type TuiKeymapCommand = {
  id?: string
  title?: string
  description?: string
  group?: string
  palette?: true
  slash?: { name: string; aliases?: string[]; arguments?: true }
  run: (input?: string) => void | false | Promise<void>
}

export type TuiContext = {
  readonly app: { version: string; channel: string }
  readonly location: { directory: string; workspaceID?: string } | undefined
  readonly options: Readonly<Record<string, unknown>>
  readonly client: unknown
  readonly ui: {
    readonly dialog: {
      alert(options: { title: string; message: string }): Promise<void>
      confirm(options: {
        title: string
        message: string
        label?: { confirm?: string; cancel?: string }
      }): Promise<boolean | undefined>
      prompt(options: { title: string; description?: string; placeholder?: string; value?: string }): Promise<string | undefined>
      select<Value>(options: {
        title: string
        placeholder?: string
        options: readonly TuiDialogSelectOption<Value>[]
        current?: Value
      }): Promise<Value | undefined>
      clear(): void
    }
    readonly toast: { show(options: { title?: string; message: string; variant?: "info" | "success" | "warning" | "error" }): void }
    readonly router: { current(): { type: string; sessionID?: string } }
    /** Claims a place in the host slot tree; `render` runs as a Solid component. */
    readonly slot: (claim: { append: "app"; render: () => unknown }) => () => void
  }
  readonly keymap: {
    layer(input: () => { mode?: string; priority?: number; commands?: readonly TuiKeymapCommand[] }): void
  }
}

export type TuiPluginDefinition = {
  readonly id: string
  readonly setup: (context: TuiContext) => Promise<Cleanup | void> | Cleanup | void
}
