import { expect, test } from "bun:test"

import { __testing } from "../dist/index.js"

test("unified observation queries the user self-collection; directional (and unset) query the AI peer", () => {
  expect(__testing.resolveUserMemoryQuery({ observationMode: "unified" })).toEqual({
    observer: "user",
    target: null,
    observationMode: "unified",
  })
  expect(__testing.resolveUserMemoryQuery({ observationMode: "directional" })).toEqual({
    observer: "agent",
    target: "user",
    observationMode: "directional",
  })
  expect(__testing.resolveUserMemoryQuery({})).toEqual({
    observer: "agent",
    target: "user",
    observationMode: "directional",
  })
})
