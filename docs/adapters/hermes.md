---
lastModified: 2026-09-17
---

# Hermes Agent

Connect Hermes Agent to your approval provider to review its tool calls before they run.

## Install

Make sure Hermes is installed, then install the [AAP CLI](cli.md#install-the-cli) on the same machine. Get an instance token and AAP URL from your provider, and replace the example values below:

```sh
aap install hermes --instance-token "YOUR_INSTANCE_TOKEN" --base-url "https://approvals.example.com/api/aap"
```

Start a fresh Hermes session and accept its one-time request to enable the AAP hook. Run `hermes hooks list` to check that it is active.

## What to expect

By default, every tool call goes to your provider for approval. Requests can wait up to four and a half minutes for a decision. A denied or expired request blocks the call, as does a failure to confirm approval.

Hermes's own permissions still apply after AAP approves an action.

## Check it works

Check the local setup:

```sh
aap status hermes
```

To test the connection, ask Hermes to perform a harmless action that your provider holds for review. Approve it and confirm it runs. Repeat with a denial and confirm it is blocked.

## Uninstall

```sh
aap uninstall hermes
```

This removes the adapter and its saved token from this machine. Start a new Hermes session afterward. Revoke the token with your provider too if you no longer need it.

## Limits and troubleshooting

- **No approval requests:** Check `hermes hooks list` and make sure you accepted the hook consent prompt. Check your token and provider URL if requests still do not appear.
- **Adding other hooks:** Keep AAP last in Hermes's `pre_tool_call` list so later hooks cannot change an approved action. Rerunning the install command puts AAP last again.
- **Requests expire:** Complete the review within four and a half minutes. After expiry, ask the agent to retry so it creates a new request.
