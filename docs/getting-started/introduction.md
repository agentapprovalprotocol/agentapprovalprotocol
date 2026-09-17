---
lastModified: 2026-09-17
---

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
This gives you a centralized location to view all actions every agent has ever taken across all your infrastructure.

```mermaid
flowchart LR
    accTitle: Agents and teams share one AAP provider
    accDescr: A coding agent from provider A on a developer laptop, a support agent from provider B on an application server, and an operations agent from provider C on a cloud VM each connect through an AAP adapter to the same AAP provider. The adapters send approval requests and receive decisions. Security, developers and ops teams also connect to that provider to review requests and manage approval policies.

    subgraph Laptop[Developer laptop]
        Coding["Coding agent<br/>Agent provider A"] --> LaptopAdapter[AAP adapter]
    end

    subgraph Server[Application server]
        Support["Support agent<br/>Agent provider B"] --> ServerAdapter[AAP adapter]
    end

    subgraph Cloud[Cloud VM]
        Operations["Operations agent<br/>Agent provider C"] --> CloudAdapter[AAP adapter]
    end

    LaptopAdapter <-->|AAP| Provider[One AAP provider]
    ServerAdapter <-->|AAP| Provider
    CloudAdapter <-->|AAP| Provider

    Provider <--> Security(Security team)
    Provider <--> Developers(Developers)
    Provider <--> Ops(Ops team)
```

Agents from different providers can run on separate machines and share one AAP provider. Each agent's adapter sends approval requests to that provider and enforces the returned decisions.
Security, developer and ops teams can use the same provider to review requests and manage approval policies.

## Getting started

Choose an [approval provider](../providers/overview.md), then install the AAP binary on the machine running your agent:

```sh
curl -fsSL https://downloads.agentapprovalprotocol.io/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
aap adapters
```

Obtain your instance token and complete AAP base URL from the provider. Follow the [adapter setup guide](../adapters/cli.md#install-an-adapter) to connect your runtime and test both approval and denial.

Read [the approval flow](../concepts/approval-flow.md) to understand identities, outcomes and execution modes.

## Read the specification

These docs explain how to work with AAP. The [specification](../specification/1_overview.md) defines version 1's protocol requirements, and the [OpenAPI contract](../../openapi.yaml) defines its HTTP operations and data types.

Use the Specification tab for the complete protocol and API reference.
