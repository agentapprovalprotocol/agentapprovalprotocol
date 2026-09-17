---
lastModified: 2026-09-17
---

# Codex

The Codex adapter connects command hooks to an approval provider. Guided setup installs a `PreToolUse` hook for built-in tools and MCP tool calls. Use a Codex build that supports these command hooks.

## What it supports

| Capability | Current behavior |
| --- | --- |
| Guided installation | A catch-all `PreToolUse` hook in `~/.codex/config.toml`. |
| Tools | Hook-reported tools, including `Bash`, `apply_patch` and MCP calls. |
| Waiting | Synchronous polling with a five-minute approval window and a 600-second hook timeout. |
| MCP discovery | Uses Codex's own server inventory when its executable is available. |
| Additional hook event | The frontend also understands `PermissionRequest`; guided setup does not install it. |

## How it works

Codex passes the proposed call to `withhuman hook codex --agent codex`. The adapter submits the tool and arguments with session, turn and call identifiers, then waits for a terminal outcome.

For `PreToolUse`, approval lets Codex continue through its own permission flow. Other outcomes return an explicit denial. For a manually configured `PermissionRequest` hook, approval returns an explicit allow because that hook replaces the local approval prompt. These events serve different purposes.

Setup writes the `[[hooks.PreToolUse]]` configuration and its trust record under `hooks.state`. The trust record lets noninteractive runs execute the installed hook. You can inspect it with `/hooks` in Codex.

## Set up with withHuman

### 1. Prepare Codex

Install the [withHuman CLI](overview.md#install-the-cli), sign in to Codex and make sure `codex` is on your `PATH`. Sign in to any MCP servers you want setup to discover.

### 2. Install the hook

Open `/welcome` on your withHuman deployment and run its setup command from your project:

```sh
withhuman setup --url "https://withhuman.example.com" --code "SETUP_CODE"
```

Use your own origin and setup code. Choose **Codex**, then choose **Bash** for human review so the test below will wait for you. Setup installs the hook with the `.*` matcher and a runtime-specific credential.

### 3. Verify configuration

```sh
withhuman status --agent codex
```

Start a new Codex session and inspect `/hooks`. If you subsequently edit the hook command, matcher or timeout, review its trust again. The setup command reports any configuration rewriting it performed.

### 4. Try an approval

```sh
codex exec --skip-git-repo-check "Run this shell command and show me the output: echo hello from withHuman"
```

Approve the request in withHuman and check that the command runs. Repeat with a denial and check that it remains blocked. Codex's local sandbox and permission rules still apply after a `PreToolUse` approval.

## Limits and troubleshooting

MCP discovery uses Codex's app-server inventory so it can see servers authenticated through Codex. If the executable is unavailable, discovery falls back to the MCP server configuration in `~/.codex/config.toml`.

`PermissionRequest` does not provide the same per-call identifier as `PreToolUse`, so identical requests within a turn need particular care around replay. The shared [implementation limits](overview.md#current-implementation-limits) also apply.

To remove the installed hook and its trust record:

```sh
withhuman eject --agent codex
```
