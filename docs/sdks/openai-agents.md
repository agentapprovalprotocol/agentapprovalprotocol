---
lastModified: 2026-10-12
---

# OpenAI Agents SDK

Send every tool call of an OpenAI Agents SDK agent to your approval provider before it runs, including its handoffs and agents used as tools.

## Install

```sh
pip install "agentapprovalprotocol[openai-agents]"
```

This extra cannot be installed alongside the [CrewAI](crewai.md) extra, because the two frameworks need different major versions of `openai`. Use separate environments if you need both.

## Set up

Call `protect` once the agent is fully configured:

```python
import os
from agents import Agent, Runner
from agentapprovalprotocol.openai_agents import Approvals

approvals = Approvals("https://approvals.example.com/api/aap", os.environ["AAP_INSTANCE_TOKEN"])
agent = approvals.protect(Agent(name="Support", tools=tools, handoffs=handoffs))
result = await Runner.run(agent, "Refund the duplicate charge")
```

`protect` covers the agent's tools, its local MCP servers, its handoff targets and agents it uses as tools. Each call waits for the decision. A denied call returns the reason to the model as the tool result.

Do not add tools to any of these agents after calling `protect`.

## Pause instead of waiting

Use pause mode with `save` and `load` functions that keep each run's state on your server:

```python
approvals = Approvals(
    "https://approvals.example.com/api/aap",
    token,
    mode="async",
    save=save,  # save(run_id, state): store the state string
    load=load,  # load(run_id): return the stored string, or None
)
agent = approvals.protect(Agent(name="Support", tools=tools))
result = await approvals.run(agent, "Refund the duplicate charge", run_id=run_id)
```

In pause mode, start every run with `approvals.run` and a `run_id`, not `Runner.run`. Other keyword arguments are passed to `Runner.run`. While a call waits for its decision, the result has `interruptions` and the run's state is saved.

Give the [receiver](overview.md#resume-paused-runs) the resumer from `approvals`:

```python
resumers = {"openai-agents": approvals.resumer(agent)}
```

When the decision arrives, the run continues in the receiver's process and its new state is saved. Read the result from the stored state.

Approving the run state any other way cannot run a call. Only a decision from the provider can.

## Sub-agents

Handoff targets and agents used as tools are covered when you protect the agent that reaches them.

## Limitations

- **Tools that run inside OpenAI's response:** `protect` refuses web search, file search, code interpreter and image generation, because their calls cannot be stopped. Remove them, or use a function tool.
- **Local shell, computer and apply patch tools:** `protect` refuses them. Wrap the action in a function tool instead.
- **Sandbox agents:** `protect` refuses them, because their sandbox tools cannot be gated.
- **Hosted MCP servers:** These are supported, but their calls always wait for the decision, even in pause mode.
- **Pre-approval guardrails:** Runs that set `pre_approval_tool_input_guardrails` are refused. Leave that setting off.
- **No `save` and `load`:** In pause mode, calls wait instead of pausing.

## Test without a provider

Pass a gate built on [`FakeProvider`](overview.md#test-without-a-provider):

```python
from agentapprovalprotocol import AsyncGate
from agentapprovalprotocol.testing import FakeProvider

provider = FakeProvider()
approvals = Approvals(gate=AsyncGate(provider.async_client()))
```
