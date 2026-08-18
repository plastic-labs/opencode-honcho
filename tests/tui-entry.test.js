import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import tuiModule from "../dist/tui.js"

test("package.json exposes an explicit OpenCode TUI entry", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"))

  expect(pkg.name).toBe("@honcho-ai/opencode-honcho")
  expect(pkg.exports["./tui"].import).toBe("./dist/tui.js")
})

test("tui entry default export matches OpenCode plugin expectations", () => {
  expect(tuiModule.id).toBe("@honcho-ai/opencode-honcho")
  expect(typeof tuiModule.tui).toBe("function")
})

test("tui entry default export is also a valid v2 TUI plugin", () => {
  expect(typeof tuiModule.setup).toBe("function")
  expect(Object.keys(tuiModule).sort()).toEqual(["id", "setup"])
  expect("tui" in tuiModule).toBe(false)
  expect("__testing" in tuiModule).toBe(false)
  expect(Object.getOwnPropertyDescriptor(tuiModule, "tui")).toBeUndefined()
})
