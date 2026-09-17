---
lastModified: 2026-09-17
---

# MCP wrapper

An MCP wrapper would add approval to an existing MCP connection. The agent's MCP client would start a local proxy, which would hold tool calls until an AAP provider returned a valid decision.

The wrapper is deferred and is not included in the `aap` binary. The previous withHuman wrapper commands have been removed. There is no `aap mcp wrap` command in this release.

## Available alternatives

Use one of the six [runtime adapters](overview.md#choose-an-adapter) when the agent supports its hooks or extensions. These adapters cover MCP tool calls intercepted by the runtime as described in each guide.

For a remote integration that keeps downstream credentials away from the agent's machine, consider a provider's [MCP gateway](mcp-gateway.md). The gateway is deployed and configured separately from `aap`.

## Scope of a future wrapper

A wrapper would see only traffic on its MCP connection. Shell commands, other servers and direct connections to the original server would remain outside it. An implementation must satisfy the same [adapter requirements](../specification/8_security.md#adapter-requirements), including decision expiry, cancellation and prevention of approval replay.
