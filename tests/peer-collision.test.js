import { expect, test } from "bun:test"

import { __testing } from "../dist/index.js"

test("distinct user and agent peers are accepted", () => {
  expect(() => __testing.assertDistinctUserAndAgentPeers("rui", "opencode")).not.toThrow()
})

test("colliding user and agent peers are rejected", () => {
  expect(() => __testing.assertDistinctUserAndAgentPeers("opencode", "opencode")).toThrow(
    /peerName and aiPeer both resolve to the peer id 'opencode'/,
  )
})
