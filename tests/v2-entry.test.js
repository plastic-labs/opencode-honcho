import { expect, test } from "bun:test"

import v2Module from "../dist/index.js"

test("v2 entry default export is a Plugin.define result", () => {
  expect(v2Module.id).toBe("@honcho-ai/opencode-honcho")
  expect(typeof v2Module.setup).toBe("function")
})

test("v2 entry does not expose v1 createHonchoRuntimePlugin", () => {
  expect(v2Module.createHonchoRuntimePlugin).toBeUndefined()
  expect(v2Module.__testing).toBeUndefined()
})
