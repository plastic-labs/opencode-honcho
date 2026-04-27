import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"

import { createHonchoRuntimePlugin } from "../dist/index.js"

const withEnv = async (entries, action) => {
  const previous = new Map()
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key])
    if (value === undefined) {
      delete process.env[key]
      continue
    }
    process.env[key] = value
  }

  try {
    return await action()
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key]
        continue
      }
      process.env[key] = value
    }
  }
}

const withMockFetch = async (implementation, action) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = implementation
  try {
    return await action()
  } finally {
    globalThis.fetch = originalFetch
  }
}

const successfulValidationFetch = async (url) => {
  const target = typeof url === "string" ? url : url.toString()
  if (target.endsWith("/v3/workspaces")) {
    return new Response(JSON.stringify({ id: "opencode", metadata: {}, configuration: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  if (target.includes("/v3/workspaces/opencode/sessions")) {
    return new Response(
      JSON.stringify({
        id: "setup-check-opencode",
        metadata: {},
        configuration: {},
        created_at: new Date().toISOString(),
        is_active: true,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )
  }

  throw new Error(`Unexpected validation request in test: ${target}`)
}

const createPluginHarness = async (rootDir) => {
  const plugin = createHonchoRuntimePlugin()
  return plugin({
    client: {
      app: {
        log: async () => undefined,
      },
    },
    project: {
      id: "opencode",
      worktree: rootDir,
    },
    directory: rootDir,
    worktree: rootDir,
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: {},
  })
}

const toolContext = (rootDir) => ({
  sessionID: "ses_test",
  messageID: "msg_test",
  agent: "build",
  directory: rootDir,
  worktree: rootDir,
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
})

test("honcho_setup writes shared Honcho config with root peerName and hosts.opencode defaults", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "honcho-setup-cloud-"))
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "honcho-home-"))
  const sharedConfigDir = path.join(homeDir, ".honcho")
  const sharedConfigPath = path.join(sharedConfigDir, "config.json")

  await withMockFetch(successfulValidationFetch, async () => {
    await withEnv({ HOME: homeDir, USER: "ignored-user", XDG_CONFIG_HOME: undefined }, async () => {
      const hooks = await createPluginHarness(rootDir)
      const honchoSetup = hooks.tool.honcho_setup
      const result = JSON.parse(await honchoSetup.execute({ apiKey: "new-key", peerName: "custom-peer" }, toolContext(rootDir)))
      const persisted = JSON.parse(await readFile(sharedConfigPath, "utf-8"))

      expect(result.ok).toBe(true)
      expect(result.globalConfigPath).toBe(sharedConfigPath)
      expect(result.status.baseUrl).toBe("https://api.honcho.dev")
      expect(result.status.peerName).toBe("custom-peer")
      expect(persisted.peerName).toBe("custom-peer")
      expect(persisted.apiKey).toBe("new-key")
      expect(persisted.honchoApiKey).toBeUndefined()
      expect(persisted.baseUrl).toBe("https://api.honcho.dev")
      expect(persisted.workspace).toBeUndefined()
      expect(persisted.aiPeer).toBeUndefined()
      expect(persisted.globalOverride).toBeUndefined()
      expect(persisted.peerModel).toBeUndefined()
      expect(persisted.writeFrequency).toBeUndefined()
      expect(persisted.sessionStrategy).toBeUndefined()
      expect(persisted.recallMode).toBeUndefined()
      expect(persisted.observation).toBeUndefined()
      expect(persisted.hosts.opencode).toEqual({
        aiPeer: "opencode",
        workspace: "opencode",
        recallMode: "hybrid",
        sessionStrategy: "per-directory",
      })
      expect("linkedHosts" in persisted.hosts.opencode).toBe(false)
      expect(result.persistedFields).toContain("peerName")
      expect(result.status.peers.userPeer.observe_me).toBe(true)
      expect(result.status.peers.userPeer.observe_others).toBe(false)
      expect(result.status.peers.userPeer.observeMe).toBeUndefined()
    })
  })
})

test("honcho_status reads effective settings from shared hosts.opencode config", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "honcho-status-honcho-api-key-"))
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "honcho-home-status-"))
  const sharedConfigDir = path.join(homeDir, ".honcho")
  const sharedConfigPath = path.join(sharedConfigDir, "config.json")

  await mkdir(sharedConfigDir, { recursive: true })
  await writeFile(
    sharedConfigPath,
    JSON.stringify(
      {
        peerName: "user",
        apiKey: "status-key",
        baseUrl: "https://api.honcho.dev",
        hosts: {
          opencode: {
            aiPeer: "opencode",
            workspace: "opencode",
            observationMode: "directional",
          },
        },
      },
      null,
      2,
    ),
  )

  await withEnv({
    HOME: homeDir,
    USER: "ignored-user",
    XDG_CONFIG_HOME: undefined,
    HONCHO_API_KEY: undefined,
    HONCHO_URL: undefined,
    HONCHO_BASE_URL: undefined,
    HONCHO_WORKSPACE: undefined,
    HONCHO_WORKSPACE_ID: undefined,
    HONCHO_AI_PEER: undefined,
    HONCHO_PEER_NAME: undefined,
  }, async () => {
    const hooks = await createPluginHarness(rootDir)
    const result = JSON.parse(await hooks.tool.honcho_status.execute({}, toolContext(rootDir)))

    expect(result.ok).toBe(true)
    expect(result.configured).toBe(true)
    expect(result.baseUrl).toBe("https://api.honcho.dev")
    expect(result.configPath).toBe(sharedConfigPath)
    expect(result.projectConfigPath).toBe(sharedConfigPath)
    expect(result.globalConfigPath).toBe(sharedConfigPath)
    expect(result.workspace).toBe("opencode")
    expect(result.workspaceName).toBe("opencode")
    expect(typeof result.sessionName).toBe("string")
    expect(result.sessionName).toContain("opencode")
    expect(result.observationMode).toBeUndefined()
    expect(result.peers.userPeer.observe_me).toBe(true)
    expect(result.peers.rootAgentPeer.observe_others).toBe(true)
    expect(result.peers.rootAgentPeer.observeOthers).toBeUndefined()
  })
})

test("honcho_status applies cloud and self-hosted no-key configuration rules", async () => {
  const cases = [
    { name: "cloud", baseUrl: "https://api.honcho.dev", configured: false, localMode: false },
    { name: "localhost", baseUrl: "http://127.0.0.1:8000", configured: true, localMode: true },
    { name: "custom", baseUrl: "http://honcho.internal:8000", configured: true, localMode: false },
  ]

  for (const scenario of cases) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), `honcho-status-${scenario.name}-`))
    const homeDir = await mkdtemp(path.join(os.tmpdir(), `honcho-home-${scenario.name}-`))
    const sharedConfigDir = path.join(homeDir, ".honcho")
    const sharedConfigPath = path.join(sharedConfigDir, "config.json")

    await mkdir(sharedConfigDir, { recursive: true })
    await writeFile(
      sharedConfigPath,
      JSON.stringify(
        {
          peerName: "user",
          baseUrl: scenario.baseUrl,
          hosts: {
            opencode: {
              aiPeer: "opencode",
              workspace: "opencode",
            },
          },
        },
        null,
        2,
      ),
    )

    await withEnv({
      HOME: homeDir,
      USER: "ignored-user",
      XDG_CONFIG_HOME: undefined,
      HONCHO_API_KEY: undefined,
      HONCHO_URL: undefined,
      HONCHO_BASE_URL: undefined,
      HONCHO_WORKSPACE: undefined,
      HONCHO_WORKSPACE_ID: undefined,
      HONCHO_AI_PEER: undefined,
      HONCHO_PEER_NAME: undefined,
    }, async () => {
      const hooks = await createPluginHarness(rootDir)
      const result = JSON.parse(await hooks.tool.honcho_status.execute({}, toolContext(rootDir)))

      expect(result.configured).toBe(scenario.configured)
      expect(result.localMode).toBe(scenario.localMode)
      expect(result.baseUrl).toBe(scenario.baseUrl)
    })
  }
})

test("honcho_status ignores a local .opencode/honcho.json and only reads ~/.honcho/config.json", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "honcho-ignore-local-config-"))
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "honcho-home-ignore-local-"))
  const sharedConfigDir = path.join(homeDir, ".honcho")
  const sharedConfigPath = path.join(sharedConfigDir, "config.json")
  const localConfigDir = path.join(rootDir, ".opencode")
  const localConfigPath = path.join(localConfigDir, "honcho.json")

  await mkdir(sharedConfigDir, { recursive: true })
  await mkdir(localConfigDir, { recursive: true })
  await writeFile(
    sharedConfigPath,
    JSON.stringify(
      {
        peerName: "user",
        apiKey: "shared-key",
        baseUrl: "https://api.honcho.dev",
        hosts: {
          opencode: {
            aiPeer: "opencode",
            workspace: "opencode",
          },
        },
      },
      null,
      2,
    ),
  )
  await writeFile(
    localConfigPath,
    JSON.stringify(
      {
        baseUrl: "http://127.0.0.1:9000",
        workspace: "local-workspace",
      },
      null,
      2,
    ),
  )

  await withEnv({
    HOME: homeDir,
    USER: "ignored-user",
    XDG_CONFIG_HOME: undefined,
    HONCHO_API_KEY: undefined,
    HONCHO_URL: undefined,
    HONCHO_BASE_URL: undefined,
    HONCHO_WORKSPACE: undefined,
    HONCHO_WORKSPACE_ID: undefined,
    HONCHO_AI_PEER: undefined,
    HONCHO_PEER_NAME: undefined,
  }, async () => {
    const hooks = await createPluginHarness(rootDir)
    const result = JSON.parse(await hooks.tool.honcho_status.execute({}, toolContext(rootDir)))

    expect(result.configPath).toBe(sharedConfigPath)
    expect(result.projectConfigPath).toBe(sharedConfigPath)
    expect(result.globalConfigPath).toBe(sharedConfigPath)
    expect(result.baseUrl).toBe("https://api.honcho.dev")
    expect(result.workspace).toBe("opencode")
  })
})

test("honcho_status lets exported HONCHO_* values override ~/.honcho/config.json", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "honcho-env-overrides-file-"))
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "honcho-home-env-overrides-file-"))
  const sharedConfigDir = path.join(homeDir, ".honcho")
  const sharedConfigPath = path.join(sharedConfigDir, "config.json")

  await mkdir(sharedConfigDir, { recursive: true })
  await writeFile(
    sharedConfigPath,
    JSON.stringify(
      {
        peerName: "user",
        apiKey: "file-key",
        baseUrl: "https://api.honcho.dev",
        hosts: {
          opencode: {
            aiPeer: "opencode",
            workspace: "file-workspace",
          },
        },
      },
      null,
      2,
    ),
  )

  await withEnv(
    {
      HOME: homeDir,
      USER: "ignored-user",
      XDG_CONFIG_HOME: undefined,
      HONCHO_API_KEY: "env-key",
      HONCHO_URL: undefined,
      HONCHO_BASE_URL: "http://127.0.0.1:8000",
      HONCHO_WORKSPACE: "env-workspace",
      HONCHO_WORKSPACE_ID: undefined,
      HONCHO_AI_PEER: undefined,
      HONCHO_PEER_NAME: undefined,
    },
    async () => {
      const hooks = await createPluginHarness(rootDir)
      const result = JSON.parse(await hooks.tool.honcho_status.execute({}, toolContext(rootDir)))

      expect(result.configured).toBe(true)
      expect(result.baseUrl).toBe("http://127.0.0.1:8000")
      expect(result.localMode).toBe(true)
      expect(result.workspace).toBe("env-workspace")
    },
  )
})

test("honcho_status preserves existing shared global config without mutating the file", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "honcho-existing-global-config-"))
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "honcho-home-existing-global-"))
  const sharedConfigDir = path.join(homeDir, ".honcho")
  const sharedConfigPath = path.join(sharedConfigDir, "config.json")
  const initialConfig = {
    apiKey: "existing-key",
    peerName: "user",
    globalOverride: true,
    workspace: "legacy-workspace",
    hosts: {
      claude_code: {
        workspace: "claude_code",
        aiPeer: "claude",
      },
    },
  }

  await mkdir(sharedConfigDir, { recursive: true })
  await writeFile(
    sharedConfigPath,
    JSON.stringify(initialConfig, null, 2),
  )

  await withEnv({ HOME: homeDir, USER: "ignored-user", XDG_CONFIG_HOME: undefined }, async () => {
    const hooks = await createPluginHarness(rootDir)
    const status = JSON.parse(await hooks.tool.honcho_status.execute({}, toolContext(rootDir)))
    const persisted = JSON.parse(await readFile(sharedConfigPath, "utf-8"))

    expect(status.configPath).toBe(sharedConfigPath)
    expect(status.workspace).toBe("opencode")
    expect(persisted).toEqual(initialConfig)
    expect(persisted.hosts.claude_code).toEqual({
      workspace: "claude_code",
      aiPeer: "claude",
    })
    expect(persisted.hosts.opencode).toBeUndefined()
  })
})

test("honcho_status uses root baseUrl together with host-scoped OpenCode defaults", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "honcho-root-baseurl-host-defaults-"))
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "honcho-home-root-baseurl-host-defaults-"))
  const sharedConfigDir = path.join(homeDir, ".honcho")
  const sharedConfigPath = path.join(sharedConfigDir, "config.json")

  await mkdir(sharedConfigDir, { recursive: true })
  await writeFile(
    sharedConfigPath,
    JSON.stringify(
      {
        peerName: "user",
        apiKey: "status-key",
        baseUrl: "http://127.0.0.1:8000",
        hosts: {
          opencode: {
            workspace: "host-workspace",
            aiPeer: "host-ai",
          },
        },
      },
      null,
      2,
    ),
  )

  await withEnv({
    HOME: homeDir,
    USER: "ignored-user",
    XDG_CONFIG_HOME: undefined,
    HONCHO_API_KEY: undefined,
    HONCHO_URL: undefined,
    HONCHO_BASE_URL: undefined,
    HONCHO_WORKSPACE: undefined,
    HONCHO_WORKSPACE_ID: undefined,
    HONCHO_AI_PEER: undefined,
    HONCHO_PEER_NAME: undefined,
  }, async () => {
    const hooks = await createPluginHarness(rootDir)
    const result = JSON.parse(await hooks.tool.honcho_status.execute({}, toolContext(rootDir)))

    expect(result.workspace).toBe("host-workspace")
    expect(result.baseUrl).toBe("http://127.0.0.1:8000")
    expect(result.peers.rootAgentPeer.id).toBe("host-ai")
  })
})

test("honcho_setup returns a structured error when the shared config path cannot be written", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "honcho-setup-error-"))
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "honcho-home-error-"))
  const invalidHonchoDir = path.join(homeDir, ".honcho")

  await writeFile(invalidHonchoDir, "not a directory\n")

  await withMockFetch(successfulValidationFetch, async () => {
    await withEnv({ HOME: homeDir, USER: "ignored-user", XDG_CONFIG_HOME: undefined }, async () => {
      const hooks = await createPluginHarness(rootDir)
      const honchoSetup = hooks.tool.honcho_setup
      const result = JSON.parse(await honchoSetup.execute({ apiKey: "new-key" }, toolContext(rootDir)))

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/persist|config|directory|ENOTDIR/i)
      expect(result.globalConfigPath).toBe(path.join(invalidHonchoDir, "config.json"))
    })
  })
})

test("honcho_set_config rejects removed and deprecated config fields", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "honcho-reject-deprecated-field-"))
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "honcho-home-reject-deprecated-"))

  await withEnv({ HOME: homeDir, USER: "ignored-user", XDG_CONFIG_HOME: undefined }, async () => {
    const hooks = await createPluginHarness(rootDir)

    for (const field of [
      "dialecticReasoningLevel",
      "enabled",
      "peerModel",
      "writeFrequency",
      "globalOverride",
      "observation",
    ]) {
      const result = JSON.parse(
        await hooks.tool.honcho_set_config.execute(
          { field, value: "high" },
          toolContext(rootDir),
        ),
      )

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(new RegExp(`Unknown setting '${field}'`))
    }
  })
})

test("honcho_set_config updates requested field without deleting unrelated top-level keys", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "honcho-preserve-top-level-"))
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "honcho-home-preserve-top-level-"))
  const sharedConfigDir = path.join(homeDir, ".honcho")
  const sharedConfigPath = path.join(sharedConfigDir, "config.json")

  await mkdir(sharedConfigDir, { recursive: true })
  await writeFile(
    sharedConfigPath,
    JSON.stringify(
      {
        apiKey: "existing-key",
        peerName: "user",
        globalOverride: true,
        workspace: "legacy-workspace",
      },
      null,
      2,
    ),
  )

  await withEnv({ HOME: homeDir, USER: "ignored-user", XDG_CONFIG_HOME: undefined }, async () => {
    const hooks = await createPluginHarness(rootDir)
    const result = JSON.parse(
      await hooks.tool.honcho_set_config.execute(
        { field: "recallMode", value: "tools" },
        toolContext(rootDir),
      ),
    )
    const persisted = JSON.parse(await readFile(sharedConfigPath, "utf-8"))

    expect(result.ok).toBe(true)
    expect(persisted.globalOverride).toBe(true)
    expect(persisted.workspace).toBe("legacy-workspace")
    expect(persisted.hosts.opencode?.recallMode).toBe("tools")
  })
})

test("honcho_setup returns ok false and does not persist when cloud auth validation fails", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "honcho-setup-invalid-auth-"))
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "honcho-home-invalid-auth-"))
  const sharedConfigPath = path.join(homeDir, ".honcho", "config.json")
  await withMockFetch(
    async () =>
      new Response(JSON.stringify({ detail: "Invalid API key" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      await withEnv({ HOME: homeDir, USER: "ignored-user", XDG_CONFIG_HOME: undefined }, async () => {
        const hooks = await createPluginHarness(rootDir)
        const result = JSON.parse(await hooks.tool.honcho_setup.execute({ apiKey: "bad-key" }, toolContext(rootDir)))
        const persisted = JSON.parse(await readFile(sharedConfigPath, "utf-8"))

        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/Invalid API key/i)
        expect(persisted.apiKey).toBeUndefined()
      })
    },
  )
})

test("honcho_setup returns the explicit no-key response for default cloud setup without validating", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "honcho-setup-missing-key-"))
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "honcho-home-missing-key-"))
  let fetchCalled = false

  await withMockFetch(async () => {
    fetchCalled = true
    throw new Error("validation should not run")
  }, async () => {
    await withEnv({
      HOME: homeDir,
      USER: "ignored-user",
      XDG_CONFIG_HOME: undefined,
      HONCHO_API_KEY: undefined,
      HONCHO_URL: undefined,
      HONCHO_BASE_URL: undefined,
    }, async () => {
      const hooks = await createPluginHarness(rootDir)
      const result = JSON.parse(await hooks.tool.honcho_setup.execute({}, toolContext(rootDir)))

      expect(result.ok).toBe(false)
      expect(result.message).toMatch(/No Honcho API key is configured/i)
      expect(fetchCalled).toBe(false)
    })
  })
})

test("honcho_setup marks custom self-hosted baseUrl without apiKey as configured", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "honcho-setup-self-hosted-"))
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "honcho-home-setup-self-hosted-"))
  const sharedConfigPath = path.join(homeDir, ".honcho", "config.json")

  await withEnv({
    HOME: homeDir,
    USER: "ignored-user",
    XDG_CONFIG_HOME: undefined,
    HONCHO_API_KEY: undefined,
    HONCHO_URL: undefined,
    HONCHO_BASE_URL: undefined,
    HONCHO_WORKSPACE: undefined,
    HONCHO_WORKSPACE_ID: undefined,
    HONCHO_AI_PEER: undefined,
    HONCHO_PEER_NAME: undefined,
  }, async () => {
    const hooks = await createPluginHarness(rootDir)
    const result = JSON.parse(
      await hooks.tool.honcho_setup.execute({ baseUrl: "http://honcho.internal:8000" }, toolContext(rootDir)),
    )
    const persisted = JSON.parse(await readFile(sharedConfigPath, "utf-8"))

    expect(result.ok).toBe(true)
    expect(result.status.configured).toBe(true)
    expect(result.status.localMode).toBe(false)
    expect(result.status.baseUrl).toBe("http://honcho.internal:8000")
    expect(persisted.baseUrl).toBe("http://honcho.internal:8000")
    expect(persisted.apiKey).toBeUndefined()
  })
})

test("honcho_status defaults workspace to opencode instead of the OpenCode project id", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "honcho-status-default-workspace-"))
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "honcho-home-default-workspace-"))

  await withEnv({ HOME: homeDir, USER: "ignored-user", XDG_CONFIG_HOME: undefined }, async () => {
    const plugin = createHonchoRuntimePlugin()
    const hooks = await plugin({
      client: { app: { log: async () => undefined } },
      project: { id: "different-project-id", worktree: rootDir },
      directory: rootDir,
      worktree: rootDir,
      serverUrl: new URL("http://127.0.0.1:4096"),
      $: {},
    })

    const result = JSON.parse(await hooks.tool.honcho_status.execute({}, toolContext(rootDir)))

    expect(result.workspace).toBe("opencode")
  })
})

test("honcho_status uses the project worktree to derive per-directory session keys", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "honcho-project-worktree-root-"))
  const nestedDir = path.join(repoRoot, "services", "api")
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "honcho-home-project-worktree-"))

  await mkdir(nestedDir, { recursive: true })

  await withEnv({ HOME: homeDir, USER: "ignored-user", XDG_CONFIG_HOME: undefined }, async () => {
    const plugin = createHonchoRuntimePlugin()
    const hooks = await plugin({
      client: { app: { log: async () => undefined } },
      project: { id: "different-project-id", worktree: repoRoot },
      directory: nestedDir,
      worktree: repoRoot,
      serverUrl: new URL("http://127.0.0.1:4096"),
      $: {},
    })

    const result = JSON.parse(await hooks.tool.honcho_status.execute({}, toolContext(nestedDir)))

    expect(result.sessionKey).toBe("per-directory-opencode-services-api-opencode")
  })
})
