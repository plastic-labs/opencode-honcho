import { expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { __testing } from "../dist/index.js"

// OpenCode 2.x sends a slash command's expansion through the prompt hook like a typed prompt.
// The matcher reads the same command sources OpenCode does and recognises their expansions.
test("2.x slash command expansions are recognised; typed prompts and harness prompts are told apart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "honcho-commands-"))
  const global = path.join(root, "config")
  const project = path.join(root, "repo")
  await mkdir(path.join(global, "commands"), { recursive: true })
  await mkdir(path.join(project, ".opencode", "command", "team"), { recursive: true })
  await writeFile(path.join(global, "commands", "fix.md"), "---\ndescription: fix\n---\nFix the failing test in $ARGUMENTS and explain the root cause.\n")
  await writeFile(path.join(global, "commands", "recap.md"), "Summarize this session so far in one line.")
  await writeFile(path.join(project, ".opencode", "command", "team", "status.md"), "Here is the git status:\n!`git status --short`\nList what changed.")
  await writeFile(path.join(project, "opencode.jsonc"), '{\n  // project commands\n  "commands": { "ship": { "template": "Prepare a release for version $1 with notes: $2" } },\n}')
  await writeFile(path.join(global, "opencode.json"), JSON.stringify({ commands: { tiny: { template: "Do $ARGUMENTS" } } }))

  const saved = { dir: process.env.OPENCODE_CONFIG_DIR }
  process.env.OPENCODE_CONFIG_DIR = global
  try {
    const isCommand = __testing.createCommandMatcher(project)
    // Expansions, as OpenCode's evaluateTemplate produces them.
    expect(isCommand("Fix the failing test in src/a.test.ts and explain the root cause.")).toBe(true)
    expect(isCommand("Summarize this session so far in one line.")).toBe(true)
    expect(isCommand("Summarize this session so far in one line.\n\nfocus on tests")).toBe(true)
    expect(isCommand("Here is the git status:\n M src/a.ts\n?? b.ts\nList what changed.")).toBe(true)
    expect(isCommand("Prepare a release for version 1.2 with notes: faster startup")).toBe(true)
    expect(isCommand(`You are a code reviewer. Your job is to review code changes and provide actionable feedback.\n\n${"x".repeat(2000)}`)).toBe(true)
    // Typed prompts that only start the same way are the user's.
    expect(isCommand("Summarize this session so far in one line, but focus on tests")).toBe(false)
    expect(isCommand("Fix the failing test in src/a.test.ts")).toBe(false)
    expect(isCommand("You are a code reviewer. Your job is to review code changes and provide actionable feedback.")).toBe(false)
    // Too little fixed text to recognise: never matched, so "Do the dishes" is still saved.
    expect(isCommand("Do the dishes")).toBe(false)
  } finally {
    if (saved.dir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = saved.dir
  }

  expect(__testing.isGeneratedPrompt({ source: "goal", goalID: "g1" })).toBe(true)
  expect(__testing.isGeneratedPrompt({ schedule: { id: "s1" } })).toBe(true)
  expect(__testing.isGeneratedPrompt(undefined)).toBe(false)
})
