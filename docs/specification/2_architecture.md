---
lastModified: 2026-09-17
---

# Architecture and Modes

AAP has three parties: the agent, the adapter and the provider.

## Agent

The agent is the system that wants to call a tool.
A harness runs the agent and executes its tool calls.

The agent does not need to know how approval is obtained.
It makes a tool call and receives either the tool's result or an explanation of why the call did not run.
AAP is transparent to the agent.

## Adapter

The adapter sits between the agent and its tools.
It intercepts a tool call before execution and asks the provider whether it may run.

The adapter is responsible for enforcing the answer.
It must prevent the call from running until it has received approval for that call.

## Provider

The provider decides whether a call may run.
It records the request and returns the result to the adapter.

A decision may be immediate, for example when a policy approves the call automatically.
It may also require a human review and take much longer.

## Modes

AAP supports approvals that take hours or longer.
This is because approvals may involve a human review.
Humans can take a long time to respond to a request.
We all sleep.

Supporting this requirement lends itself to an asynchronous architecture.
The harness saves the pending tool call and suspends execution.
When a decision is available, it resumes execution and the adapter applies the result.

This means the agent process does not need to remain running whilst waiting for approval.
The pending call can also survive a process restart, provided the harness has saved enough state to resume it.

However, many existing harnesses expect a tool call to return its result before execution continues.
Supporting suspension and resumption requires work from harness creators.

As a result, AAP also supports a synchronous mode.
The adapter holds the tool call open, submits an approval request and polls the provider until a decision is available.

Both modes use the same [requests and decisions](4_requests.md).
They differ in how execution waits for the result.
