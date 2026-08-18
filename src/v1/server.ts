import type { PluginModule } from "@opencode-ai/plugin/v1"
import { HonchoRuntimePlugin } from "./index.js"

export const server = HonchoRuntimePlugin

const plugin: PluginModule & { id: string } = {
  id: "@honcho-ai/opencode-honcho",
  server,
}

export default plugin
