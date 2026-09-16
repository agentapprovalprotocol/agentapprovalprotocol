# Structure

This specification explains what AAP is, what an approval means and how an adapter asks for one.
It then describes how the agent waits for the result.

This specification defines version 1 of the Agent Approval Protocol (AAP).
Open questions are marked in the relevant sections.

1. [Overview](1_overview.md): what the protocol is for, its design goals and the basic tool call flow.
2. [Architecture and modes](2_architecture.md): the agent, adapter and provider, and how synchronous and asynchronous execution differ.
3. [Identity and authentication](3_identity.md): instances, credentials, provisioning and instance management.
4. [Requests and decisions](4_requests.md): what is submitted for approval, the possible outcomes and the lifecycle of a request.
5. [HTTP API](5_http.md): approval operations, instance management, shared HTTP conventions, errors and retries.
6. [Synchronous mode](6_sync.md): holding a tool call open whilst the adapter polls for a decision.
7. [Asynchronous mode](7_async.md): delivery configuration, receiver registration, signed webhook notifications and resuming execution.
8. [Security and conformance](8_security.md): the trust boundaries and the requirements an implementation must meet.

The request and decision model is shared by both modes.
The [OpenAPI schema](../../openapi.yaml) defines the objects, field types and HTTP operations.
The HTTP API section explains how to use that contract.
The mode sections explain how to use it.

Guides, SDK documentation and provider-specific setup belong outside this specification.

When a field or wire format changes, update the OpenAPI schema first and keep the examples aligned with it.
Run `make api-lint` from the repository root to validate the schema and its examples.
