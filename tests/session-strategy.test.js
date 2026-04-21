import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

import { __testing } from "../dist/index.js"

test("default session strategy matches Claude Code's per-directory behavior", () => {
  expect(__testing.defaultSettings.sessionStrategy).toBe("per-directory")
})

test("chat-instance session strategy keys sessions by session id", async () => {
  const sessionScope = await __testing.deriveSessionScope({
    workspaceId: "shared",
    sessionStrategy: "chat-instance",
    rootDir: "/tmp/project",
    repoName: "project",
    currentDirectory: "/tmp/project",
    sessionId: "session-123",
  })

  expect(sessionScope).toBe("shared:session-123")
})

test("per-directory session strategy uses a relative path, not only the basename", async () => {
  const sessionScope = await __testing.deriveSessionScope({
    workspaceId: "opencode",
    sessionStrategy: "per-directory",
    rootDir: "/tmp/project",
    repoName: "project",
    currentDirectory: "/tmp/project/services/api",
    sessionId: "session-123",
  })

  expect(sessionScope).toBe("opencode:services-api")
})

test("different directories with the same basename do not collide under per-directory", async () => {
  const sessionA = await __testing.deriveSessionScope({
    workspaceId: "opencode",
    sessionStrategy: "per-directory",
    rootDir: "/tmp/project",
    repoName: "project",
    currentDirectory: "/tmp/project/services/api",
    sessionId: "session-a",
  })
  const sessionB = await __testing.deriveSessionScope({
    workspaceId: "opencode",
    sessionStrategy: "per-directory",
    rootDir: "/tmp/project",
    repoName: "project",
    currentDirectory: "/tmp/project/packages/api",
    sessionId: "session-b",
  })

  expect(sessionA).toBe("opencode:services-api")
  expect(sessionB).toBe("opencode:packages-api")
  expect(sessionA).not.toBe(sessionB)
})

test("git-branch session strategy uses the current branch name when available", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "opencode-git-branch-"))
  await mkdir(path.join(rootDir, ".git"), { recursive: true })
  await writeFile(path.join(rootDir, ".git", "HEAD"), "ref: refs/heads/feature/test-branch\n", "utf-8")

  const sessionScope = await __testing.deriveSessionScope({
    workspaceId: "shared",
    sessionStrategy: "git-branch",
    rootDir,
    repoName: "project",
    currentDirectory: rootDir,
    sessionId: "session-123",
  })

  expect(sessionScope).toBe("shared:feature-test-branch")
})

test("git-branch session strategy falls back to the repo name when HEAD is detached", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "opencode-git-detached-"))
  await mkdir(path.join(rootDir, ".git"), { recursive: true })
  await writeFile(path.join(rootDir, ".git", "HEAD"), "1f2e3d4c5b6a\n", "utf-8")

  const sessionScope = await __testing.deriveSessionScope({
    workspaceId: "shared",
    sessionStrategy: "git-branch",
    rootDir,
    repoName: "project",
    currentDirectory: rootDir,
    sessionId: "session-123",
  })

  expect(sessionScope).toBe("shared:project")
})
