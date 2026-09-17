---
lastModified: 2026-09-17
---

# Claude Code

Connect Claude Code to your approval provider to review its tool calls before they run, including calls to MCP tools.

## Install

Make sure Claude Code is installed, then install the [AAP CLI](cli.md#install-the-cli) on the same machine. Get an instance token and AAP URL from your provider, and replace the example values below:

```sh
aap agent install claude-code --instance-token "YOUR_INSTANCE_TOKEN" --base-url "https://approvals.example.com/api/aap"
```

Start a new Claude Code session to use the adapter.

If you installed an earlier version, update the AAP CLI and repeat the install command to apply the one-week approval window. Then start a new agent session.

## What to expect

By default, every tool call goes to your provider for approval. Requests can wait up to one week for a decision. Your provider may set a shorter deadline. Keep the agent session running while approval is pending. A denied or expired request blocks the call, as does a failure to confirm approval.

Claude Code's own permissions still apply, so an AAP approval may be followed by a local permission prompt. Your provider may also receive a short excerpt of the agent's explanation for the proposed action.

## Check it works

Check that Claude Code appears with its adapter installed:

```sh
aap agent discover
```

To test the connection, ask Claude Code to perform a harmless action that your provider holds for review. Approve it and confirm it runs. Repeat with a denial and confirm it is blocked.

## Uninstall

```sh
aap agent eject claude-code
```

Confirm removal when prompted. This removes the adapter and its saved token from this machine. Start a new Claude Code session afterward. For scripted removal and token revocation, see [credentials and maintenance](cli.md#credentials-and-maintenance).

## Limits and troubleshooting

- If requests do not appear, start a fresh Claude Code session and check your token and provider URL. Repeat the install command to update them.
- If an approved call still stops, check Claude Code's own permissions and any other hooks you have installed.
- Other hooks can change an action after AAP has approved it. Avoid hooks that rewrite tool inputs after the approval check.
