---
lastModified: 2026-09-17
---

# Providers overview

An [approval provider](../concepts/provider.md) receives proposed tool calls from adapters and decides whether they may run. It can apply policies automatically, ask a person to review a request or combine several steps. The adapter enforces the returned decision before execution.

AAP defines the exchange between an adapter and a provider. Each provider chooses its own review interface, policies and deployment options. Multiple agent instances can share a provider, including agents running in different runtimes.

## Choose a provider

| Provider | Description |
| --- | --- |
| [withHuman](https://withhuman.ai) | Approval policies and human review for agent tool calls, with hosted and self-hosted deployments. |

When choosing a provider, consider where approval requests will be stored, who needs to review them and how you will manage instance credentials. Check that its supported approval modes match your adapter and runtime.

## Connect an adapter

1. Set up the provider and configure how requests should be reviewed.
2. Obtain a credential for each agent instance and the provider's complete AAP base URL, including any path prefix.
3. Follow the [adapter setup guide](../adapters/overview.md#install-an-adapter), then test a harmless call with both an approval and a denial.

The AAP CLI installs adapters using an existing instance token and base URL. Provider enrollment, reviewer routing and approval policies are configured separately. Follow your provider's documentation for setup.

## Implement a provider

You can build your own provider using the same protocol. Start with the [specification overview](../specification/1_overview.md), [API overview](../specification/api_overview.md) and [provider requirements](../specification/8_security.md#provider-requirements). Keep your review workflow and management APIs separate from the AAP exchange so adapters can connect without depending on those product choices.
