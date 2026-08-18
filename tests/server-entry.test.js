import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import serverModule from "../dist/server.js"
import { __testing } from "../dist/v1/index.js"

test("package.json exposes an explicit OpenCode server entry", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"))

  expect(pkg.name).toBe("@honcho-ai/opencode-honcho")
  expect(pkg.exports["./server"].import).toBe("./dist/server.js")
})

test("server entry default export matches OpenCode plugin expectations", () => {
  expect(serverModule.id).toBe("@honcho-ai/opencode-honcho")
  expect(typeof serverModule.server).toBe("function")
})

test("Honcho SDK import path uses @honcho-ai/sdk package", () => {
  expect(__testing.honchoSdkImportPath).toBe("@honcho-ai/sdk")
})
