---
lastModified: 2026-09-17
---

# Hermes Agent

The Hermes adapter uses the native `pre_tool_call` shell hook. It sends the proposed call to the provider and returns a directive that either blocks the tool or preserves the approved arguments for execution.

## What it supports

| Capability | Current behavior |
| --- | --- |
| Tools | Hooked built-in calls such as `terminal`, `process`, `execute_code`, `patch` and `write_file`, plus MCP calls. |
| Installation | A shell hook in `~/.hermes/config.yaml`. |
| Waiting | Synchronous polling with a 270-second approval window. |
| Runtime timeouts | A 300-second shell-hook timeout and an outer callback timeout of at least 330 seconds. |
| Failure handling | `fail_closed: true`, with explicit block responses for invalid hook input or failed approval requests. |

## How it works

Hermes writes the tool event to `withhuman hook hermes --agent hermes`. The adapter submits the exact arguments and the available session, task, turn and call identifiers. MCP names are normalized and their server alias is carried in context.

An approval returns `action: modify` with the complete reviewed argument object. This preserves the arguments whilst allowing Hermes's own guardrails to continue. Other outcomes return `action: block` and a message.

Hook order matters: withHuman must be the last `pre_tool_call` hook. Hermes combines modifications in registration order, so the adapter returns its reviewed arguments after earlier hooks have returned theirs. Setup installs it last.

## Set up with withHuman

### 1. Prepare Hermes

Install the [withHuman CLI](overview.md#install-the-cli) and a Hermes build that supports `pre_tool_call` shell hooks. Have `hermes` available on your `PATH`.

### 2. Install the hook

Open `/welcome` on your withHuman deployment and run the command provided there:

```sh
withhuman setup --url "https://withhuman.example.com" --code "SETUP_CODE"
```

Replace the example origin and code. Select **Hermes Agent**, then select **terminal** for human review.

Setup adds the hook as the final entry in `hooks.pre_tool_call` and raises `plugins.hook_callback_timeout` when needed. It sets the hook's timeout and `fail_closed` behavior automatically.

### 3. Accept the hook

Start Hermes and accept its one-time consent to run the new shell hook. You can also start once with:

```sh
hermes --accept-hooks chat
```

Inspect the active hooks and stored integration:

```sh
hermes hooks list
withhuman status --agent hermes
```

### 4. Try an approval

```sh
hermes chat -q "Run this shell command and show me the output: echo hello from withHuman"
```

Approve the request in withHuman and check the result. Repeat with a denial to confirm that the tool is blocked. Complete the review within the 270-second request window.

## Limits and troubleshooting

If the hook never runs, check Hermes's hook consent and the active hook list. Keep withHuman last when adding other `pre_tool_call` hooks. The current adapter rejects payloads without a session ID, tool-call ID or argument object.

The decision window leaves time for the provider's expiry response before Hermes stops the hook. Increasing an outer timeout alone does not change the adapter's 270-second request window. See the shared [implementation limits](overview.md#current-implementation-limits).

To remove the local integration:

```sh
withhuman eject --agent hermes
```
