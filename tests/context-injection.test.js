import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdtemp } from "node:fs/promises"

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

const jsonResponse = (value, init = {}) =>
  new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  })

const summary = (content) => ({
  content,
  message_id: "msg-summary",
  summary_type: "short",
  created_at: new Date(0).toISOString(),
  token_count: 12,
})

const createHonchoFetch = ({ failStableHydration = false } = {}) => {
  const calls = []
  const fetch = async (url, init = {}) => {
    const target = new URL(typeof url === "string" ? url : url.toString())
    const method = init.method || "GET"
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null
    calls.push({ method, pathname: target.pathname, search: target.searchParams, body })

    if (method === "POST" && target.pathname === "/v3/workspaces") {
      return jsonResponse({ id: body.id, metadata: {}, configuration: {} })
    }

    if (method === "POST" && target.pathname === "/v3/workspaces/opencode/peers") {
      return jsonResponse({
        id: body.id,
        metadata: {},
        configuration: {},
        created_at: new Date(0).toISOString(),
      })
    }

    if (method === "POST" && target.pathname === "/v3/workspaces/opencode/sessions") {
      return jsonResponse({
        id: body.id,
        metadata: {},
        configuration: {},
        created_at: new Date(0).toISOString(),
        is_active: true,
      })
    }

    if (method === "POST" && /\/v3\/workspaces\/opencode\/sessions\/[^/]+\/peers$/.test(target.pathname)) {
      return new Response(null, { status: 204 })
    }

    if (method === "GET" && /\/v3\/workspaces\/opencode\/peers\/[^/]+\/context$/.test(target.pathname)) {
      if (failStableHydration) {
        return jsonResponse({ message: "context unavailable" }, { status: 400 })
      }
      const peerId = decodeURIComponent(target.pathname.split("/").at(-2))
      return jsonResponse({
        peer_id: peerId,
        target_id: null,
        representation: peerId.startsWith("user-")
          ? "The user prefers concise engineering analysis."
          : "The assistant is working on opencode-honcho.",
        peer_card: ["Keep changes narrowly scoped."],
      })
    }

    if (method === "GET" && /\/v3\/workspaces\/opencode\/sessions\/[^/]+\/summaries$/.test(target.pathname)) {
      if (failStableHydration) {
        return jsonResponse({ message: "summaries unavailable" }, { status: 400 })
      }
      return jsonResponse({
        id: decodeURIComponent(target.pathname.split("/").at(-2)),
        short_summary: summary("Recent work focused on Honcho memory injection."),
        long_summary: null,
      })
    }

    if (method === "POST" && /\/v3\/workspaces\/opencode\/peers\/[^/]+\/chat$/.test(target.pathname)) {
      if (failStableHydration) {
        return jsonResponse({ message: "chat unavailable" }, { status: 400 })
      }
      return jsonResponse({ content: "Durable project memory is available." })
    }

    if (method === "GET" && /\/v3\/workspaces\/opencode\/sessions\/[^/]+\/context$/.test(target.pathname)) {
      return jsonResponse({
        messages: [],
        summary: summary("Prompt-specific session summary."),
        peer_representation: `Prompt memory for ${target.searchParams.get("search_query")}`,
        peer_card: null,
      })
    }

    throw new Error(`Unexpected Honcho request in test: ${method} ${target.pathname}`)
  }
  fetch.calls = calls
  return fetch
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

const runWithHarness = async (action, fetchOptions) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "honcho-context-root-"))
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "honcho-context-home-"))
  const fetch = createHonchoFetch(fetchOptions)
  return withMockFetch(fetch, () =>
    withEnv({
      HOME: homeDir,
      USER: "test-user",
      XDG_CONFIG_HOME: undefined,
      HONCHO_API_KEY: "test-key",
      HONCHO_URL: undefined,
      HONCHO_BASE_URL: undefined,
    }, async () => {
      const hooks = await createPluginHarness(rootDir)
      return action({ hooks, fetch })
    }),
  )
}

const systemInput = (extra = {}) => ({
  sessionID: "ses-test",
  model: { providerID: "test-provider", modelID: "test-model" },
  ...extra,
})

test("system transform injects Honcho memory when OpenCode provides no prompt text", async () => {
  await runWithHarness(async ({ hooks }) => {
    const output = { system: [] }

    await hooks["experimental.chat.system.transform"](systemInput(), output)

    expect(output.system).toHaveLength(1)
    expect(output.system[0]).toContain("## Honcho Memory")
    expect(output.system[0]).toContain("The user prefers concise engineering analysis.")
    expect(output.system[0]).not.toContain("Prompt memory for")
  })
})

test("system transform skips repeated no-prompt injection inside the stable refresh window", async () => {
  await runWithHarness(async ({ hooks, fetch }) => {
    const firstOutput = { system: [] }
    await hooks["experimental.chat.system.transform"](systemInput(), firstOutput)
    const callCountAfterFirstInjection = fetch.calls.length

    const secondOutput = { system: [] }
    await hooks["experimental.chat.system.transform"](systemInput(), secondOutput)

    expect(firstOutput.system).toHaveLength(1)
    expect(secondOutput.system).toEqual([])
    expect(fetch.calls).toHaveLength(callCountAfterFirstInjection)
  })
})

test("system transform refreshes no-prompt injection after the stable context ttl", async () => {
  const originalNow = Date.now
  try {
    let now = 1_000_000
    Date.now = () => now

    await runWithHarness(async ({ hooks, fetch }) => {
      const firstOutput = { system: [] }
      await hooks["experimental.chat.system.transform"](systemInput(), firstOutput)
      const callCountAfterFirstInjection = fetch.calls.length

      now += 301_000

      const secondOutput = { system: [] }
      await hooks["experimental.chat.system.transform"](systemInput(), secondOutput)

      expect(firstOutput.system).toHaveLength(1)
      expect(secondOutput.system).toHaveLength(1)
      expect(fetch.calls.length).toBeGreaterThan(callCountAfterFirstInjection)
    })
  } finally {
    Date.now = originalNow
  }
})

test("system transform retries no-prompt stable hydration when all context sources fail", async () => {
  await runWithHarness(async ({ hooks, fetch }) => {
    const firstOutput = { system: [] }
    await hooks["experimental.chat.system.transform"](systemInput(), firstOutput)
    const callCountAfterFirstAttempt = fetch.calls.length

    const secondOutput = { system: [] }
    await hooks["experimental.chat.system.transform"](systemInput(), secondOutput)

    expect(firstOutput.system).toEqual([])
    expect(secondOutput.system).toEqual([])
    expect(fetch.calls.length).toBeGreaterThan(callCountAfterFirstAttempt)
  }, { failStableHydration: true })
})

test("system transform still skips explicit trivial prompt text", async () => {
  await runWithHarness(async ({ hooks, fetch }) => {
    const output = { system: [] }

    await hooks["experimental.chat.system.transform"](systemInput({ query: "ok" }), output)

    expect(output.system).toEqual([])
    expect(fetch.calls).toHaveLength(0)
  })
})

test("system transform injects prompt-specific context for non-trivial prompt text", async () => {
  await runWithHarness(async ({ hooks, fetch }) => {
    const output = { system: [] }

    await hooks["experimental.chat.system.transform"](systemInput({ query: "fix memory injection" }), output)

    expect(output.system).toHaveLength(1)
    expect(output.system[0]).toContain("The user prefers concise engineering analysis.")
    expect(output.system[0]).toContain("Prompt memory for memory-injection")
    expect(
      fetch.calls.some(
        (call) =>
          call.method === "GET" &&
          /\/sessions\/[^/]+\/context$/.test(call.pathname) &&
          call.search.get("search_query") === "memory-injection",
      ),
    ).toBe(true)
  })
})
