# Identity and Authentication

## Identity

Every approval request is attributed to an instance.
An *instance* is a specific running or installed agent such as `codex-chris-laptop` or `claude-code-chris-desktop`.

Each instance may make many approval requests.

Prior to agent execution a provider assigns the instance an identity and the credentials associated with that instance.

## Credentials

Before an adapter can make requests it needs a credential.
A credential is an opaque bearer token bound to exactly one instance.

The adapter includes it in the `Authorization` header:

```http
Authorization: Bearer <instance_credential>
```

The provider derives the instance's identity from the credential.
The token's format is up to the provider.

The provider must reject an expired or revoked credential.
The adapter must not interpret a rejected credential as permission to run the tool.

## Provisioning

Every provider must support AAP's provisioning endpoint: `POST /v1/instances`.
Calling this endpoint with an appropriate provisioner token creates an instance and returns the credential that can be used to make approval requests as that instance.

Providers may also issue credentials through other paths, for example from a console or an interactive login.

This is useful for a platform that starts agent instances automatically.
Each instance can receive its own credential without a person creating it by hand.

A provisioner token permits instance creation, retrieval, updates and deletion within the scope assigned by the provider.
It cannot be used to make approval requests.
An instance credential cannot manage instances or their delivery configuration.

The provisioner can also configure [asynchronous delivery](7_async.md#delivery-configuration) for the instance.

## Updates and Deletion

The provisioner can read an instance, change its name or update its configuration.
The asynchronous section describes [updating and removing delivery](7_async.md#updating-and-removing-delivery).

Deleting an instance revokes its credentials, cancels its pending requests and stops notification delivery and retries.
Existing terminal outcomes remain unchanged.
Deletion does not stop a tool call that has already started.

Deletion must not race with creation of requests or configuration updates in a way that leaves pending requests, active credentials or a replacement receiver behind.
Request and idempotency records remain subject to the normal retention rules.

The operations are described in the [HTTP API](5_http.md#provision-an-instance).
The [OpenAPI schema](../../openapi.yaml) defines the instance and credential objects.
