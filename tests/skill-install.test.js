import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdtemp, stat, utimes } from "node:fs/promises"

import { __testing } from "../dist/index.js"

const { ensureHonchoSkillInstalled } = __testing

test("ensureHonchoSkillInstalled honors OPENCODE_CONFIG_DIR and skips identical writes", async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "honcho-opencode-config-"))
  const previous = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = configDir
  try {
    const installedPath = await ensureHonchoSkillInstalled()
    expect(installedPath).toBe(path.join(configDir, "skills", "honcho-memory", "SKILL.md"))

    const old = new Date("2000-01-01T00:00:00.000Z")
    await utimes(installedPath, old, old)
    await ensureHonchoSkillInstalled()
    expect((await stat(installedPath)).mtime.getTime()).toBe(old.getTime())
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previous
  }
})
