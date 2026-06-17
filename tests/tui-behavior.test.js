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
    baseUrl: "https://api.honcho.dev",
  })

  assert.match(message, /Configured: no/)
  assert.match(message, /Peer name: user/)
  assert.match(message, /Run \/honcho:setup to finish configuration\./)
})

test("status message reads the root baseUrl", () => {
  const message = __testing.statusMessage({
    apiKey: "key",
    baseUrl: "http://127.0.0.1:8000",
  })

  assert.match(message, /Configured: yes/)
  assert.match(message, /Deployment: Local \/ self-hosted/)
  assert.match(message, /Base URL: http:\/\/127.0.0.1:8000/)
})

test("status message includes peer name and live workspace/OpenCode session values when available", () => {
  const message = __testing.statusMessage(
    {
      apiKey: "key",
      peerName: "user",
      baseUrl: "https://api.honcho.dev",
    },
    {
      workspaceName: "opencode",
      openCodeSessionId: "ses_test",
    },
  )

  assert.match(message, /Peer name: user/)
  assert.match(message, /Workspace: opencode/)
  assert.match(message, /OpenCode session: ses_test/)
})

test("settings message shows config values separately from status messaging", () => {
  const message = __testing.settingsMessage({
    apiKey: "key",
    peerName: "user",
    baseUrl: "https://api.honcho.dev",
    hosts: {
      opencode: {
        workspace: "opencode",
        aiPeer: "opencode",
        recallMode: "hybrid",
        sessionStrategy: "per-directory",
      },
    },
  })

  assert.match(message, /Config path:/)
  assert.match(message, /Peer name: user/)
  assert.doesNotMatch(message, /Observation mode:/)
})

test("status and settings messages are distinct surfaces", () => {
  const settings = {
    apiKey: "key",
    peerName: "user",
    baseUrl: "https://api.honcho.dev",
    hosts: {
      opencode: {
        workspace: "opencode",
        aiPeer: "opencode",
        recallMode: "hybrid",
        sessionStrategy: "per-directory",
      },
    },
  }

  assert.notEqual(__testing.statusMessage(settings), __testing.settingsMessage(settings))
})

test("native TUI Honcho commands register slash aliases for setup, status, settings, and config", () => {
  const commands = __testing.buildCommands({})
  assert.deepEqual(commands.map((command) => command.value), [
    "honcho.setup",
    "honcho.status",
    "honcho.settings",
    "honcho.config",
  ])
  assert.deepEqual(
    commands.map((command) => command.slash?.name),
    ["honcho:setup", "honcho:status", "honcho:settings", "honcho:config"],
  )
})

test("honcho config only exposes top-level and hosts.opencode fields", () => {
  assert.deepEqual(__testing.modeEditableFieldPaths(), [
    "apiKey",
    "baseUrl",
    "peerName",
    "hosts.opencode.workspace",
    "hosts.opencode.aiPeer",
    "hosts.opencode.recallMode",
    "hosts.opencode.sessionStrategy",
  ])
  assert.equal(__testing.modeEditableFieldPaths().includes("hosts.claude_code.workspace"), false)
  assert.equal(__testing.modeEditableFieldPaths().includes("hosts.other.aiPeer"), false)
})

test("shared config field resolution is case-insensitive and preserves canonical paths", () => {
  const field = __testing.resolveSharedConfigField(
    {
      recallMode: "hybrid",
      nested: {
        SaveMessages: true,
      },
    },
    "NeStEd.sAvEmEsSaGeS",
  )

  assert.equal(field, "nested.SaveMessages")
})

test("shared config preset options expose enum and boolean values", () => {
  assert.deepEqual(__testing.sharedConfigPresetOptions("recallMode", "hybrid"), [
    "hybrid",
    "context",
    "tools",
  ])
  assert.deepEqual(__testing.sharedConfigPresetOptions("observationMode", "directional"), ["directional"])
  assert.deepEqual(__testing.sharedConfigPresetOptions("saveMessages", true), ["true", "false"])
})

test("readSharedConfig rejects non-object top-level JSON", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "honcho-invalid-shared-config-"))
  const sharedConfigDir = path.join(homeDir, ".honcho")
  const configPath = path.join(sharedConfigDir, "config.json")
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE

  await mkdir(sharedConfigDir, { recursive: true })
  await writeFile(configPath, JSON.stringify(["not-an-object"], null, 2))
  process.env.HOME = homeDir
  process.env.USERPROFILE = homeDir

  try {
    await assert.rejects(
      __testing.readSharedConfig(),
      /must contain a JSON object at the top level/i,
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
  }
})

test("tui saveSettings persists only the final supported root and host fields", async () => {
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
    assert.equal(persisted.baseUrl, "https://api.honcho.dev")
    assert.equal(persisted.peerName, "user")
    assert.equal("enabled" in persisted, false)
    assert.equal("workspace" in persisted, false)
    assert.equal("aiPeer" in persisted, false)
    assert.equal("globalOverride" in persisted, false)
    assert.equal("peerModel" in persisted, false)
    assert.equal("writeFrequency" in persisted, false)
    assert.equal(persisted.hosts.opencode.workspace, "opencode")
    assert.equal(persisted.hosts.opencode.aiPeer, "opencode")
    assert.equal(persisted.hosts.opencode.recallMode, "hybrid")
    assert.equal("observationMode" in persisted.hosts.opencode, false)
    assert.equal(persisted.hosts.opencode.sessionStrategy, "per-directory")
    assert.equal("baseUrl" in persisted.hosts.opencode, false)
    assert.equal("enabled" in persisted.hosts.opencode, false)
    assert.equal("peerModel" in persisted.hosts.opencode, false)
    assert.equal("writeFrequency" in persisted.hosts.opencode, false)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
  }
})
