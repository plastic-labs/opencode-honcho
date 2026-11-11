import test from "node:test"
import assert from "node:assert/strict"

import tuiModule, { __testing } from "../dist/tui.js"

test("native TUI Honcho commands register slash aliases including login and import", () => {
  const commands = __testing.buildCommands({})
  assert.deepEqual(
    commands.map((command) => command.slash?.name),
    ["honcho:setup", "honcho:login", "honcho:status", "honcho:settings", "honcho:config", "honcho:import"],
  )
  assert.equal(tuiModule.id, "@honcho-ai/opencode-honcho")
})

test("tui honors OPENCODE_HONCHO_CONFIG_PATH", () => {
  const previous = process.env.OPENCODE_HONCHO_CONFIG_PATH
  process.env.OPENCODE_HONCHO_CONFIG_PATH = "/tmp/honcho-override/custom.json"
  try {
    assert.equal(__testing.sharedConfigPath(), "/tmp/honcho-override/custom.json")
    assert.match(__testing.settingsMessage(__testing.sharedConfigPath()), /hosts\.opencode in \/tmp\/honcho-override\/custom\.json/)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_HONCHO_CONFIG_PATH
    else process.env.OPENCODE_HONCHO_CONFIG_PATH = previous
  }
})

test("upgrading a 0.2.1 config keeps the peer, workspace and key it was using", async () => {
  const { mkdtemp, readFile, writeFile } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const path = await import("node:path")
  const { __testing: core } = await import("../dist/index.js")
  const dir = await mkdtemp(path.join(tmpdir(), "honcho-migrate-"))
  const configPath = path.join(dir, "config.json")
  // 0.2.1 sent `user-<peerName>` and read workspace only from its own block, never the top level.
  const before = { apiKey: "k", peerName: "Sam", workspace: "other", hosts: { opencode: { workspace: "W", sessionStrategy: "per-directory" } } }
  await writeFile(configPath, JSON.stringify(before))

  assert.ok((await core.migrateConfig(configPath)).length)
  const after = JSON.parse(await readFile(configPath, "utf-8"))
  assert.equal(after.hosts.opencode.peerName, "user-sam")
  assert.equal(after.hosts.opencode.workspace, "w")
  assert.equal(after.hosts.opencode.apiKey, "k")
  assert.equal(after.hosts.opencode.sessionStrategy, undefined)
  assert.equal(after.peerName, "Sam") // top level untouched
  assert.deepEqual(await core.migrateConfig(configPath), []) // already migrated
})

test("sign-in falls back to the honcho-cli OAuth client while opencode-honcho is unknown", async () => {
  const sent = []
  const fetch = async (_url, init) => {
    const clientId = new URLSearchParams(init.body).get("client_id")
    sent.push(clientId)
    const body = clientId === "opencode-honcho"
      ? { error: "invalid_client" }
      : { device_code: "d", user_code: "ABCD-EFGH", verification_uri: "https://honcho.dev/device", expires_in: 600, interval: 5 }
    return new Response(JSON.stringify(body), { status: clientId === "opencode-honcho" ? 401 : 200, headers: { "content-type": "application/json" } })
  }
  const { clientId, device } = await __testing.startDeviceSignIn({ fetch })
  assert.deepEqual(sent, ["opencode-honcho", "honcho-cli"])
  assert.equal(clientId, "honcho-cli")
  assert.equal(device.userCode, "ABCD-EFGH")
})
