---
lastModified: 2026-09-17
---

# Codex

The Codex adapter uses a `PreToolUse` command hook to request approval before a tool call executes. It connects to any provider implementing the current AAP contract.

Implementation: [installer](https://github.com/agentapprovalprotocol/agentapprovalprotocol/blob/main/internal/runtimes/codex.go), [hook handler](https://github.com/agentapprovalprotocol/agentapprovalprotocol/blob/main/internal/hook/codex.go).

## Install

Install the [AAP CLI](overview.md#install-the-cli) on the machine running your agent. Obtain an instance token and complete AAP base URL from your provider, then run:

```sh
aap install codex --instance-token "$INSTANCE_TOKEN" --base-url "https://approvals.example.com/api/aap"
aap status codex
```

Installation configures `~/.codex/config.toml`. Use a Codex build that supports command hooks. Start a new session and inspect `/hooks` after installation.

Every intercepted tool is covered by default. Add `--tool-glob 'create_*'` to limit coverage to matching normalized AAP tool names. See [filter behavior](overview.md#optional-tool-filter) before narrowing coverage.

## How it works

Installation adds a catch-all hook and its trust record under `hooks.state`. AAP approval preserves Codex's own local permissions. The hook frontend also understands manually configured `PermissionRequest` events; these return explicit permission only for covered, approved calls. Filtered calls leave the local prompt in place.

The shared client handles immediate decisions and polling, validates approval expiry and records consumption before returning permission. Denial, expiry, cancellation and invalid provider exchanges keep covered calls blocked. Nonmatching calls continue through the runtime's ordinary permissions without an AAP request.

## Verify and remove

Make a harmless tool call in a fresh runtime session. Confirm that it appears at your provider, approve it and verify execution. Repeat with a denial and confirm that the call stays blocked. Local status reports registration, not end-to-end connectivity.

```sh
aap uninstall codex
```

Uninstall removes recorded local integration and credentials while preserving unrelated user changes. Revoke the token separately at the provider if needed.

## Limits and troubleshooting

The approval window is five minutes, within a 600-second hook timeout. Changes to the command, matcher or timeout require a matching trust record. When an event supplies no call ID, each invocation requests a new approval rather than reusing a decision for identical arguments.

The [shared enforcement limits](overview.md#approval-enforcement-and-limits) and [adapter requirements](../specification/8_security.md#adapter-requirements) also apply.
