# Quickstart

This walkthrough submits a proposed tool call to an AAP provider and retrieves its decision. It uses synchronous polling and does not execute the tool.

## Before you start

You need an AAP provider's base URL and an instance credential. Obtain these from your provider or have a provisioner [create an instance](../specification/5_http.md#provision-an-instance). A provisioner token manages instances; an instance credential submits approval requests.

Set these values in your local environment, using your actual provider URL and credential. The URL below is a placeholder.

```sh
export AAP_BASE_URL="https://approvals.example.com"
export AAP_INSTANCE_CREDENTIAL="<instance_credential>"
```

Keep the credential private and out of source control and logs. Use HTTPS outside local development.

## Submit a proposed call

Create an idempotency key for this execution attempt. Keep the key if you need to retry after a lost response; create a new one for a different attempt.

```sh
export AAP_REQUEST_KEY="$(uuidgen)"

curl --fail-with-body --request POST "$AAP_BASE_URL/v1/requests" \
  --header "Authorization: Bearer $AAP_INSTANCE_CREDENTIAL" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: $AAP_REQUEST_KEY" \
  --data '{
    "tool": "issue_refund",
    "arguments": {
      "payment_id": "payment_123",
      "amount": 4900,
      "currency": "GBP"
    },
    "timeout": "5m"
  }'
```

A new request returns `201 Created` and an approval request object. Save its `id` and inspect its `status`. The provider may return a decision immediately, so it is not always necessary to poll.

In an integration, the tool and arguments come from the intercepted call. The approval request itself never issues the refund.

## Wait for the outcome

If the request is `pending`, set the returned ID and retrieve the request:

```sh
export AAP_REQUEST_ID="<id_from_the_response>"

curl --fail-with-body \
  "$AAP_BASE_URL/v1/requests/$AAP_REQUEST_ID?wait=30s" \
  --header "Authorization: Bearer $AAP_INSTANCE_CREDENTIAL"
```

The provider can hold this read open for up to 30 seconds. If the response is still `pending`, repeat the read within your waiting limit. A poll does not create a request or extend its deadline.

The provider's own review workflow determines when and how the decision is made. AAP does not define an endpoint for a reviewer to approve a request.

## Interpret the result

| Status | What to do |
| --- | --- |
| `pending` | Continue waiting within the harness's limit. |
| `approved` | Validate the decision and check `decision.expires_at` immediately before execution. |
| `denied` | Report that the call was denied. |
| `expired` | Report that the approval window ended without a decision. |
| `cancelled` | Report that the request was withdrawn. |

Only a valid approval permits the exact submitted call to start, and only before `decision.expires_at`. An HTTP error, an invalid response or a timeout does not grant permission. Receiving the same approval again does not authorize a second execution.

If you abandon the attempt while the request is pending, attempt to cancel it:

```sh
curl --fail-with-body --request DELETE \
  "$AAP_BASE_URL/v1/requests/$AAP_REQUEST_ID" \
  --header "Authorization: Bearer $AAP_INSTANCE_CREDENTIAL"
```

## Next steps

Follow [Build an adapter](../guides/build-an-adapter.md) to enforce these outcomes in a harness. Read [synchronous mode](../specification/6_sync.md) for the complete flow, or the [API reference](../specification/api_overview.md) for authentication, errors and operation details.
