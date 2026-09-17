---
lastModified: 2026-09-17
---

# MCP wrapper

The MCP wrapper adds approval to an existing MCP connection. The agent's MCP client starts the wrapper as a local stdio server, and the wrapper forwards calls to the real server after requesting approval.

Use it when you want to cover a particular MCP server, including in a runtime that has no native approval hook.

## What it supports

| Capability | Current behavior |
| --- | --- |
| Agent connection | Local MCP over stdio. |
| Downstream connection | A child stdio server or a remote Streamable HTTP endpoint. |
| Approval coverage | `tools/call` requests on the wrapped connection. |
| Waiting | Synchronous polling with a five-minute approval window. |
| Denials | A normal MCP tool result with `isError: true` and a reason. |

## How it works

`withhuman mcp wrap` proxies the MCP messages exchanged by the client and server. It holds each `tools/call`, submits the server-defined tool name and arguments to the provider, and waits for the outcome. Approval forwards the original call. Other traffic can continue whilst review is pending.

For a child server, the wrapper forwards stdio traffic in both directions. For a remote server, it converts the client's stdio messages into HTTP requests and relays JSON or SSE responses back.

The wrapper emits progress notifications every ten seconds when the client supplied a progress token. Whether that extends the call's lifetime depends on the client's timeout behavior.

## Set up with withHuman

### 1. Prepare the connection

Install the [withHuman CLI](overview.md#install-the-cli). Start with an MCP server that already works in your agent's client, and keep its existing command, arguments, environment and authentication settings available.

### 2. Enroll an instance

Choose a credential name for this connection and enroll it with your provider:

```sh
withhuman init --agent mcp-wrapper --url "https://withhuman.example.com"
```

Replace the example origin with your withHuman deployment. Open the authorization URL printed by the CLI and enter its code. Complete enrollment in the browser; the CLI then saves the instance credential under `mcp-wrapper`.

In withHuman, configure the enrolled agent's approval pipeline to send your chosen test tool to a reviewer. Enrollment alone does not create the runtime-specific guided setup policy.

### 3. Wrap the server

Change the MCP client's server entry so it launches `withhuman` and places the original server command after `--`. For a client using `mcpServers`, the configuration has this shape:

```json
{
  "mcpServers": {
    "reviewed-tools": {
      "command": "withhuman",
      "args": [
        "mcp", "wrap", "--agent", "mcp-wrapper", "--",
        "/absolute/path/to/your-mcp-server"
      ]
    }
  }
}
```

Replace the example server path with its real command and append its original arguments. Preserve any environment variables the server needs. Use the CLI's absolute path if the MCP client cannot find `withhuman` on its `PATH`.

For a remote HTTP server, configure the client to launch the equivalent of:

```sh
withhuman mcp wrap --agent mcp-wrapper --url "https://mcp.example.com/mcp"
```

The remote form accepts repeated `--header 'Name: value'` arguments for static authentication. Its downstream credentials remain on the local machine. The [MCP gateway](mcp-gateway.md) provides centrally held downstream credentials and OAuth connections.

### 4. Test both outcomes

Restart or reconnect the MCP client, then inspect enrollment:

```sh
withhuman status --agent mcp-wrapper
```

Ask the agent to call the tool you selected for review with harmless arguments. Approve it in withHuman and check that the downstream server receives the call. Repeat with a denial and check that the agent receives the reason without the call reaching the server.

## Limits and troubleshooting

The wrapper only sees tools on its MCP connection. Shell commands, other servers and direct connections to the original server remain outside it.

The HTTP bridge does not open a standing GET stream, so server-initiated requests such as sampling and elicitation are not supported through that channel. It also does not manage downstream OAuth sign-in or refresh. Without a progress token, the wrapper cannot send keepalives whilst approval waits.

The current wrapper has no per-call cancellation tracking; its approval wait relies on the provider's deadline. The shared [implementation limits](overview.md#current-implementation-limits) also apply.

To remove it, restore the MCP client's original server entry and restart the connection. Revoke the wrapper's instance credential in withHuman when it is no longer needed.
