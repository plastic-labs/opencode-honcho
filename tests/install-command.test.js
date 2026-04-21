import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdtemp, readFile } from "node:fs/promises"

const bunExecutable = Bun.which("bun")

if (!bunExecutable) {
  throw new Error("tests/install-command.test.js requires a Bun executable on PATH")
}

const runCli = async (args, env) => {
  const child = Bun.spawn([bunExecutable, "dist/cli.js", ...args], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })

  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  return { code, stdout, stderr }
}

test("source CLI uses the Bun shebang", async () => {
  const source = await readFile(path.join(process.cwd(), "src/cli.ts"), "utf-8")

  expect(source.startsWith("#!/usr/bin/env bun\n")).toBe(true)
})

test("built CLI uses the Bun shebang", async () => {
  const built = await readFile(path.join(process.cwd(), "dist/cli.js"), "utf-8")

  expect(built.startsWith("#!/usr/bin/env bun\n")).toBe(true)
})

test("install command explains how to recover when opencode is not on PATH", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "opencode-cli-home-"))
  const configDir = await mkdtemp(path.join(os.tmpdir(), "opencode-cli-config-"))

  const result = await runCli(["install", "--config-dir", configDir], {
    ...process.env,
    HOME: homeDir,
    PATH: "/usr/bin:/bin",
  })

  expect(result.code).toBe(1)
  expect(result.stderr).toMatch(/opencode CLI was not found on PATH|restart your shell|source .*rc/i)
})

test("help output shows Bun-first install example", async () => {
  const result = await runCli(["--help"], process.env)

  expect(result.code).toBe(0)
  expect(result.stdout).toMatch(/Usage:/)
  expect(result.stdout).toMatch(/opencode-honcho install/)
  expect(result.stdout).toMatch(/bunx @honcho-ai\/opencode-honcho install/)
  expect(result.stderr).toBe("")
})
