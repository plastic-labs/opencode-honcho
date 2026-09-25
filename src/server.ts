import { createHonchoRuntimePlugin } from "./index.js"

export const server = createHonchoRuntimePlugin({
  configPath: process.env.OPENCODE_HONCHO_CONFIG_PATH,
})

const plugin = {
  id: "@honcho-ai/opencode-honcho",
  server,
}

export default plugin
