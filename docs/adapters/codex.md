---
lastModified: 2026-09-17
---

# Codex

Connect Codex to your approval provider to review its tool calls before they run.

## Install

Use a Codex version that supports command hooks, and install the [AAP CLI](cli.md#install-the-cli) on the same machine. Get an instance token and AAP URL from your provider, and replace the example values below:

```sh
aap install codex --instance-token "YOUR_INSTANCE_TOKEN" --base-url "https://approvals.example.com/api/aap"
```

Start a new Codex session and run `/hooks` to check that AAP is enabled.

If you installed an earlier version, update the AAP CLI and repeat the install command to apply the one-week approval window. Then start a new agent session.

## What to expect

By default, every tool call goes to your provider for approval. Requests can wait up to one week for a decision. Your provider may set a shorter deadline. Keep the agent session running while approval is pending. A denied or expired request blocks the call, as does a failure to confirm approval.

Codex's own permissions still apply. Approving an action through AAP does not override a local permission prompt or sandbox restriction.

## Check it works

Check the local setup:

```sh
aap status codex
```

To test the connection, ask Codex to perform a harmless action that your provider holds for review. Approve it and confirm it runs. Repeat with a denial and confirm it is blocked.

## Uninstall

```sh
aap uninstall codex
```

This removes the adapter and its saved token from this machine. Start a new Codex session afterward. Revoke the token with your provider too if you no longer need it.

## Limits and troubleshooting

- If AAP is missing or disabled in `/hooks`, confirm your Codex version supports command hooks. Repeat the install command, then start a new session.
- If you edit AAP's hook settings manually, Codex may stop trusting it. Rerun the install command to restore the setup.
- If an approved call still stops, check Codex's own permissions and sandbox settings.
