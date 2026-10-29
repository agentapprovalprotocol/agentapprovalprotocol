---
lastModified: 2026-10-29
---

# Antigravity

Connect Antigravity to your approval provider to review its tool calls before they run, including calls to MCP tools. The adapter covers the `agy` CLI and the desktop app.

## Install

Make sure Antigravity is installed, then install the [AAP CLI](cli.md#install-the-cli) on the same machine. Get an instance token and AAP URL from your provider, and replace the example values below:

```sh
aap agent install antigravity --instance-token "YOUR_INSTANCE_TOKEN" --base-url "https://approvals.example.com/api/aap"
```

Start a new Antigravity conversation to use the adapter.

## What to expect

By default, every tool call goes to your provider for approval. Requests can wait up to one week for a decision. Your provider may set a shorter deadline. Keep the conversation running while approval is pending. A denied or expired request blocks the call, as does a failure to confirm approval or to start AAP.

Antigravity's own permissions still apply after AAP approves an action, so an approval may be followed by a local prompt.

## Check it works

Check that Antigravity appears with its adapter installed:

```sh
aap agent discover
```

To test the connection, ask Antigravity to perform a harmless action that your provider holds for review. Approve it and confirm it runs. Repeat with a denial and confirm it is blocked.

## Uninstall

```sh
aap agent eject antigravity
```

Confirm removal when prompted. This removes the adapter and its saved token from this machine. Start a new conversation afterward. For scripted removal and token revocation, see [credentials and maintenance](cli.md#credentials-and-maintenance).

## Limits and troubleshooting

- **An approved call still stops in `agy -p`:** Print mode cannot ask for local permission, so it refuses commands your Antigravity settings do not already allow. Add an allow rule, or run the task interactively.
- **Every call blocked after moving the CLI:** Antigravity blocks calls when it cannot start AAP. Restore the CLI or reinstall it, then repeat the adapter installation.
- **Windows:** The AAP CLI runs on macOS and Linux only.
- **Every call denied with a refused credential:** The agent may have been archived or disabled, or its token revoked. Ask whoever manages it in your provider, repeat the install command with a new token, or run `aap agent eject antigravity` to stop gating Antigravity.
