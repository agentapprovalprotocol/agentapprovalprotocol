# Build an adapter

An adapter connects an agent harness to an AAP provider. Its most important job is to enforce a decision before a tool causes side effects.

## Find the execution boundary

Choose a harness hook or tool wrapper that can pause execution before the tool runs. Capture the actual tool name and arguments there, and keep them unchanged through review and execution.

Check whether other tools or credentials can reach the same operation. AAP can only govern the paths the adapter controls. The specification explains this in [enforcement limits](../specification/8_security.md#enforcement-limits).

## Keep an attempt record

Associate the intercepted call with its idempotency key, approval request ID and execution state. Use the same key and payload when recovering a lost create response.

Keep enough state to distinguish a call waiting for approval from one that has already started. Repeated reads, retries or webhook notifications should all resolve to the same execution attempt.

See [idempotency and retries](../specification/5_http.md#idempotency-and-retries) for the full rules.

## Start with synchronous polling

Submit the call using the instance credential and choose an approval timeout that fits within the harness's waiting limit. Inspect the create response for an immediate decision. If it is pending, use long polling to retrieve the same request until it reaches a terminal outcome or the adapter stops waiting.

Immediately before starting the tool, validate the returned request and decision, confirm that the status is `approved`, and check that the current time is before `decision.expires_at`. Execute only the captured call, once.

Return an explanation for denied, expired or cancelled requests. If no valid decision can be obtained, report that failure without attributing it to a human denial. Attempt to cancel a pending request when execution is abandoned.

The [quickstart](../getting-started/quickstart.md) shows the HTTP exchange. The [synchronous specification](../specification/6_sync.md) defines waiting limits and interruption behavior.

## Add asynchronous execution when needed

If the harness supports suspension, coordinate saved execution state with a receiving service. Have the provisioner configure and verify that receiver before using asynchronous delivery.

The receiver verifies signatures and expected registrations, durably accepts notifications and handles duplicates. Treat a notification as a prompt to fetch the request through the authenticated API. Check the authoritative decision and approval expiry before resuming the tool.

Plan for a notification arriving before suspension finishes, or after execution has been abandoned. The [asynchronous specification](../specification/7_async.md) covers these races, delivery retries and signature verification.

## Verify the integration

Exercise immediate approval, approval after polling, denial, expiry and cancellation. Also try a lost create response, repeated delivery of the same approval, changed arguments and an approval whose execution window has passed.

In each case, inspect whether the tool actually ran and how many times it ran. A correct approval response is only useful when the execution boundary enforces it.

Use the specification's [adapter requirements](../specification/8_security.md#adapter-requirements) as the conformance checklist.
