---
lastModified: 2026-09-17
---

# DeepSeek Harness

The DeepSeek Harness adapter uses the harness's Claude Code hooks bridge to request approval before a tool call executes. It connects to any provider implementing the current AAP contract.

Implementation: [installer](https://github.com/agentapprovalprotocol/agentapprovalprotocol/blob/main/internal/runtimes/deepseek.go), [hook handler](https://github.com/agentapprovalprotocol/agentapprovalprotocol/blob/main/internal/hook/deepseek.go).

## Install

Install the [AAP CLI](overview.md#install-the-cli) on the machine running your agent. Obtain an instance token and complete AAP base URL from your provider, then run:

```sh
aap install deepseek --instance-token "$INSTANCE_TOKEN" --base-url "https://approvals.example.com/api/aap"
aap status deepseek
```

Installation configures the selected profile's `cordis.patch.yml`, with `hooks.json` under the AAP configuration directory. Run `dsh` under the profile named in the installation notes. The installer selects `default` when present, otherwise the sole profile, otherwise creates `default`. `DSH_HOME` is honored.

Every intercepted tool is covered by default. Add `--tool-glob 'create_*'` to limit coverage to matching normalized AAP tool names. See [filter behavior](overview.md#optional-tool-filter) before narrowing coverage.

## How it works

The installer mounts `@deepseek-ai/dsh-hooks-claude-code` as the `aap` bridge. Calls use the Claude Code hook payload and response format, with `deepseek` recorded as the runtime. Approval preserves the harness's local guards and sandbox checks.

The shared client handles immediate decisions and polling, validates approval expiry and records consumption before returning permission. Denial, expiry, cancellation and invalid provider exchanges keep covered calls blocked. Nonmatching calls continue through the runtime's ordinary permissions without an AAP request.

## Verify and remove

Make a harmless tool call in a fresh runtime session. Confirm that it appears at your provider, approve it and verify execution. Repeat with a denial and confirm that the call stays blocked. Local status reports registration, not end-to-end connectivity.

```sh
aap uninstall deepseek
```

Uninstall removes recorded local integration and credentials while preserving unrelated user changes. Revoke the token separately at the provider if needed.

## Limits and troubleshooting

The request window is five minutes inside a 600-second hook timeout. The existing bridge can let a tool proceed if it cannot start the hook process. Keep the executable at its registered path and verify that calls reach the provider. Once started, the adapter denies malformed calls and failed provider exchanges. No transcript reasoning is supplied by the bridge.

The [shared enforcement limits](overview.md#approval-enforcement-and-limits) and [adapter requirements](../specification/8_security.md#adapter-requirements) also apply.
