import { expect, test } from "bun:test"

import { __testing } from "../dist/index.js"

test("per-directory sessions use a relative path so same-basename dirs do not collide", async () => {
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
  expect(__testing.defaultSettings.sessionStrategy).toBe("per-directory")
})
