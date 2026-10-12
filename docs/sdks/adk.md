---
lastModified: 2026-10-12
---

# Google ADK

Send every tool call of a Google Agent Development Kit (ADK) app to your approval provider before it runs, from every agent in the app.

## Install

```sh
pip install "agentapprovalprotocol[adk]"
```

## Set up

Register `ApprovalPlugin` as the app's first plugin, then check coverage:

```python
import os
from google.adk.apps import App
from agentapprovalprotocol.adk import ApprovalPlugin, check_coverage

approvals = ApprovalPlugin("https://approvals.example.com/api/aap", os.environ["AAP_INSTANCE_TOKEN"])
app = App(name="support", root_agent=agent, plugins=[approvals])
check_coverage(app, approvals)
```

Every tool call goes to your provider and waits for the decision. A denied call returns the reason to the model as the tool result. A tool that asks for its own ADK confirmation is sent for approval after the user confirms it.

`check_coverage` raises an error for anything whose calls the plugin cannot see. Run it when you build the app.

## Pause instead of waiting

Use pause mode and make the app resumable:

```python
from google.adk.apps import App, ResumabilityConfig

approvals = ApprovalPlugin("https://approvals.example.com/api/aap", token, mode="async")
app = App(
    name="support",
    root_agent=agent,
    plugins=[approvals],
    resumability_config=ResumabilityConfig(is_resumable=True),
)
```

When a call waits for its decision, the run stops with an ADK tool confirmation. Use a persistent session service so the session survives a restart.

Give the [receiver](overview.md#resume-paused-runs) an ADK resumer for your runner:

```python
from agentapprovalprotocol.adk import resumer

resumers = {"adk": resumer(runner)}
```

When the decision arrives, the session continues in the receiver's process. Read the result from the session's events.

If the runner lives in another process, such as `adk api_server`, write your own resumer. Load the session and send `wake_message(session.events, request.id)` as the new message.

Answering the confirmation any other way cannot approve a call. The plugin asks the provider again, and an undecided call pauses again.

## Sub-agents

The plugin covers sub-agents and agents used as tools. Calls inside an agent used as a tool wait instead of pausing.

## Limitations

- **Plugin order:** Register the plugin first, and do not change tool arguments in later plugins or in `before_tool_callback`. `check_coverage` reports a plugin that is not first.
- **Code executors and remote agents:** Their calls cannot wait for approval. Remove code executors, and add an approval plugin to the remote agent's own server.
- **Agents used as tools without plugins:** Remove `include_plugins=False` from the `AgentTool`.
- **Gemini built-in tools:** Tools such as `google_search` run on Google's servers. The plugin stops a run that uses one. Use a function tool instead.
- **Calls that wait in pause mode:** Calls in an app that is not resumable, inside an agent used as a tool, in live (streaming audio or video) runs and in workflow tool nodes wait for their decision.

## Test without a provider

Pass a gate built on [`FakeProvider`](overview.md#test-without-a-provider):

```python
from agentapprovalprotocol import AsyncGate
from agentapprovalprotocol.testing import FakeProvider

provider = FakeProvider()
approvals = ApprovalPlugin(gate=AsyncGate(provider.async_client()))
```
