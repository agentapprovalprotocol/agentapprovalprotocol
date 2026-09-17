---
lastModified: 2026-09-17
---

# Adapters overview

An [adapter](../concepts/adapter.md) captures a proposed tool call, asks an approval provider whether it may run and translates the outcome back into the runtime's hook or extension response.

AAP maintains a provider-independent Go library and an `aap` CLI for six common agent runtimes that are listed below.
This list is expanding all the time and if you'd like to contribute an AAP adapter, please do!

## First Party AAP Adapters

| Adapter | Supported modes | Integration | Coverage |
| --- | --- | --- | --- |
| [Claude Code](claude-code.md) | Synchronous | `PreToolUse` command hook | All tools |
| [Codex](codex.md) | Synchronous | `PreToolUse` command hook | All tools |
| [OpenClaw](openclaw.md) | Synchronous | Native Gateway plugin | All tools |
| [Pi](pi.md) | Synchronous | Native extension | All tools |
| [Hermes Agent](hermes.md) | Synchronous | `pre_tool_call` shell hook | All tools |
| [DeepSeek Harness](deepseek.md) | Synchronous | Claude Code hooks bridge | All tools |

Coverage is for tool calls through the configured runtime, with no tool filter. Each guide explains its setup requirements and enforcement limits.

Use the [AAP CLI](cli.md) to install and manage these adapters.
