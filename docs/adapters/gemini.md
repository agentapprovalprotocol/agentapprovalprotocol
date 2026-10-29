---
lastModified: 2026-10-29
---

# Gemini CLI

Connect Gemini CLI to your approval provider to review its tool calls before they run, including calls to MCP tools.

Gemini CLI runs a tool without approval if it cannot start AAP. Keep the CLI in its installed location and test the connection after setup.

## Install

Make sure Gemini CLI is installed, then install the [AAP CLI](cli.md#install-the-cli) on the same machine. Get an instance token and AAP URL from your provider, and replace the example values below:

```sh
aap agent install gemini --instance-token "YOUR_INSTANCE_TOKEN" --base-url "https://approvals.example.com/api/aap"
```

Start a new Gemini CLI session to use the adapter.

## What to expect

By default, every tool call goes to your provider for approval. Requests can wait up to one week for a decision. Your provider may set a shorter deadline. Keep the agent session running while approval is pending. When AAP is running, a denied or expired request blocks the call, as does a failure to confirm approval.

Gemini CLI's own policy and confirmations still apply, so an AAP approval may be followed by a local prompt.

## Check it works

Check that Gemini CLI appears with its adapter installed:

```sh
aap agent discover
```

To test the connection, ask Gemini CLI to perform a harmless action that your provider holds for review. Approve it and confirm it runs. Repeat with a denial and confirm it is blocked. Repeat this test if you move or reinstall the CLI.

## Uninstall

```sh
aap agent eject gemini
```

Confirm removal when prompted. This removes the adapter and its saved token from this machine. Start a new Gemini CLI session afterward. For scripted removal and token revocation, see [credentials and maintenance](cli.md#credentials-and-maintenance).

## Limits and troubleshooting

- **No approval requests:** Check that hooks are turned on in Gemini CLI's settings (`hooksConfig.enabled`) and that you started a new session.
- **CLI moved or removed:** Gemini CLI continues without approvals if it cannot start AAP. Restore the CLI or reinstall it, then repeat the adapter installation and the approval test.
- **Windows:** The AAP CLI runs on macOS and Linux only.
- **Every call denied with a refused credential:** The agent may have been archived or disabled, or its token revoked. Ask whoever manages it in your provider, repeat the install command with a new token, or run `aap agent eject gemini` to stop gating Gemini CLI.
