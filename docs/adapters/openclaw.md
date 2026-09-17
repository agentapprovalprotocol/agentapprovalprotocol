---
lastModified: 2026-09-17
---

# OpenClaw

Connect OpenClaw to your approval provider to review its tool calls before they run.

## Install

Make sure OpenClaw is installed, then install the [AAP CLI](cli.md#install-the-cli) on the machine running the Gateway. Get an instance token and AAP URL from your provider, and replace the example values below:

```sh
aap install openclaw --instance-token "YOUR_INSTANCE_TOKEN" --base-url "https://approvals.example.com/api/aap"
```

Follow any manual setup instructions printed by the installer, then restart the OpenClaw Gateway.

If you installed an earlier version, update the AAP CLI and repeat the install command to apply the one-week approval window. Apply any manual settings printed by the installer, then restart the Gateway.

## What to expect

By default, every tool call goes to your provider for approval. Requests can wait up to one week for a decision. Your provider may set a shorter deadline. Keep the Gateway and agent run active while approval is pending. A denied or expired request blocks the call, as does a failure to confirm approval.

If AAP cannot start or reach your provider, the tool call is blocked.

## Check it works

Check the local setup:

```sh
aap status openclaw
```

To test the connection, ask OpenClaw to perform a harmless action that your provider holds for review. Approve it and confirm it runs. Repeat with a denial and confirm it is blocked.

## Uninstall

```sh
aap uninstall openclaw
```

This removes the adapter and its saved token from this machine. If you added AAP's settings manually, remove those entries from your OpenClaw configuration too. Then restart the Gateway. Revoke the token with your provider too if you no longer need it.

## Limits and troubleshooting

- **Manual setup requested:** If your OpenClaw configuration uses JSON5, add the settings printed by the installer to `~/.openclaw/openclaw.json`, preserving your other plugins. AAP cannot automatically verify JSON5 setup, so status may remain incomplete. To use automatic setup, convert the file to standard JSON and rerun installation.
- **No approval requests:** Restart the Gateway after installation or changes to the adapter. Check your token and provider URL if requests still do not appear.
- **Other plugins:** Plugins that change tool inputs after AAP approves them can change what actually runs. Avoid combining AAP with plugins that make those changes after review.
