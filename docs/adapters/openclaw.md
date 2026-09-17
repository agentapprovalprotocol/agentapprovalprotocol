---
lastModified: 2026-09-17
---

# OpenClaw

The OpenClaw adapter uses a native plugin registered on `before_tool_call` to request approval before a tool call executes. It connects to any provider implementing the current AAP contract.

## Install

Install the [AAP CLI](overview.md#install-the-cli) on the machine running your agent. Obtain an instance token and complete AAP base URL from your provider, then run:

```sh
aap install openclaw --instance-token "$INSTANCE_TOKEN" --base-url "https://approvals.example.com/api/aap"
aap status openclaw
```

Installation configures `~/.openclaw/openclaw.json`. Restart the OpenClaw Gateway after installation so it loads the plugin.

Every intercepted tool is covered by default. Add `--tool-glob 'create_*'` to limit coverage to matching normalized AAP tool names. See [filter behavior](overview.md#optional-tool-filter) before narrowing coverage.

## How it works

The installer writes the plugin under AAP's `plugins/openclaw` directory and registers it as `aap` in the runtime configuration. The plugin invokes the installing executable, snapshots arguments and returns the reviewed parameters after approval. MCP names such as `stripe__create_refund` normalize to `create_refund`.

The shared client handles immediate decisions and polling, validates approval expiry and records consumption before returning permission. Denial, expiry, cancellation and invalid provider exchanges keep covered calls blocked. Nonmatching calls continue through the runtime's ordinary permissions without an AAP request.

## Verify and remove

Make a harmless tool call in a fresh runtime session. Confirm that it appears at your provider, approve it and verify execution. Repeat with a denial and confirm that the call stays blocked. Local status reports registration, not end-to-end connectivity.

```sh
aap uninstall openclaw
```

Uninstall removes recorded local integration and credentials while preserving unrelated user changes. Revoke the token separately at the provider if needed.

## Limits and troubleshooting

Strict JSON configuration is edited automatically. JSON5 configurations receive a manual snippet and an incomplete result; merge it without replacing other plugin entries, or convert the file to strict JSON and rerun installation for automatic verification. The default wait is one hour, with margins for cancellation and process shutdown. Missing executables, invalid output and expired approvals block the call. Later plugins may still alter parameters, so inspect their order and behavior.

The [shared enforcement limits](overview.md#approval-enforcement-and-limits) and [adapter requirements](../specification/8_security.md#adapter-requirements) also apply.
