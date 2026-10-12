---
lastModified: 2026-10-12
---

# Claude Agent SDK

Send every tool call of a Claude Agent SDK agent to your approval provider before it runs, including built-in tools, MCP tools and calls made by subagents.

## Install

```sh
pip install "agentapprovalprotocol[claude-agent-sdk]"
```

## Set up

Build the agent's options with `approvals.options`:

```python
import os
from claude_agent_sdk import ClaudeAgentOptions, query
from agentapprovalprotocol.claude_agent_sdk import ApprovalHooks

approvals = ApprovalHooks("https://approvals.example.com/api/aap", os.environ["AAP_INSTANCE_TOKEN"])
options = approvals.options(ClaudeAgentOptions(mcp_servers=servers))

async for message in query(prompt=prompt, options=options):
    ...
```

Each call waits for the decision. A denied call returns the reason to the model.

`options` loads project and local settings, but not your user settings in `~/.claude/settings.json`. This keeps a Claude Code approval hook installed there from asking for approval a second time.

## Pause instead of waiting

Use pause mode:

```python
approvals = ApprovalHooks("https://approvals.example.com/api/aap", token, mode="async")
options = approvals.options(ClaudeAgentOptions(mcp_servers=servers))
```

When a call waits for its decision, the run ends with a result whose `stop_reason` is `"tool_deferred"`.

Give the [receiver](overview.md#resume-paused-runs) a Claude Agent SDK resumer, on the machine that stores the session:

```python
from agentapprovalprotocol.claude_agent_sdk import resumer

resumers = {"claude-agent-sdk": resumer(options, on_message=handle_message)}
```

When the decision arrives, the session resumes in the receiver's process. `on_message` receives the resumed run's messages. Resuming the session any other way cannot approve a call: the provider is asked again.

Pause mode answers permission prompts itself. It cannot be combined with `permission_prompt_tool_name`.

## Sub-agents

Subagent calls are covered. They wait for their decision instead of pausing. In pause mode, a second call in the same turn also waits.

## Limitations

- **User settings:** If you set `setting_sources` to include `"user"` and the Claude Code approval hook is installed there, every call is sent for approval twice. Leave user settings out, or [remove the Claude Code adapter](../adapters/claude-code.md#uninstall) on that machine.
- **Tools the Claude API runs itself:** Tools such as the advisor never reach the hooks, so they are not sent for approval. Leave them out if they need approval.
- **Hooks that change tool input:** Do not add other `PreToolUse` hooks that change tool input. The provider approves the input it was sent.

## Test without a provider

Pass a gate built on [`FakeProvider`](overview.md#test-without-a-provider):

```python
from agentapprovalprotocol import AsyncGate
from agentapprovalprotocol.testing import FakeProvider

provider = FakeProvider()
approvals = ApprovalHooks(gate=AsyncGate(provider.async_client()))
```
