import { expect, test } from "bun:test"

import { __testing } from "../dist/index.js"

test("user peer id is the bare peerName with no prefix", () => {
  expect(__testing.deriveUserPeerId({ peerName: "rui" })).toBe("rui")
})

test("user peer id falls back to the current user name when peerName is empty", () => {
  expect(__testing.deriveUserPeerId({ peerName: "" })).toBe("user")
})

test("user peer id is normalised", () => {
  expect(__testing.deriveUserPeerId({ peerName: "Rui Rei" })).toBe("rui-rei")
})
