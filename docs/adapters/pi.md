---
lastModified: 2026-09-17
---

# Pi

The Pi adapter is a native extension registered on the `tool_call` event. It holds model-proposed calls whilst the provider decides whether they may run.

## What it supports

| Capability | Current behavior |
| --- | --- |
| Tools | Calls emitted through `tool_call`, including `bash`, `write`, `edit`, `read`, `grep`, `find` and `ls`. |
| Installation | A local extension package registered with `pi install`. |
| Waiting | Synchronous approval, with a one-hour configured window by default. The provider request ends 30 seconds earlier. |
| Agent reasoning | A short excerpt of the latest assistant text from the active session branch. |
| MCP discovery | The current Pi integration does not discover MCP servers. |

## How it works

The extension snapshots the tool arguments and starts `withhuman hook pi --agent pi`. It sends the snapshot, call ID, session ID, working directory and wait limit to the CLI, which creates the approval request and polls for a decision.

On denial or a process failure, the extension returns a block with a reason. On approval, it lets the tool continue through the remaining runtime checks.

For a human-approved call, the extension checks that the arguments did not change during review and deep-freezes them before continuing. This protects that reviewed call against later argument mutations. The current implementation applies this extra protection to decisions it identifies as human approvals.

## Set up with withHuman

### 1. Prepare Pi

Install the [withHuman CLI](overview.md#install-the-cli) and make sure the `pi` executable is on your `PATH`.

### 2. Install the extension

Open your withHuman deployment's `/welcome` page and run its setup command:

```sh
withhuman setup --url "https://withhuman.example.com" --code "SETUP_CODE"
```

Use the origin and setup code from your page. Choose **Pi**, then select **bash** for human review.

Setup writes a package under `plugins/pi` in the withHuman configuration directory. Its `withhuman.json` records the CLI path and the `pi` credential name. Setup then runs `pi install` with the package's absolute path.

If registration cannot run automatically, the CLI prints the exact `pi install` command to run yourself. Complete that step before continuing.

### 3. Start a fresh session

```sh
withhuman status --agent pi
```

A fresh Pi session loads the installed extension. An existing session needs to restart.

### 4. Try an approval

```sh
pi -p "Run this shell command and show me the output: echo hello from withHuman"
```

Approve the request in withHuman to let the command run. Repeat with a denial and confirm that Pi receives a blocked tool result.

## Limits and troubleshooting

The extension's default wait is one hour. `WITHHUMAN_APPROVAL_TIMEOUT_MS` can change it for a session; the value is in milliseconds and must be at least `60000`. `WITHHUMAN_BINARY` and `WITHHUMAN_AGENT` override the installed binary path and credential name.

Approval keeps the Pi process and its extension running. It does not save the call for webhook-based resumption after a process restart. The shared [implementation limits](overview.md#current-implementation-limits) also apply.

To unregister the extension and remove the recorded local integration:

```sh
withhuman eject --agent pi
```
