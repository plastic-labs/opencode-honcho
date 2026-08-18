import { expect, test } from "bun:test"

import { __testing } from "../dist/v1/index.js"

test("normalizeId trims leading and trailing hyphens without regex backtracking risk", () => {
  expect(__testing.normalizeId("---Alpha Beta---")).toBe("alpha-beta")
  expect(__testing.normalizeId("-".repeat(256))).toBe("default")
})
