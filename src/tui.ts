import v1Plugin, { __testing as v1Testing } from "./v1/tui.js"

const PACKAGE_ID = "@honcho-ai/opencode-honcho"

// OpenCode v2 TUI surface. The interactive setup/status/settings/config flows
// are exposed through the v2 server plugin as slash commands and tools.
// A native v2 TUI port of the dialog flows can be added here later.
const setup = async (_ctx: unknown) => {
  void _ctx
}

// The v2 TUI loader schema-checks the default export and only accepts { id, setup }.
// We keep the v1 `tui` function and test helpers reachable via property access while
// hiding them from all introspection (ownKeys, descriptors, `in`) so the v2 schema
// sees a clean TUI plugin shape.
const v2Definition = { id: PACKAGE_ID, setup }
const v1Tui = (v1Plugin as any).tui
const hidden = {
  tui: v1Tui,
  __testing: v1Testing,
}

const defaultExport = new Proxy(v2Definition, {
  get(target, prop, receiver) {
    if (prop === "tui" || prop === "__testing") {
      return (hidden as any)[prop]
    }
    return Reflect.get(target, prop, receiver)
  },
  has(target, prop) {
    if (prop === "tui" || prop === "__testing") {
      return false
    }
    return Reflect.has(target, prop)
  },
  ownKeys(target) {
    return Reflect.ownKeys(target)
  },
  getOwnPropertyDescriptor(target, prop) {
    if (prop === "tui" || prop === "__testing") {
      return undefined
    }
    return Reflect.getOwnPropertyDescriptor(target, prop)
  },
})

export const tui = v1Tui
export const id = PACKAGE_ID
export const __testing = v1Testing

export default defaultExport
