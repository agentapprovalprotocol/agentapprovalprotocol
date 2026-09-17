---
lastModified: 2026-09-17
---

# Claude Code

The Claude Code adapter uses a `PreToolUse` command hook to request approval before a tool call executes. It connects to any provider implementing the current AAP contract.

## Install

Install the [AAP CLI](overview.md#install-the-cli) on the machine running your agent. Obtain an instance token and complete AAP base URL from your provider, then run:

```sh
aap install claude-code --instance-token "$INSTANCE_TOKEN" --base-url "https://approvals.example.com/api/aap"
aap status claude-code
```

Installation configures `~/.claude/settings.json`. Start a new Claude Code session after installation. Existing local permissions still apply after an AAP approval.

Every intercepted tool is covered by default. Add `--tool-glob 'create_*'` to limit coverage to matching normalized AAP tool names. See [filter behavior](overview.md#optional-tool-filter) before narrowing coverage.

## How it works

The hook covers built-in tools and MCP calls. MCP prefixes are removed before glob matching and submission; the server alias is carried in context. The hook can include a short excerpt of recent assistant text from the transcript as agent reasoning.

The shared client handles immediate decisions and polling, validates approval expiry and records consumption before returning permission. Denial, expiry, cancellation and invalid provider exchanges keep covered calls blocked. Nonmatching calls continue through the runtime's ordinary permissions without an AAP request.

## Verify and remove

Make a harmless tool call in a fresh runtime session. Confirm that it appears at your provider, approve it and verify execution. Repeat with a denial and confirm that the call stays blocked. Local status reports registration, not end-to-end connectivity.

```sh
aap uninstall claude-code
```

Uninstall removes recorded local integration and credentials while preserving unrelated user changes. Revoke the token separately at the provider if needed.

## Limits and troubleshooting

The approval window is five minutes, within a 600-second hook timeout. Claude Code controls the final tool execution and any later hooks. Keep the approved arguments unchanged and avoid later hooks that rewrite them.

The [shared enforcement limits](overview.md#approval-enforcement-and-limits) and [adapter requirements](../specification/8_security.md#adapter-requirements) also apply.
