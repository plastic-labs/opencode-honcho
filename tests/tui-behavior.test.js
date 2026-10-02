import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"

import tuiModule, { __testing } from "../dist/tui.js"

test("native TUI Honcho commands register slash aliases including import", () => {
  const commands = __testing.buildCommands({})
  assert.deepEqual(commands.map((command) => command.value), [
    "honcho.setup",
    "honcho.status",
    "honcho.settings",
    "honcho.config",
    "honcho.import",
  ])
  assert.deepEqual(
    commands.map((command) => command.slash?.name),
    ["honcho:setup", "honcho:status", "honcho:settings", "honcho:config", "honcho:import"],
  )
  assert.equal(tuiModule.id, "@honcho-ai/opencode-honcho")
})

test("tui saveSettings persists only supported root and host fields", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "honcho-tui-clean-fields-"))
  const sharedConfigDir = path.join(homeDir, ".honcho")
  const configPath = path.join(sharedConfigDir, "config.json")
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE

  await mkdir(sharedConfigDir, { recursive: true })
  await writeFile(configPath, JSON.stringify({}, null, 2))
  process.env.HOME = homeDir
  process.env.USERPROFILE = homeDir

  try {
    await __testing.saveSettings({
      apiKey: "key",
      baseUrl: "https://api.honcho.dev",
      hosts: {
        opencode: {
          workspace: "opencode",
          aiPeer: "opencode",
          recallMode: "hybrid",
          sessionStrategy: "per-directory",
          writeFrequency: "session",
          peerModel: "hierarchical",
          baseUrl: "http://127.0.0.1:8000",
        },
      },
    })

    const persisted = JSON.parse(await readFile(configPath, "utf-8"))
    assert.equal(persisted.apiKey, "key")
    assert.equal(persisted.workspace, undefined)
    assert.equal(persisted.hosts.opencode.workspace, "opencode")
    assert.equal(persisted.hosts.opencode.writeFrequency, undefined)
    assert.equal(persisted.hosts.opencode.baseUrl, undefined)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
  }
})

test("tui honors OPENCODE_HONCHO_CONFIG_PATH override for reads, writes, and display", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "honcho-tui-override-"))
  const globalConfigPath = path.join(homeDir, ".honcho", "config.json")
  const overrideDir = path.join(homeDir, "override")
  const overrideConfigPath = path.join(overrideDir, "custom.json")
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  const previousOverride = process.env.OPENCODE_HONCHO_CONFIG_PATH

  await mkdir(overrideDir, { recursive: true })
  await writeFile(overrideConfigPath, JSON.stringify({ peerName: "override-peer" }, null, 2))
  process.env.HOME = homeDir
  process.env.USERPROFILE = homeDir
  process.env.OPENCODE_HONCHO_CONFIG_PATH = overrideConfigPath

  try {
    assert.equal(__testing.sharedConfigPath(), overrideConfigPath)

    const readBack = await __testing.readSharedConfig()
    assert.equal(readBack.peerName, "override-peer")

    await __testing.saveSettings({
      apiKey: "key",
      baseUrl: "https://api.honcho.dev",
      hosts: { opencode: { workspace: "opencode" } },
    })
    const persisted = JSON.parse(await readFile(overrideConfigPath, "utf-8"))
    assert.equal(persisted.apiKey, "key")
    assert.equal(persisted.peerName, "override-peer")
    assert.rejects(readFile(globalConfigPath, "utf-8"))

    assert.match(__testing.settingsMessage({}), new RegExp(`Config path: ${overrideConfigPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
    if (previousOverride === undefined) delete process.env.OPENCODE_HONCHO_CONFIG_PATH
    else process.env.OPENCODE_HONCHO_CONFIG_PATH = previousOverride
  }
})
