import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { createHonchoRuntimePlugin } from "../dist/v1/index.js"
import { Honcho } from "@honcho-ai/sdk"

const HONCHO_URL = process.env.HONCHO_URL
const HONCHO_API_KEY = process.env.HONCHO_API_KEY
const HONCHO_WORKSPACE_ID = process.env.HONCHO_WORKSPACE_ID

const describeIfEnv = HONCHO_URL && HONCHO_API_KEY ? describe : describe.skip

describeIfEnv("live Honcho integration", () => {
  let tempHome
  let projectDir
  let originalHome
  let originalUserProfile
  let tools
  let createdMemory

  beforeAll(async () => {
    tempHome = mkdtempSync(join(tmpdir(), "honcho-integration-home-"))
    projectDir = mkdtempSync(join(tmpdir(), "honcho-integration-project-"))
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome

    const pluginInput = {
      client: {
        app: {
          log: async ({ body }) => {
            const msg = body?.extra
              ? `${body.message} ${JSON.stringify(body.extra)}`
              : body?.message
            if (body?.level === "error") console.error(msg)
            else if (body?.level === "warn") console.warn(msg)
            else console.log(msg)
          },
        },
      },
      project: { id: "opencode", worktree: projectDir },
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL("http://127.0.0.1:4096"),
      $: {},
      experimental_workspace: { register: () => {} },
    }

    const plugin = createHonchoRuntimePlugin()
    const hooks = await plugin(pluginInput)
    tools = hooks.tool
  })

  afterAll(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    try {
      rmSync(tempHome, { recursive: true, force: true })
    } catch {}
    try {
      rmSync(projectDir, { recursive: true, force: true })
    } catch {}
  })

  const toolContext = () => ({
    sessionID: "test-session",
    directory: projectDir,
    worktree: projectDir,
    agent: "opencode",
    abort: new AbortController(),
    metadata: () => {},
    ask: async () => {},
  })

  test("honcho_setup reports configured with env credentials", async () => {
    const result = await tools.honcho_setup.execute({ persistGlobal: false }, toolContext())
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
    expect(parsed.status.workspace).toBe(HONCHO_WORKSPACE_ID || "opencode")
  })

  test("honcho_create_conclusion writes a memory", async () => {
    createdMemory = "Integration test memory: opencode-honcho round-trip at " + Date.now()
    const result = await tools.honcho_create_conclusion.execute({ content: createdMemory }, toolContext())
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
    expect(parsed.workspace).toBe(HONCHO_WORKSPACE_ID || "opencode")
  })

  test("retrieves the memory via the Honcho SDK", async () => {
    const statusResult = await tools.honcho_status.execute({}, toolContext())
    const status = JSON.parse(statusResult)
    const userPeerId = status.peers?.userPeer?.id
    const agentPeerId = status.peers?.rootAgentPeer?.id
    expect(typeof userPeerId).toBe("string")
    expect(typeof agentPeerId).toBe("string")

    const honcho = new Honcho({
      baseURL: HONCHO_URL,
      apiKey: HONCHO_API_KEY,
      workspaceId: HONCHO_WORKSPACE_ID || "opencode",
    })
    const session = await honcho.session("test-session")
    const agentPeer = await honcho.peer(agentPeerId)
    const userPeer = await honcho.peer(userPeerId)
    const conclusions = await agentPeer.conclusionsOf(userPeer).list()
    const found = conclusions.items.some((c) => c.content.includes(createdMemory))
    expect(found).toBe(true)
  })
})
