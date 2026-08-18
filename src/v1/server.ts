import { createHonchoRuntimePlugin } from "./index.js"

export const server = createHonchoRuntimePlugin()

const plugin = {
  id: "@honcho-ai/opencode-honcho",
  server,
}

export default plugin
