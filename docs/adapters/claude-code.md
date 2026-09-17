---
lastModified: 2026-09-17
---

# Claude Code

The Claude Code adapter uses a `PreToolUse` command hook to request approval before a tool executes. It covers built-in tools such as `Bash`, `Write` and `Edit`, along with MCP tools exposed to the session.

## What it supports

| Capability | Current behavior |
| --- | --- |
| Interception | A catch-all `PreToolUse` hook sends each matching call to the provider. |
| Waiting | Synchronous polling with a five-minute approval window and a 600-second hook timeout. |
| MCP discovery | User and current-project server configuration, including available stored OAuth credentials. |
| Request context | Session, working directory, call ID when supplied and MCP server alias. |
| Approval | Lets Claude Code continue through its own local permission checks. |

## How it works

Claude Code starts `withhuman hook claude-code --agent claude-code` and writes the proposed tool name and arguments to its standard input. The hook submits the request and waits for the provider's decision.

For MCP tools, the adapter removes the runtime's `mcp__<server>__` prefix and carries the server alias in request context. It can also include a short excerpt of the latest assistant text from the session transcript as agent reasoning.

On approval, the hook exits without a permission override, so Claude Code's own rules still apply. Denial, expiry, cancellation or failure to obtain a decision produces an explicit `permissionDecision: deny` response.

## Set up with withHuman

### 1. Prepare the machine

Install the [withHuman CLI](overview.md#install-the-cli) and have Claude Code installed and signed in. Run setup from your working project so discovery can include its MCP servers.

### 2. Connect the adapter

Open your withHuman deployment's `/welcome` page and run the command it provides:

```sh
withhuman setup --url "https://withhuman.example.com" --code "SETUP_CODE"
```

Replace the origin and code with your own values. Select **Claude Code** in **Choose agents**, then select **Bash** in **Choose tools** for the test below. You can select additional tools for review.

Setup adds the hook to `~/.claude/settings.json`, uses the catch-all matcher `.*` and records the installed CLI's absolute path. Existing sessions need to restart to load it.

### 3. Check the installation

```sh
withhuman status --agent claude-code
```

Start a fresh Claude Code session. Keep the CLI binary at the path setup registered.

### 4. Try an approval

```sh
claude -p --allowedTools "Bash" "Run this shell command and show me the output: echo hello from withHuman"
```

The `--allowedTools` flag allows this test through Claude Code's local permissions in print mode. The withHuman hook still runs first. Approve the request in withHuman and the command prints its message. Repeat the test and deny the new request to check that the command does not run.

## Limits and troubleshooting

If a configured MCP server needs authentication, sign in through Claude Code and repeat discovery. The adapter reads user configuration in `~/.claude.json` and the current project's `.mcp.json`; discovery results depend on where setup runs.

When a hook payload lacks `tool_use_id`, the current implementation falls back to session and arguments for its idempotency key. Identical calls in that session can therefore reuse an earlier approval. See the shared [implementation limits](overview.md#current-implementation-limits).

To remove the local integration:

```sh
withhuman eject --agent claude-code
```
