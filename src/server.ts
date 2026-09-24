import { createHonchoRuntimePlugin } from "./index.js"
import { definition } from "./v2/runtime.js"

/** OpenCode 1.x server plugin (hook map). */
export const server = createHonchoRuntimePlugin()

/**
 * One default export for both OpenCode generations. Both resolve this package's `./server`
 * entry: 1.x calls `server()`, 2.x reads `id` + `setup()` and ignores the rest.
 */
const plugin = {
  ...definition,
  server,
}

export default plugin
