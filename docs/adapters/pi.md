---
lastModified: 2026-09-17
---

# Pi

Connect Pi to your approval provider to review its tool calls before they run.

## Install

Make sure you can run `pi` from your terminal, then install the [AAP CLI](cli.md#install-the-cli) on the same machine. Get an instance token and AAP URL from your provider, and replace the example values below:

```sh
aap agent install pi --instance-token "YOUR_INSTANCE_TOKEN" --base-url "https://approvals.example.com/api/aap"
```

Start a new Pi session to load the adapter.

If you installed an earlier version, update the AAP CLI and repeat the install command to apply the one-week approval window. Then start a new agent session.

## What to expect

By default, every tool call goes to your provider for approval. Requests can wait up to one week for a decision. Your provider may set a shorter deadline. Keep the agent session running while approval is pending. A denied or expired request blocks the call, as does a failure to confirm approval.

If the tool inputs change while you are reviewing them, AAP blocks the call. If AAP cannot start or reach your provider, the call is also blocked.

## Check it works

Check that Pi appears with its adapter installed:

```sh
aap agent discover
```

To test the connection, ask Pi to perform a harmless action that your provider holds for review. Approve it and confirm it runs. Repeat with a denial and confirm it is blocked.

## Uninstall

Make sure `pi` is still available in your terminal, then run:

```sh
aap agent eject pi
```

Confirm removal when prompted. This removes the adapter and its saved token from this machine. Start a new Pi session afterward. For scripted removal and token revocation, see [credentials and maintenance](cli.md#credentials-and-maintenance).

## Limits and troubleshooting

- **Incomplete installation:** Run the `pi install` command printed in the installation notes, then repeat `aap agent install pi` with your token and provider URL.
- **No approval requests:** Start a fresh Pi session. Check your token and provider URL if requests still do not appear.
- **Other extensions:** Extensions that replace tool inputs after approval can change what actually runs. Avoid combining AAP with extensions that make those changes after review.
