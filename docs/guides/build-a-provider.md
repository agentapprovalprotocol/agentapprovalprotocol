# Build a provider

An approval provider accepts proposed tool calls and records whether each attempt may run. It can use human review, policy evaluation or a combination of both.

## Start with the contract

Use the [OpenAPI contract](../../openapi.yaml) for operations, authentication, fields and response shapes. The [API reference](../specification/api_overview.md) presents that contract by resource.

Implement instance provisioning and management separately from approval requests. Provisioner tokens manage instances; instance credentials identify and authorize the adapter making requests.

## Store the request lifecycle

Keep the submitted tool and arguments immutable. Persist the request identity and idempotency record so a retry recovers the same request, and reject reuse of a key with different input.

Coordinate decisions, cancellation and deadline expiry so only one terminal outcome is recorded. Include a fixed `decision.expires_at` when approving a call and preserve it across subsequent reads and retries.

Long polling should return the current request when the wait ends, even if it is still pending. Follow the [HTTP conventions](../specification/5_http.md) for errors, rate limits and retention.

## Connect your review workflow

Present the exact proposed tool and arguments to your reviewer or policy engine. Keep agent reasoning clearly identified as a claim from the agent, and use the authenticated credential to determine instance identity.

AAP leaves reviewer interfaces, reviewer notifications and policy workflows to the provider. The adapter receives the same request and decision objects regardless of how you reach the outcome.

Read [requests and decisions](../specification/4_requests.md) for state transitions and approval semantics.

## Support asynchronous delivery

If you offer asynchronous mode, verify receiver consent before committing delivery configuration. Record notifications durably with terminal decisions, sign them and retain their identity and body across retries.

Receiver replacement and instance deletion also affect queued delivery. Implement those behaviors together with the request lifecycle and retention rules, using the [asynchronous specification](../specification/7_async.md).

## Verify conformance

Test isolation between instances, concurrent decisions and cancellation, deadline expiry, retries after lost responses and instance deletion. Check that every terminal request stays terminal and that an approval's execution window never changes on a later read.

Use the specification's [provider requirements](../specification/8_security.md#provider-requirements) and, where applicable, [asynchronous requirements](../specification/8_security.md#asynchronous-requirements) to check the implementation.
