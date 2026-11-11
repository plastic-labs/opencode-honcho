---
name: honcho-memory
description: Persistent cross-session memory via Honcho — recall what you know about the user before working, and save durable insights after.
license: MIT
---

# Honcho memory

You have a persistent memory of this user that survives across sessions, backed by Honcho. The opencode-honcho plugin saves every user and assistant message, and loads the user's profile (their peer card) once at the start of each session. Nothing else is injected, so anything beyond the profile is recalled on demand with the tools below.

## When to pull memory

Before non-trivial work, query memory instead of guessing:

- The task touches the user's preferences, conventions, or past decisions
- You're about to make an assumption you could instead verify ("which package manager?", "how is auth done here?")
- The user references something from "before" or "last time", or asks to resume earlier work

Use the Honcho tools:

- `honcho_chat`: ask a natural-language question about the user ("what's their testing style?"). Pass `scope` (the repository or machine name) to answer only from sessions in that scope, or `workspace: true` to ask about everyone in the workspace. `reasoning_level` defaults to `medium`.
- `honcho_search`: look up saved messages in this session, or across the workspace with `workspace: true`.

## When to save memory

After you learn something durable, persist it with `honcho_create_conclusion`:

- A decision with rationale ("chose SQLite over Postgres — embedded, zero-setup")
- A stable preference ("prefers small, focused PRs")
- A non-obvious gotcha or root cause worth remembering
- A convention specific to this codebase

Keep each conclusion to one concise statement with the *why*.

## When not to bother

Skip memory for throwaway or purely mechanical tasks — running a build, answering a general knowledge question, trivial edits. Don't narrate that you checked memory; just use it.
