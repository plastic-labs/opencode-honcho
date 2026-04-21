import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"

import tuiModule, { __testing } from "../dist/tui.js"

test("tui exports testing helpers for cloud api key validation", () => {
  assert.equal(tuiModule.id, "@honcho-ai/opencode-honcho")
  assert.match(__testing.validateCloudApiKey(""), /requires a Honcho API key/i)
  assert.equal(__testing.validateCloudApiKey("hch-test-key"), null)
})

test("status message still reports cloud mode without a key as not configured", () => {
  const message = __testing.statusMessage({
    apiKey: "",
    hosts: {
      opencode: {
        baseUrl: "https://api.honcho.dev",
      },
    },
  })

  assert.match(message, /Configured: no/)
  assert.match(message, /Run \/honcho:setup to finish configuration\./)
})

test("tui saveSettings does not persist deprecated runtime tuning fields", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "honcho-tui-clean-fields-"))
  const sharedConfigDir = path.join(homeDir, ".honcho")
  const sharedConfigPath = path.join(sharedConfigDir, "config.json")
  const previousHome = process.env.HOME

  await mkdir(sharedConfigDir, { recursive: true })
  await writeFile(sharedConfigPath, JSON.stringify({}, null, 2))
  process.env.HOME = homeDir

  try {
    await __testing.saveSettings({
      apiKey: "key",
      hosts: {
        opencode: {
          baseUrl: "https://api.honcho.dev",
          dialecticReasoningLevel: "high",
          messageMaxChars: 123,
          saveMessages: false,
        },
      },
    })

    const persisted = JSON.parse(await readFile(sharedConfigPath, "utf-8"))
    assert.equal("dialecticReasoningLevel" in persisted.hosts.opencode, false)
    assert.equal("messageMaxChars" in persisted.hosts.opencode, false)
    assert.equal("saveMessages" in persisted.hosts.opencode, false)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
})
