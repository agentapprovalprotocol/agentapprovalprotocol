---
lastModified: 2026-09-17
---

# OpenClaw

The OpenClaw adapter is a native plugin loaded by the OpenClaw Gateway. It intercepts tool calls through `before_tool_call`, asks the provider for a decision and returns the outcome to OpenClaw.

## What it supports

| Capability | Current behavior |
| --- | --- |
| Tools | Built-in calls such as `exec`, `write`, `edit`, `browser` and `message`, plus MCP calls passing through the hook. |
| Installation | A local plugin registered in `~/.openclaw/openclaw.json`. |
| Waiting | Synchronous approval, with a one-hour configured window by default. The provider request ends 30 seconds earlier. |
| Failure handling | The plugin blocks when it cannot obtain a usable verdict, including a missing adapter process or an aborted call. |
| Local permissions | OpenClaw's execution approvals and tool policy continue to apply. |

## How it works

The plugin receives the tool event and starts `withhuman hook openclaw --agent openclaw`. It passes the tool name, parameters, call and session identifiers, and its configured timeout to the CLI. The CLI creates an approval request and polls for its outcome.

For MCP names in the form `<server>__<tool>`, the adapter submits the tool name and carries the server alias separately in context. An approval lets OpenClaw continue. A denial returns `block: true` with a reason that OpenClaw gives back to the agent.

The plugin raises the hook's timeout to allow time for review. It uses the `approvalTimeoutMs` setting and gives its child process an additional margin to finish. This keeps the OpenClaw process running whilst it waits.

## Set up with withHuman

### 1. Prepare OpenClaw

Install the [withHuman CLI](overview.md#install-the-cli) on the machine running the OpenClaw Gateway. OpenClaw needs to be installed and configured there.

### 2. Register the plugin

Open `/welcome` on your withHuman deployment and run the setup command it provides:

```sh
withhuman setup --url "https://withhuman.example.com" --code "SETUP_CODE"
```

Substitute your own origin and code. Select **OpenClaw**, then select **exec** for human review to exercise the test below.

Setup writes the plugin under the withHuman configuration directory at `plugins/openclaw`. It adds the plugin to `plugins.allow` and `plugins.load.paths`, and sets `plugins.entries.withhuman` with the CLI path, credential name and timeout.

If your OpenClaw configuration uses JSON5 comments or syntax, setup prints a snippet for you to merge manually. Complete that step before testing, preserving your existing plugin entries.

### 3. Restart the OpenClaw Gateway

Restart the OpenClaw Gateway using your normal service or application controls so it loads the plugin, then inspect the installation:

```sh
withhuman status --agent openclaw
```

This is OpenClaw's own Gateway process. The separate [AAP MCP gateway](mcp-gateway.md) is a different integration.

### 4. Try an approval

```sh
openclaw agent --message "Run this shell command and show me the output: echo hello from withHuman"
```

Approve the request in withHuman, then repeat the test with a denial. A denied call should return the reason to the agent without executing the command.

## Limits and troubleshooting

The plugin handles calls that reach its hook. Later plugins and other execution paths can affect the enforcement boundary; see the shared [implementation limits](overview.md#current-implementation-limits).

The default `approvalTimeoutMs` is `3600000`. Configure it under `plugins.entries.withhuman.config` when a different wait is needed, then restart the Gateway. A longer timeout still requires the running session to remain available.

To remove an automatically installed integration:

```sh
withhuman eject --agent openclaw
```

If you added the JSON5 registration manually, remove those entries manually as well, then restart the Gateway.
