---
lastModified: 2026-09-16
---

# API reference overview

The AAP API connects an adapter to an approval provider over HTTP and JSON.
Use it to manage instances, submit proposed tool calls and retrieve approval decisions.
The adapter enforces each decision before the tool runs.

The endpoint and schema reference is generated from the [OpenAPI contract](../../openapi.yaml).
For protocol requirements and execution behavior, read the [specification](1_overview.md).

## Base URL

Use the AAP base URL supplied by your approval provider.
Provider API paths are relative to that URL and begin with `/v1`.
For example, a base URL of `https://approvals.example.com/api/aap` makes the request endpoint `https://approvals.example.com/api/aap/v1/requests`.

Use HTTPS outside local development and `Content-Type: application/json` for request bodies.
Responses return the resource directly.

## Authentication

Send a bearer token in the `Authorization` header.
The token you need depends on the operation:

| Credential | Used for |
| --- | --- |
| Provisioner token | Creating, retrieving, updating and deleting instances. |
| Instance credential | Creating, retrieving and cancelling approval requests for that instance. |

[Provisioning an instance](5_http.md#provision-an-instance) returns its instance credential.
The provider derives the instance identity from that credential when the adapter submits a request.

Provider-to-receiver webhooks use [signed delivery](7_async.md#signing) with a separate shared secret.
See [identity and authentication](3_identity.md) for the full credential model.

## Submit a tool call

With an instance credential, submit the tool name and its exact arguments for approval.
Choose a timeout that fits within the time the agent can wait.

```http
POST /v1/requests HTTP/1.1
Host: approvals.example.com
Authorization: Bearer <instance_credential>
Content-Type: application/json
Idempotency-Key: 4dc635f0-9423-4a98-99cc-33d2168fcbb2

{
  "tool": "issue_refund",
  "arguments": {
    "payment_id": "payment_123",
    "amount": 4900,
    "currency": "GBP"
  },
  "timeout": "30m"
}
```

This example uses `https://approvals.example.com` as the base URL.
A new request returns `201 Created` with its ID and current `status`.
The provider may already have recorded a terminal decision, so inspect the status before waiting.

## Receive a decision

Both execution modes use the same request and decision objects.

- In [synchronous mode](6_sync.md), keep the tool call open and retrieve the request with `GET /v1/requests/{id}?wait=30s`. A long poll can still return `pending`; continue waiting within the adapter's limit.
- In [asynchronous mode](7_async.md), configure a webhook receiver on the instance, suspend execution and resume when a verified notification arrives. Retrieve the request to obtain its authoritative state.

Only execute the approved call when its status is `approved` and the current time is before `decision.expires_at`.
The other terminal states, `denied`, `expired` and `cancelled`, do not permit execution.
See [requests and decisions](4_requests.md) for the complete lifecycle.

## Retries and errors

Creating an instance, updating an instance and creating an approval request require an `Idempotency-Key`.
Keep the same key and input when retrying an operation after a lost response.
For approval requests, use a new key for each distinct execution attempt.
Reusing a key with different input returns `409 Conflict`.

An HTTP error does not grant approval.
A denied request is a successful API exchange with `status` set to `denied`.
Error responses contain an `error` object with `type`, `code`, `message` and `request_id`.
The request ID identifies the HTTP exchange and matches the `X-Request-ID` response header.
Respect `Retry-After` when it is supplied, or stop waiting.

See [idempotency and retries](5_http.md#idempotency-and-retries) and [errors](5_http.md#errors) for retention rules, status codes and recovery behavior.
