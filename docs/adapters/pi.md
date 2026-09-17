---
lastModified: 2026-09-17
---

# Pi

Connect Pi to your approval provider to review its tool calls before they run.

## Install

Make sure you can run `pi` from your terminal, then install the [AAP CLI](cli.md#install-the-cli) on the same machine. Get an instance token and AAP URL from your provider, and replace the example values below:

```sh
aap install pi --instance-token "YOUR_INSTANCE_TOKEN" --base-url "https://approvals.example.com/api/aap"
```

Start a new Pi session to load the adapter.

## What to expect

By default, every tool call goes to your provider for approval. Requests can wait up to an hour for a decision. A denied or expired request blocks the call, as does a failure to confirm approval.

If the tool inputs change while you are reviewing them, AAP blocks the call. If AAP cannot start or reach your provider, the call is also blocked.

## Check it works

Check the local setup:

```sh
aap status pi
```

To test the connection, ask Pi to perform a harmless action that your provider holds for review. Approve it and confirm it runs. Repeat with a denial and confirm it is blocked.

## Uninstall

Make sure `pi` is still available in your terminal, then run:

```sh
aap uninstall pi
```

This removes the adapter and its saved token from this machine. Start a new Pi session afterward. Revoke the token with your provider too if you no longer need it.

## Limits and troubleshooting

- **Incomplete installation:** Run the `pi install` command printed in the installation notes, then repeat `aap install pi` with your token and provider URL.
- **No approval requests:** Start a fresh Pi session. Check your token and provider URL if requests still do not appear.
- **Other extensions:** Extensions that replace tool inputs after approval can change what actually runs. Avoid combining AAP with extensions that make those changes after review.
