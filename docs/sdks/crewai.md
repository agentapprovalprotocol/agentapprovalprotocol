---
lastModified: 2026-10-12
---

# CrewAI

Send every tool call of your CrewAI crews, agents and flows to your approval provider before it runs, including delegation to coworkers.

## Install

```sh
pip install "agentapprovalprotocol[crewai]"
```

CrewAI supports Python 3.10 to 3.13. This extra cannot be installed alongside the [OpenAI Agents SDK](openai-agents.md) extra, because the two frameworks need different major versions of `openai`. Use separate environments if you need both.

## Set up

Install the hooks once, before running any crew:

```python
import os
from agentapprovalprotocol.crewai import ApprovalHooks

approvals = ApprovalHooks("https://approvals.example.com/api/aap", os.environ["AAP_INSTANCE_TOKEN"]).install()
crew.kickoff()
```

The hooks apply to every crew, agent and flow in the process. Each call waits for the decision. A denied call returns the reason to the model as the tool result.

To stop sending calls for approval, call `approvals.uninstall()`. You can also use `with ApprovalHooks(...):` to install the hooks for the length of the block.

## Waiting for decisions

CrewAI cannot pause a run at a tool call, so every call waits for its decision. In `akickoff` and other async runs, the wait blocks the event loop. Run crews that need long reviews in their own worker thread or process.

## Sub-agents

Calls from every agent are covered, including coworker delegation.

## Limitations

- **Hooks that change tool arguments:** Register them before `install()`. A hook registered later, including one from a `@CrewBase` crew, runs after the approval. If it changes the arguments, the call is reported to the provider as failed.
- **Models with `builtin_tools`:** These tools run at the model provider, where they cannot be checked. Runs that use such a model stop with an error. Remove `builtin_tools` from the LLM.
- **Tools you run yourself:** Tools run through `llm.call(available_functions=...)` are not checked. Check those calls with the [gate](overview.md#check-a-tool-call).

## Test without a provider

Pass a gate built on [`FakeProvider`](overview.md#test-without-a-provider):

```python
from agentapprovalprotocol import Gate
from agentapprovalprotocol.testing import FakeProvider

provider = FakeProvider()
ApprovalHooks(gate=Gate(provider.client())).install()
```
