import type { Plugin as PluginV2 } from "@opencode/plugin/tui"
import type { KeymapCommand as TuiKeymapCommand } from "@opencode/plugin/tui/context"
import { transcriptSourceFromV2Client } from "../import.js"
import { COMMANDS, runGuarded } from "./commands.js"
import type { Dialogs, TuiSession } from "./dialogs.js"

type TuiContext = PluginV2.Context

export const sessionFromV2 = (context: TuiContext): TuiSession => ({
  dialogs: context.ui.dialog as Dialogs,
  liveStatus: () => {
    const route = context.ui.router.current()
    return { openCodeSessionId: route.type === "session" && typeof route.sessionID === "string" ? route.sessionID : undefined }
  },
  transcripts: transcriptSourceFromV2Client(context.client),
})

export const buildCommandsV2 = (context: TuiContext): TuiKeymapCommand[] =>
  COMMANDS.map((command) => ({
    id: command.id,
    title: command.title,
    description: command.description,
    group: "Honcho",
    palette: true as const,
    slash: { name: command.slash },
    run: () => runGuarded(sessionFromV2(context), command),
  }))

export const setup = async (context: TuiContext) => {
  // A keymap layer is owned by the component that creates it, so it has to be created inside a
  // rendered slot rather than directly in setup (which runs outside the Solid owner tree).
  context.ui.slot({
    append: "app",
    render: () => {
      context.keymap.layer(() => ({ mode: "global", commands: buildCommandsV2(context) }))
      return undefined
    },
  })
}
