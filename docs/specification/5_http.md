---
lastModified: 2026-09-16
---

# HTTP API

AAP uses HTTP and JSON to exchange approval requests and decisions.
The [OpenAPI schema](../../openapi.yaml) defines the wire contract for AAP version 1.
It is the source of truth for objects, field types, required fields and HTTP operations.
This section explains the behavior and shows example exchanges.

## Base URL

The adapter is configured with the provider's AAP base URL.
The paths in this specification are relative to that URL.

For example, with a base URL of `https://approvals.example.com/api/aap`, creating a request uses `https://approvals.example.com/api/aap/v1/requests`.

Connections must use HTTPS outside local development.

## Conventions

Request and response bodies use `application/json`.
Protocol field names use lowercase snake_case.
Keys inside tool arguments and runtime context retain their original spelling.

Request IDs are UUIDs.
Timestamps are UTC RFC 3339 strings, such as `2026-09-16T12:00:00Z`.
Durations are positive whole numbers with a unit, such as `30s`, `30m` or `24h`.
The schema defines their accepted format.

Protocol objects reject unknown fields.
Tool arguments and runtime context are extensible objects whose contents are defined by the tool and adapter.

All approval operations require an instance credential in the `Authorization` header.
Instance creation, retrieval, updates and deletion use a provisioner token instead.

Responses return the resource directly.
Errors use the format defined below.

## Create a Request

`POST /v1/requests`

The body is a `CreateApprovalRequest`, defined in the [OpenAPI schema](../../openapi.yaml).
An `Idempotency-Key` header is required.

```http
POST /v1/requests HTTP/1.1
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

A new request returns `201 Created` with the request resource:

```json
{
  "id": "7ab8c8ec-7b2d-4fd6-9b52-752f9515eb71",
  "tool": "issue_refund",
  "arguments": {
    "payment_id": "payment_123",
    "amount": 4900,
    "currency": "GBP"
  },
  "timeout": "30m",
  "status": "pending",
  "created_at": "2026-09-16T12:00:00Z",
  "deadline_at": "2026-09-16T12:30:00Z"
}
```

The provider may return a terminal request if it has already recorded a decision.
The adapter must inspect `status` before deciding whether to poll.

## Retrieve a Request

`GET /v1/requests/{id}`

The provider returns `200 OK` with the current request resource.
If it is terminal, the resource includes its decision.

The adapter can request a long poll using `wait`:

```http
GET /v1/requests/7ab8c8ec-7b2d-4fd6-9b52-752f9515eb71?wait=30s HTTP/1.1
Authorization: Bearer <instance_credential>
```

The provider holds the response until the request becomes terminal or the wait ends, whichever happens first.
The maximum wait is 30 seconds.
Larger values are capped at 30 seconds.
Omitting `wait` returns the current state immediately.

When a wait ends without a decision, the provider returns `200 OK` with `status` still set to `pending`.

A terminal response to the example above could be:

```json
{
  "id": "7ab8c8ec-7b2d-4fd6-9b52-752f9515eb71",
  "tool": "issue_refund",
  "arguments": {
    "payment_id": "payment_123",
    "amount": 4900,
    "currency": "GBP"
  },
  "timeout": "30m",
  "status": "approved",
  "created_at": "2026-09-16T12:00:00Z",
  "deadline_at": "2026-09-16T12:30:00Z",
  "decision": {
    "status": "approved",
    "note": "The duplicate charge has been confirmed.",
    "decided_at": "2026-09-16T12:02:00Z",
    "expires_at": "2026-09-16T12:07:00Z"
  }
}
```

The adapter must start the approved call before `decision.expires_at`.
Retrieving an approved request after that time does not renew permission to execute it.

## Cancel a Request

`DELETE /v1/requests/{id}`
A successful cancellation returns `200 OK` with the request in the `cancelled` state.
Cancelling it again returns the same cancelled request.

If the request is already approved, denied or expired, the provider returns `409 Conflict` with code `already_terminal`.
The recorded outcome is unchanged.

Cancellation ends any long polls waiting for a decision on that request.
Those polls return the cancelled resource.

## Provision an Instance

`POST /v1/instances`

It accepts a provisioner token and a `ProvisionInstanceRequest`.
It returns `201 Created` with a `ProvisionInstanceResponse` containing the instance and its credential.
These objects are defined in the [OpenAPI schema](../../openapi.yaml).

The caller can supply `instance_name` to give the instance a recognisable name.
The provider owns the instance's canonical identity.

The caller can also supply `delivery` for asynchronous mode.
The asynchronous section defines [delivery configuration](7_async.md#delivery-configuration) and includes a [registration example](7_async.md#registration-example).

When `delivery` is supplied, the provider must complete [receiver verification](7_async.md#receiver-verification) before creating the instance or issuing its credential.
If verification fails, it returns `422 Unprocessable Content` with code `webhook_verification_failed` and creates no instance.
Malformed or unsafe URLs return `400 Bad Request` with code `invalid_webhook_url`.
A provider that does not support the requested delivery type returns `400 Bad Request` with code `unsupported_delivery_type`.

Omitting `delivery` creates an instance without notifications.
The response includes the verified type, URL and registration ID when configured, but never the signing secret.

An `Idempotency-Key` header is required.
Repeating the same submission with the same key returns `200 OK` with the original instance and credential.
It does not create another instance or renew the credential.
It does not repeat successful receiver verification.
If the original instance has been deleted, a replay returns `409 Conflict` with code `instance_deleted` and does not recreate it.
For this operation, keys are scoped to the provisioner and operation.
Reusing a key with different input returns `409 Conflict` with code `idempotency_conflict`.

## Retrieve an Instance

`GET /v1/instances/{id}`

The provider returns `200 OK` with the current `Instance` within the provisioner token's scope.
It does not return credentials or signing secrets.
A deleted instance returns `404 Not Found`.

## Update an Instance

`PATCH /v1/instances/{id}`

The body is an `UpdateInstanceRequest` containing `instance_name`, `delivery` or both.
Omitted fields are unchanged.
A supplied delivery object replaces the complete configuration, including its signing secret.
Setting `delivery` to `null` removes the receiver and ends outstanding delivery and retries.
The asynchronous section describes [updating and removing delivery](7_async.md#updating-and-removing-delivery).

The provider verifies a replacement configuration before committing any changes.
If verification fails, it returns `422` with code `webhook_verification_failed` and leaves the old configuration and name unchanged.
Removing delivery or changing only the name does not require verification.

An `Idempotency-Key` header is required, scoped to the provisioner, instance ID and operation.
The response is `200 OK` with the updated `Instance`, excluding the secret.
Repeating the same submission returns the original successful response without verifying or applying the update again.
This must not overwrite a later update.
Conflicting reuse returns `409` with code `idempotency_conflict`.
Updates and update replays against a deleted instance return `404`.

## Delete an Instance

`DELETE /v1/instances/{id}`

The provider revokes the instance's credentials, cancels every pending request and ends webhook delivery and retries.
Existing terminal requests remain unchanged.
These cancellations do not generate notifications because the receiving configuration is being retired too.
Attempts already in flight may still arrive.
The harness must treat its pending executions as abandoned when retiring the instance.

The response is `204 No Content`.
No idempotency key is required.
The provider retains a deletion record for at least seven days and returns `204` for repeated deletion whilst that record exists.
Unknown instance IDs return `404`.
The provisioner must be authorized for the instance on every operation, including retries.

Deleting an instance does not discard its request or idempotency records before their retention periods end.

## Idempotency and Retries

An idempotency key identifies one approval request for one execution attempt.
The adapter creates the key before submitting the request and retains it across retries.
Keys are scoped to the authenticated instance and operation.

Repeating a submission with the same key and the same fields returns the existing request in its current state.
The provider compares the parsed field values, so JSON whitespace and object key order do not change the request.
A replay returns `200 OK`, including when the request is already terminal.

Using the same key with different field values returns `409 Conflict` with code `idempotency_conflict`.
The provider must not change the original request.

A lost response is therefore recoverable by submitting the same request with the same key.
The adapter must not create a new key simply because a connection failed.

A distinct execution attempt requires a new key and a new approval request, even if its tool and arguments are identical.
Reusing a key does not permit repeating an already executed action.

Reads can be retried after a temporary failure.
Request creation can be retried with the original idempotency key.
Retries should use increasing delays and must fit within the adapter's waiting limit.
If the provider sends `Retry-After`, the adapter must respect it or stop waiting.

### Retention

Seven days means 168 hours.

The provider must retain an approval request and its idempotency key whilst the request is pending and for at least seven days after it becomes terminal.
The seven days start at `decision.decided_at`.
For a request with a notification, retention must also extend until at least 24 hours after delivery is acknowledged or retries end, whichever ends delivery.
The provider keeps the request, its creation idempotency key and notification until the later of these deadlines.
Retries end when the seven-day delivery window expires, delivery is removed or the instance is deleted.
An attempt still in flight must finish before the delivery grace period starts.
Requests without notifications use the ordinary seven-day minimum.
If the provider retains the request for longer, it must retain the associated key for the same period.

For instance provisioning, the provider must retain the key and original result for at least seven days after the instance is created.
This allows a retry to recover the same instance and credential.
For instance updates, the provider retains the key and original successful response for at least seven days after the update commits.

Failed receiver verification may be retried with the same key and unchanged input.
It does not count as a successful creation or update and must not prevent another verification attempt.
Concurrent submissions with the same key must not create parallel verification attempts or commit the operation twice.
Validation traffic remains subject to the provider's registration limits.

Retrying a submission does not extend its retention period.
Retaining an approved request does not extend the validity of its decision.
Retention does not keep a deleted instance's credentials valid.

Once the provider discards a key, reusing it may create a new request or instance, or apply an update again.
Callers must not rely on idempotent retries beyond the required retention period unless the provider guarantees a longer one.

## Errors

An HTTP error is not an approval decision.
A denial is a successful exchange that returns a request with `status` set to `denied`.

Errors use `ErrorResponse`, defined in the [OpenAPI schema](../../openapi.yaml).
For example:

```json
{
  "error": {
    "type": "conflict",
    "code": "idempotency_conflict",
    "message": "The idempotency key was already used for a different request.",
    "request_id": "1184dfc5-0e86-4f88-9b68-882b1dc60467"
  }
}
```

`request_id` identifies the HTTP exchange, rather than the approval request, and matches the response's `X-Request-ID` header.
Every response from the provider API includes that header.
Webhook receiver responses follow the [asynchronous contract](7_async.md) instead.

| HTTP status | Error type | Meaning |
| --- | --- | --- |
| `400` | `invalid_request` | The request is malformed or a field is invalid. |
| `401` | `authentication` | The credential is missing or invalid. |
| `403` | `authorization` | The credential does not permit the operation. |
| `404` | `not_found` | The requested resource is unavailable to the caller. |
| `409` | `conflict` | The operation conflicts with an existing request or its state. |
| `422` | `invalid_request` | The proposed webhook receiver failed verification. |
| `429` | `rate_limit` | The caller must reduce its request rate. |
| `500` | `internal` | The provider could not complete the operation. |
| `503` | `dependency` | The provider is temporarily unable to serve the operation. |

Error responses must not contain credentials, stack traces or other internal details.
