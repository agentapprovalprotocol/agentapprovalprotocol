# Agent Approval Protocol for Python

Put an AI agent's tool calls behind an [AAP](https://agentapprovalprotocol.io) approval provider. Each call waits for the provider's decision, runs only if approved, and runs at most once.

```sh
pip install agentapprovalprotocol
```

## Check a tool call

```python
from agentapprovalprotocol import Call, Client, Gate

gate = Gate(Client("https://approvals.example.com/api/aap", token))

with gate.guard(Call(key=f"{run_id}:{tool_call.id}", tool=tool_call.name, arguments=tool_call.args)) as verdict:
    if verdict:
        result = run_tool(tool_call)
    else:
        result = verdict.reason  # return this to the model as the tool result
```

`key` must identify the tool call within its run, and stay the same if the call is seen again after a retry or resume. `guard` reports whether the tool succeeded when the block exits.

`AsyncGate` and `AsyncClient` provide the same API for `asyncio`.

## Pause instead of waiting

With `mode="async"`, `check` returns `Pending` when there is no decision yet, so the run can pause and the process can exit. Mount a `Receiver` where the provider can reach it. When a decision arrives it wakes the run, and the gate checks the decision again before anything runs.

Framework integrations handle pausing and resuming for you.

## LangChain, LangGraph and Deep Agents

```sh
pip install "agentapprovalprotocol[langgraph]"
```

```python
from agentapprovalprotocol.langgraph import ApprovalMiddleware

approvals = ApprovalMiddleware("https://approvals.example.com/api/aap", token)
agent = create_agent(model, tools=tools, middleware=[approvals])
```

Every tool call the agent makes goes to the provider. A denied call returns the reason to the model as the tool result.

For Deep Agents, also add the middleware to every subagent:

```python
from agentapprovalprotocol.langgraph import deep_agent_subagents

agent = create_deep_agent(model, tools=tools, middleware=[approvals], subagents=deep_agent_subagents(approvals, my_subagents))
```

To pause instead of waiting, use `ApprovalMiddleware(..., mode="async")` with a checkpointer, and mount a `Receiver` with `resumers={"langgraph": resumer(agent)}`. On LangSmith Deployment, use `deployment_resumer(get_client())` in a custom route instead. Resuming a thread any other way cannot approve a call: the middleware asks the provider again.

## Pydantic AI

```sh
pip install "agentapprovalprotocol[pydantic-ai]"
```

Needs Python 3.11 or later.

```python
from agentapprovalprotocol.pydantic_ai import ApprovalCapability

approvals = ApprovalCapability("https://approvals.example.com/api/aap", token)
agent = Agent(model, tools=tools, capabilities=[approvals])
```

Every tool call the agent makes goes to the provider, including MCP and other toolset tools. A denied call returns the reason to the model as a failed tool result. Add the same capability to every agent you run as a sub-agent.

Tools that run at the model provider, such as native web search or code execution, cannot be sent for approval. A run that includes one stops with an error. Use a local tool instead.

To pause instead of waiting, use `ApprovalCapability(..., mode="async")` and add `DeferredToolRequests` to the agent's `output_type`. When a run ends with `DeferredToolRequests`, save `result.conversation`. Mount a `Receiver` with `resumers={"pydantic-ai": resumer(agent, load=load, save=save)}`, where `load(conversation_id)` returns the saved conversation and `save(conversation)` stores the resumed one. Calls inside a sub-agent wait instead of pausing. Continuing a conversation any other way cannot approve a call: the capability asks the provider again, and an approval with edited arguments is refused.

## Google Agent Development Kit

```sh
pip install "agentapprovalprotocol[adk]"
```

```python
from agentapprovalprotocol.adk import ApprovalPlugin, check_coverage

approvals = ApprovalPlugin("https://approvals.example.com/api/aap", token)
app = App(name="support", root_agent=agent, plugins=[approvals])
check_coverage(app, approvals)
```

Every tool call from every agent in the app goes to the provider, including sub-agents and agents used as tools. A denied call returns the reason to the model as the tool result. Register the plugin first, and don't change tool arguments in later plugins or `before_tool_callback`.

`check_coverage` raises an error for agents whose calls the plugin cannot see: code executors, remote agents, and agents used as tools with `include_plugins=False`. Gemini built-in tools such as `google_search` run on Google's servers, so the plugin stops the run when an agent uses one.

To pause instead of waiting, use `ApprovalPlugin(..., mode="async")`, set `resumability_config=ResumabilityConfig(is_resumable=True)` on the app, and mount a `Receiver` with `resumers={"adk": resumer(runner)}`. Calls inside an agent used as a tool, and calls in live (streaming audio or video) runs, wait instead of pausing. For a runner in another process, such as `adk api_server`, send `wake_message(session.events, request.id)` as the new message from your own resumer. Answering the confirmation any other way cannot approve a call: the plugin asks the provider again.

## OpenAI Agents SDK

```sh
pip install "agentapprovalprotocol[openai-agents]"
```

```python
from agentapprovalprotocol.openai_agents import Approvals

approvals = Approvals("https://approvals.example.com/api/aap", token)
agent = approvals.protect(Agent(name="Support", tools=tools, handoffs=handoffs))
result = await Runner.run(agent, "Refund the duplicate charge")
```

`protect` covers the agent's tools, its local MCP servers, its handoff targets and agents it uses as tools. Call it after the agent is fully configured. A denied call returns the reason to the model as the tool result.

`protect` refuses tools that run inside OpenAI's response, such as web search, file search and code interpreter, because their calls cannot be stopped. It also refuses local shell, computer and apply patch tools: wrap the action in a function tool instead. Hosted MCP servers are supported, and their calls always wait for the decision.

To pause instead of waiting, use `Approvals(..., mode="async", save=save, load=load)`, where `save(run_id, state)` and `load(run_id)` keep each run's state on your server. Start runs with `await approvals.run(agent, input, run_id=run_id)` and mount a `Receiver` with `resumers={"openai-agents": approvals.resumer(agent)}`. Approving the run state any other way cannot run a call: only a decision from the provider can.

## Claude Agent SDK

```sh
pip install "agentapprovalprotocol[claude-agent-sdk]"
```

```python
from agentapprovalprotocol.claude_agent_sdk import ApprovalHooks

approvals = ApprovalHooks("https://approvals.example.com/api/aap", token)
options = approvals.options(ClaudeAgentOptions(mcp_servers=servers))
async for message in query(prompt=prompt, options=options):
    ...
```

Every tool call the agent makes goes to the provider, including built-in tools, MCP tools and calls made by subagents. A denied call returns the reason to the model.

`options()` does not load your user settings (`~/.claude/settings.json`) unless you set `setting_sources` yourself. If the Claude Code approval hook is installed there, loading them asks for approval twice for every call.

To pause instead of waiting, use `ApprovalHooks(..., mode="async")`. A call without a decision ends the run with `stop_reason="tool_deferred"`. Mount a `Receiver` with `resumers={"claude-agent-sdk": resumer(options)}` on the machine that stores the session, and it resumes the session when the decision arrives. Calls made by subagents, and a second call in the same turn, wait for their decision instead of pausing.

Tools that the Claude API runs itself, such as the advisor, never reach the hooks, so they are not sent for approval.

## CrewAI

CrewAI and the OpenAI Agents SDK need different major versions of `openai`, so the `crewai` and `openai-agents` extras can't be installed together.

```sh
pip install "agentapprovalprotocol[crewai]"
```

CrewAI supports Python 3.10 to 3.13.

```python
from agentapprovalprotocol.crewai import ApprovalHooks

ApprovalHooks("https://approvals.example.com/api/aap", token).install()
crew.kickoff()
```

Every tool call any crew, agent or flow in the process makes goes to the provider, including delegation to coworkers. A denied call returns the reason to the model as the tool result.

CrewAI cannot pause a run at a tool call, so each call waits for the decision. In `akickoff` the wait blocks the event loop.

Limitations:

- Register any hook that changes tool arguments before `install()`. A hook registered later, including one from a `@CrewBase` crew, runs after the approval. If it changes the arguments, the call is reported to the provider as failed.
- Models with `builtin_tools` run those tools at the model provider, where they cannot be checked. Runs that use such a model stop with an error.
- Tools you run yourself with `llm.call(available_functions=...)` are not checked.
