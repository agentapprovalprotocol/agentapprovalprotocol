# What is Agent Approval Protocol (AAP)?

Agent Approval Protocol (AAP) is an open protocol for approving agent action, primarily tool calls. It connects the system running an agent to an approval provider, so a proposed action can be reviewed before it happens.

For example, an agent helping a customer may propose a refund. An adapter intercepts that tool call and sends the exact payment and amount to an approval provider. The adapter waits for the outcome and only allows the refund when it has a valid approval.

## How it works

AAP is very simple and has 3 main parts.

| Part | Responsibility |
| --- | --- |
| Agent | Proposes a tool call through its harness. |
| Adapter | Intercepts the call, requests approval and enforces the outcome. |
| Approval provider | Reviews the proposed call and records a decision. |

```mermaid
flowchart LR
    Agent -->|Tool call| Adapter
    Adapter -->|Approval request| Provider[Approval provider]
    Provider -->|Decision| Adapter
    Adapter -->|Approved call| Tool
```

The provider can ask a human, apply a policy or combine several steps. AAP defines how adapter and providers must behave and the information exchange between them.

## When to use AAP

Use AAP when an agent can propose actions that need approval before execution, such as issuing a refund, changing production settings or sending a message on someone's behalf.
If you have agents taking consequential actions, then AAP can likely offer you something.

## What are the benefits of using AAP

There are a few benefits of using AAP.
1. Like any open standard, AAP allows you to plug components in easily. Any harness implementing AAP can use any approval provider and any approval provider implementing AAP will work with any harness that implements it.
2. A centralized provider. AAP is designed to allow many agents to connect to a single approval provider. This allows you to centralize approvals, auditing and permissions in a single place, rather than across every agent provider.
3. Ecosystem support, AAP is open source and adapters have already been written for a number of different harnesses with more support being added frequently.

## How should I use AAP

The most common use case is to run the tool calls of all agents through your AAP provider, and have the provider automatically approve benign requests whilst holding riskier ones for approval.
This gives you a centralized location to view all actions every agent has ever taken across all your infrastucture.

## Start building

- Follow the [quickstart](quickstart.md) to submit a request and retrieve a decision.
- Read [the approval flow](../concepts/approval-flow.md) to understand identities, outcomes and execution modes.
- [Build an adapter](../guides/build-an-adapter.md) to connect an agent harness.
- [Build a provider](../guides/build-a-provider.md) to supply approval decisions.

## Read the specification

These docs explain how to work with AAP. The [specification](../specification/1_overview.md) defines version 1's protocol requirements, and the [OpenAPI contract](../../openapi.yaml) defines its HTTP operations and data types.

Use the Specification tab for the complete protocol and API reference.
