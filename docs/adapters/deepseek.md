---
lastModified: 2026-09-17
---

# DeepSeek Harness

Connect DeepSeek Harness to your approval provider to review its tool calls before they run.

DeepSeek can let a tool run without approval if it cannot start AAP. Keep the CLI in its installed location and test the connection after setup.

## Install

Make sure DeepSeek Harness is installed, then install the [AAP CLI](cli.md#install-the-cli) on the same machine. Get an instance token and AAP URL from your provider, and replace the example values below:

```sh
aap install deepseek --instance-token "YOUR_INSTANCE_TOKEN" --base-url "https://approvals.example.com/api/aap"
```

Start a new `dsh` session using the profile shown in the installation notes. The adapter applies to that profile.

## What to expect

By default, tool calls in the configured profile go to your provider for approval. Requests can wait up to five minutes for a decision. When AAP is running, a denied or expired request blocks the call, as does a failure to confirm approval.

The harness's own permissions and sandbox restrictions still apply after AAP approves an action.

## Check it works

Check the local setup:

```sh
aap status deepseek
```

To test the connection, ask DeepSeek to perform a harmless action that your provider holds for review. Approve it and confirm it runs. Repeat with a denial and confirm it is blocked. Repeat this test if you move or reinstall the CLI.

## Uninstall

```sh
aap uninstall deepseek
```

This removes the adapter and its saved token from this machine. Start a new DeepSeek session afterward. Revoke the token with your provider too if you no longer need it.

## Limits and troubleshooting

- **No approval requests:** Check that you are using the profile shown in the installation notes. Other profiles are not covered by that installation.
- **CLI moved or removed:** DeepSeek may continue without approvals if it cannot start AAP. Restore the CLI or reinstall it, then repeat the adapter installation and the approval test.
- **An approved call still stops:** Check the harness's own permissions and sandbox settings.
