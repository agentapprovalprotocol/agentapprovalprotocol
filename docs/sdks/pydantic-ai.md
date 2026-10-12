---
lastModified: 2026-10-12
---

# Pydantic AI

Send every tool call of a Pydantic AI agent to your approval provider before it runs, including MCP and other toolset tools.

## Install

```sh
pip install "agentapprovalprotocol[pydantic-ai]"
```

It needs Python 3.11 or later.

## Set up

Add `ApprovalCapability` to the agent's capabilities:

```python
import os
from pydantic_ai import Agent
from agentapprovalprotocol.pydantic_ai import ApprovalCapability

approvals = ApprovalCapability("https://approvals.example.com/api/aap", os.environ["AAP_INSTANCE_TOKEN"])
agent = Agent(model, tools=tools, capabilities=[approvals])
```

Every tool call the agent makes goes to your provider and waits for the decision. A denied call returns the reason to the model as a failed tool result.

## Pause instead of waiting

Use pause mode and add `DeferredToolRequests` to the agent's output type:

```python
from pydantic_ai import Agent, DeferredToolRequests

approvals = ApprovalCapability("https://approvals.example.com/api/aap", token, mode="async")
agent = Agent(model, tools=tools, output_type=[str, DeferredToolRequests], capabilities=[approvals])

result = await agent.run(prompt)
if isinstance(result.output, DeferredToolRequests):
    await save(result.conversation)
```

When a call waits for its decision, the run ends with `DeferredToolRequests`. Store `result.conversation` on your server.

Give the [receiver](overview.md#resume-paused-runs) a Pydantic AI resumer:

```python
from agentapprovalprotocol.pydantic_ai import resumer

resumers = {"pydantic-ai": resumer(agent, load=load, save=save)}
```

`load(conversation_id)` returns the saved conversation, or `None`. `save(conversation)` stores the resumed one. Either can be async. Other keyword arguments, such as `deps`, are passed to `agent.run`.

When the decision arrives, the conversation continues in the receiver's process and is passed to `save`. Continuing the conversation any other way cannot approve a call. The capability asks the provider again, and an approval with edited arguments is refused.

## Sub-agents

Add the same capability to every agent you run as a sub-agent. Calls inside a sub-agent wait for their decision instead of pausing.

## Limitations

- **Tools that run at the model provider:** Native tools, such as web search or code execution, cannot be sent for approval. A run that includes one stops with an error. Use a local tool instead.
- **No `DeferredToolRequests` in the output type:** In pause mode, calls wait instead of pausing. Add it to `output_type`.
- **Other deferred calls:** The resumer does not continue a conversation that also waits on calls of your own, such as external tools. Continue those conversations yourself.

## Test without a provider

Pass a gate built on [`FakeProvider`](overview.md#test-without-a-provider):

```python
from agentapprovalprotocol import AsyncGate
from agentapprovalprotocol.testing import FakeProvider

provider = FakeProvider()
approvals = ApprovalCapability(gate=AsyncGate(provider.async_client()))
```
