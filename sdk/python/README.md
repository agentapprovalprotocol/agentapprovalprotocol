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
