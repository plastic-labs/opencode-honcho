import { expect, test } from "bun:test"

import { __testing } from "../dist/index.js"

test("normalizeId trims leading and trailing hyphens", () => {
  expect(__testing.normalizeId("---Alpha Beta---")).toBe("alpha-beta")
  expect(__testing.normalizeId("-".repeat(256))).toBe("default")
})
