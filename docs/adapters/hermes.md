---
lastModified: 2026-09-17
---

# Hermes Agent

The Hermes Agent adapter uses the native `pre_tool_call` shell hook to request approval before a tool call executes. It connects to any provider implementing the current AAP contract.

## Install

Build and place the [AAP CLI](overview.md#install-the-cli) at a stable location. Obtain an instance token and complete AAP base URL from your provider, then run:

```sh
aap install hermes --instance-token "$INSTANCE_TOKEN" --base-url "https://approvals.example.com/api/aap"
aap status hermes
```

Installation configures `~/.hermes/config.yaml`. Accept Hermes's one-time hook consent, or start once with `hermes --accept-hooks chat`. Inspect `hermes hooks list` after installation.

Every intercepted tool is covered by default. Add `--tool-glob 'create_*'` to limit coverage to matching normalized AAP tool names. See [filter behavior](overview.md#optional-tool-filter) before narrowing coverage.

## How it works

Installation puts AAP last in `hooks.pre_tool_call`, enables `fail_closed` and sets a sufficient callback timeout. Approval returns an identity modification containing the reviewed arguments. MCP names normalize before filtering; session, task, turn and call identifiers are included when available.

The shared client handles immediate decisions and polling, validates approval expiry and records consumption before returning permission. Denial, expiry, cancellation and invalid provider exchanges keep covered calls blocked. Nonmatching calls continue through the runtime's ordinary permissions without an AAP request.

## Verify and remove

Make a harmless tool call in a fresh runtime session. Confirm that it appears at your provider, approve it and verify execution. Repeat with a denial and confirm that the call stays blocked. Local status reports registration, not end-to-end connectivity.

```sh
aap uninstall hermes
```

Uninstall removes recorded local integration and credentials while preserving unrelated user changes. Revoke the token separately at the provider if needed.

## Limits and troubleshooting

AAP must remain the last `pre_tool_call` hook because Hermes merges hook modifications in registration order. The request window is 270 seconds inside a 300-second hook ceiling, with a 330-second callback timeout. Missing session or call identifiers and malformed argument objects block execution.

The [shared enforcement limits](overview.md#approval-enforcement-and-limits) and [adapter requirements](../specification/8_security.md#adapter-requirements) also apply.
