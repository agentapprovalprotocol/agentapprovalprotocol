---
lastModified: 2026-09-17
---

# DeepSeek Harness

The DeepSeek Harness adapter connects `dsh` to an approval provider through the harness's Claude Code hooks bridge. It targets the DeepSeek agent harness, rather than any application that happens to use a DeepSeek model.

## What it supports

| Capability | Current behavior |
| --- | --- |
| Interception | The `@deepseek-ai/dsh-hooks-claude-code` bridge at `tools/pre-execute`. |
| Tools | Calls reaching the bridge, including built-ins such as `bash`, `run_code`, `write` and `edit`. |
| Waiting | Synchronous polling with a five-minute approval window and a 600-second hook registration. |
| Profile scope | The profile where setup mounts the bridge. |
| MCP discovery | Best-effort discovery from common configuration files; the harness's MCP configuration layout is not verified by this installer. |

## How it works

DeepSeek Harness uses a plugin pipeline for tool execution. Its Claude Code hooks bridge reads a `hooks.json`, starts `withhuman hook deepseek --agent deepseek` and translates the returned hook decision back into the harness's allow, deny or ask behavior.

The adapter uses the Claude Code hook payload shape but identifies the runtime as `deepseek`. Approval lets the harness continue through its own sandbox and local approval checks. Denial or a failed provider exchange returns an explicit deny result.

The bridge supplies no transcript path, so this adapter does not extract agent reasoning from a transcript.

## Set up with withHuman

### 1. Prepare the harness

Install the [withHuman CLI](overview.md#install-the-cli) and DeepSeek Harness with its Claude Code hooks bridge available. Have `dsh` on your `PATH`.

If you use a custom harness home, set `DSH_HOME` before running setup. Otherwise the installer uses `~/.dsh`.

### 2. Install the profile integration

Open `/welcome` on your withHuman deployment and run its setup command:

```sh
withhuman setup --url "https://withhuman.example.com" --code "SETUP_CODE"
```

Use the origin and code from your page. Select **DeepSeek Harness**, then select **bash** for human review.

Setup writes `deepseek/hooks.json` under the withHuman configuration directory and mounts the bridge through the chosen profile's `cordis.patch.yml`. The hook uses the catch-all matcher `.*`.

The installer prefers the `default` profile if it exists. Otherwise it uses the only profile when there is exactly one, or creates `default`. Read the printed profile path and use that profile when starting `dsh`.

### 3. Check the installation

```sh
withhuman status --agent deepseek
```

Start a fresh harness session with the profile setup modified. Confirm the bridge loads and the registered CLI path still exists.

### 4. Try an approval

Under that profile, run:

```sh
dsh -p "Run this shell command and show me the output: echo hello from withHuman"
```

Approve the request in withHuman, then repeat with a denial. Both tests should create requests attributed to DeepSeek Harness.

## Limits and troubleshooting

The bridge can let a call proceed if it cannot start the hook process. Keep the installed CLI at the registered path and test that requests reach withHuman before relying on this integration. A provider failure after the adapter starts is mapped to an explicit denial.

A different harness profile may have no bridge installed. Missing MCP discovery results also do not establish that a server has no tools; discovery is best effort. The shared [implementation limits](overview.md#current-implementation-limits) apply.

To remove the recorded integration:

```sh
withhuman eject --agent deepseek
```
