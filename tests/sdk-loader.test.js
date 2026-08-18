import { expect, test } from "bun:test"

import { __testing } from "../dist/v1/index.js"

test("Honcho SDK import path uses @honcho-ai/sdk package", () => {
  expect(__testing.honchoSdkImportPath).toBe("@honcho-ai/sdk")
})
