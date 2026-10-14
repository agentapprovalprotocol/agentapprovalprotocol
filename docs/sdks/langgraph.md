---
lastModified: 2026-10-14
---

# LangGraph and Deep Agents

Send every tool call of a LangChain, LangGraph or Deep Agents agent to your approval provider before it runs.

## Install

```sh
pip install "agentapprovalprotocol[langgraph]"
```

For Deep Agents, which needs Python 3.11 or later, install the `deep-agents` extra instead:

```sh
pip install "agentapprovalprotocol[deep-agents]"
```

## Set up

Add `ApprovalMiddleware` to the agent:

```python
import os
from langchain.agents import create_agent
from agentapprovalprotocol.langgraph import ApprovalMiddleware

approvals = ApprovalMiddleware("https://approvals.example.com/api/aap", os.environ["AAP_INSTANCE_TOKEN"])
agent = create_agent(model, tools=tools, middleware=[approvals])
```

Every tool call the agent makes goes to your provider and waits for the decision. A denied call returns the reason to the model as an error tool result.

List `approvals` after any middleware that changes tool arguments, so the provider approves the arguments that will run.

## Deep Agents

Deep Agents does not pass your middleware to subagents. Build the subagents with `deep_agent_subagents`, which adds approvals to each one and to the default general-purpose subagent:

```python
from deepagents import create_deep_agent
from agentapprovalprotocol.langgraph import deep_agent_subagents

agent = create_deep_agent(
    model=model,
    tools=tools,
    middleware=[approvals],
    subagents=deep_agent_subagents(approvals, my_subagents),
)
```

## Pause instead of waiting

Use pause mode with a checkpointer, and run each conversation on a thread:

```python
approvals = ApprovalMiddleware("https://approvals.example.com/api/aap", token, mode="async")
agent = create_agent(model, tools=tools, middleware=[approvals], checkpointer=checkpointer)

config = {"configurable": {"thread_id": thread_id}}
result = agent.invoke({"messages": messages}, config)
```

While a call waits for its decision, the result holds an `__interrupt__` entry and the run stops. Use a persistent checkpointer so the thread survives a restart.

Give the [receiver](overview.md#resume-paused-runs) a LangGraph resumer:

```python
from agentapprovalprotocol.langgraph import resumer

resumers = {"langgraph": resumer(agent)}
```

When the decision arrives, the thread continues in the receiver's process. Read the result from the thread's state with `agent.get_state(config)`.

On LangSmith Deployment, serve the receiver from a custom route and use `deployment_resumer(get_client())` instead. `get_client` comes from `langgraph_sdk`.

Resuming the thread any other way, such as with `Command(resume=...)`, cannot approve a call. The middleware asks the provider again, and an undecided call pauses again.

## Sub-agents

Add the same `ApprovalMiddleware` instance to every agent you run as a sub-agent. For Deep Agents, use `deep_agent_subagents` as shown above.

## Limitations

- **Compiled or remote Deep Agents subagents:** `deep_agent_subagents` refuses subagents that run their own graph. Add `ApprovalMiddleware` to those graphs yourself.
- **No checkpointer or thread ID:** In pause mode, calls wait instead of pausing. Pass a checkpointer and a `thread_id`.
- **Sub-agent calls:** A sub-agent's tool calls cannot pause the run. Each one waits for its decision while the run stays open. Decide them within the [wait limit](overview.md#wait-or-pause).
- **Middleware that changes arguments:** Middleware listed after `approvals` can change arguments after they were approved. List it before `approvals`.

## Test without a provider

Pass gates built on [`FakeProvider`](overview.md#test-without-a-provider):

```python
from agentapprovalprotocol import AsyncGate, Gate
from agentapprovalprotocol.testing import FakeProvider

provider = FakeProvider()
approvals = ApprovalMiddleware(gate=Gate(provider.client()), async_gate=AsyncGate(provider.async_client()))
```
