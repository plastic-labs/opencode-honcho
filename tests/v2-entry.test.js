import { expect, test } from "bun:test"

import v2Module, * as v2Namespace from "../dist/index.js"

test("v2 entry default export is a Plugin.define result", () => {
  expect(v2Module.id).toBe("@honcho-ai/opencode-honcho")
  expect(typeof v2Module.setup).toBe("function")
})

test("v2 entry namespace does not expose v1 internals", () => {
  expect(v2Namespace.createHonchoRuntimePlugin).toBeUndefined()
  expect(v2Namespace.__testing).toBeUndefined()
})
