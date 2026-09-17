---
lastModified: 2026-09-17
---

# Adapters overview

An adapter connects your agent to an [approval provider](../providers/overview.md), so tool calls can be reviewed before they run. Your provider can approve routine actions automatically and ask you to review others.

## Choose your agent

Install the [AAP CLI](cli.md#install-the-cli), then follow the guide for the agent you use. You will need an instance token and an AAP URL from your provider.

| Agent | After installing the adapter |
| --- | --- |
| [Claude Code](claude-code.md) | Start a new Claude Code session. |
| [Codex](codex.md) | Start a new session and check `/hooks`. |
| [OpenClaw](openclaw.md) | Restart the OpenClaw Gateway. |
| [Pi](pi.md) | Start a new Pi session. |
| [Hermes Agent](hermes.md) | Start a new session and accept the AAP hook when prompted. |
| [DeepSeek Harness](deepseek.md) | Use the profile shown in the installation notes. |

By default, AAP requests approval for all tool calls made through the configured agent. Your agent's own permissions still apply. Each guide explains how long it waits for approval and any limitations that affect your setup.

## Check your setup

After installation, try a harmless action that your provider holds for review. Approve it and confirm it runs, then try again with a denial and confirm it is blocked. This checks that your agent is connected to the provider and following its decisions.

For updates, new credentials or removal, see [credentials and maintenance](cli.md#credentials-and-maintenance).
