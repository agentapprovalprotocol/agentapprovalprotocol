# The approval flow

AAP separates proposing an action, deciding whether it is allowed and executing it. The adapter connects these steps at the point where a tool would run.

## From tool call to decision

1. The agent proposes a tool call through its harness.
2. The adapter captures the tool name and arguments before any side effects occur.
3. The adapter submits an approval request using its instance credential.
4. The provider records a decision, immediately or after review.
5. The adapter validates the result and either executes the approved call or reports why it did not run.

The provider does not execute the tool. The agent can receive the tool's result without knowing how approval was obtained.

## Instances and credentials

An instance identifies a particular running or installed agent. It can submit many approval requests over its lifetime.

A provisioner creates and manages instances. Each instance receives a credential that its adapter uses for approval requests. This keeps management access separate from the agent's approval traffic.

See [identity and authentication](../specification/3_identity.md) for the credential requirements.

## Choose how to wait

| Mode | How it works | Fits a harness that… |
| --- | --- | --- |
| Synchronous | The adapter keeps the call open and polls for a decision. | Can wait within the tool call's time limit. |
| Asynchronous | The adapter saves execution state, suspends work and resumes after a notification. | Can suspend and resume the same execution attempt. |

Both modes use the same request and decision objects. Start with synchronous mode when the harness can keep the call open long enough. Asynchronous mode also needs a durable receiver, signed webhook handling and coordination with suspended execution.

Read [synchronous mode](../specification/6_sync.md) and [asynchronous mode](../specification/7_async.md) for their complete contracts.

## Two different deadlines

`deadline_at` is the provider's deadline for reaching a decision. If it passes while the request is pending, the request becomes `expired`.

`decision.expires_at` is the deadline for starting an approved call. The adapter checks it immediately before execution. A request can still have an `approved` status after that permission has expired.

For example, a provider might have five minutes to review a refund, then grant two minutes to start it. Waiting for a decision and acting on that decision have different time limits.

## One approval, one attempt

Approval covers the submitted tool, its exact arguments and one execution attempt. Changing the arguments needs a new request. Retrying an HTTP request with the same idempotency key recovers the existing approval request; it does not grant another execution.

The adapter or harness tracks whether the tool has already run. An approval record alone cannot answer that question.

Read the normative [request lifecycle](../specification/4_requests.md) for the complete requirements.
