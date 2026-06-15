import { expect, test } from "bun:test"

import { __testing } from "../dist/index.js"

test("removeUserPrefix=false (the default) keeps the legacy user- prefix", () => {
  expect(__testing.deriveUserPeerId({ peerName: "rui", removeUserPrefix: false })).toBe("user-rui")
  expect(__testing.deriveUserPeerId({ peerName: "rui" })).toBe("user-rui")
})

test("removeUserPrefix=true drops the prefix", () => {
  expect(__testing.deriveUserPeerId({ peerName: "rui", removeUserPrefix: true })).toBe("rui")
})
