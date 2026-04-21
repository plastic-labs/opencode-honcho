import { expect, test } from "bun:test"

import { __testing } from "../dist/index.js"

test("root sessions keep user and root agent as peers", () => {
  const topology = __testing.buildPeerTopology({
    config: { peerModel: "classic" },
    peerModel: "classic",
    userPeerId: "user:alice",
    rootAgentPeerId: "opencode",
    activeAgentPeerId: "opencode",
    childAgentPeerId: null,
    parentAgentObserverPeerId: null,
  })

  expect(topology.sessionPeerConfigs).toEqual({
    "user:alice": { observeMe: true, observeOthers: false },
    opencode: { observeMe: true, observeOthers: true },
  })
  expect(topology.describedPeers.childAgentPeer).toBeNull()
  expect(topology.describedPeers.parentAgentObserverPeer).toBeNull()
})

test("classic peer model keeps delegated sessions on the Claude-style user and ai peers", () => {
  const topology = __testing.buildPeerTopology({
    config: { peerModel: "classic" },
    peerModel: "classic",
    userPeerId: "user:alice",
    rootAgentPeerId: "opencode",
    activeAgentPeerId: "opencode:reviewer",
    childAgentPeerId: "opencode:reviewer",
    parentAgentObserverPeerId: "opencode:root-parent",
  })

  expect(topology.sessionPeerConfigs).toEqual({
    "user:alice": { observeMe: true, observeOthers: false },
    opencode: { observeMe: true, observeOthers: true },
  })
  expect(topology.describedPeers.childAgentPeer).toBeNull()
  expect(topology.describedPeers.parentAgentObserverPeer).toBeNull()
})

test("hierarchical peer model scopes parent observation to the child peer only", () => {
  const topology = __testing.buildPeerTopology({
    config: { peerModel: "hierarchical" },
    peerModel: "hierarchical",
    userPeerId: "user:alice",
    rootAgentPeerId: "opencode",
    activeAgentPeerId: "opencode:reviewer",
    childAgentPeerId: "opencode:reviewer",
    parentAgentObserverPeerId: "opencode:root-parent",
  })

  expect(topology.sessionPeerConfigs).toEqual({
    "opencode:reviewer": { observeMe: true, observeOthers: false },
    "opencode:root-parent": { observeMe: false, observeOthers: true },
  })
  expect(topology.describedPeers.childAgentPeer).toEqual({
    id: "opencode:reviewer",
    observeMe: true,
    observeOthers: false,
    sessionScoped: true,
  })
  expect(topology.describedPeers.parentAgentObserverPeer).toEqual({
    id: "opencode:root-parent",
    observeMe: false,
    observeOthers: true,
    modelsOnly: ["opencode:reviewer"],
  })
})

test("local session state keys off the effective Honcho session key, not the raw OpenCode session id", () => {
  const rootHandle = {
    sessionId: "shared-open-session",
    sessionKey: "per-directory:services-api:opencode",
  }
  const delegatedHandle = {
    sessionId: "shared-open-session",
    sessionKey: "per-directory:services-api:opencode-root-parent-opencode-reviewer",
  }

  expect(__testing.deriveSessionStateKey(rootHandle)).toBe(rootHandle.sessionKey)
  expect(__testing.deriveSessionStateKey(delegatedHandle)).toBe(delegatedHandle.sessionKey)
  expect(__testing.deriveSessionStateKey(rootHandle)).not.toBe(__testing.deriveSessionStateKey(delegatedHandle))
})
