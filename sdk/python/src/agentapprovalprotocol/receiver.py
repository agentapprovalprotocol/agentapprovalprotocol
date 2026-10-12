"""Webhook receiver for asynchronous mode.

The receiver verifies AAP webhooks, answers receiver verification during
provisioning, and wakes paused runs. A notification only wakes a run: the
gate fetches and consumes the decision itself, so the receiver keeps no
state and a repeated or forged event at most wakes a run that pauses again.

The resume handle is read from the request's ``context.resume``, which the
gate wrote when it created the request. Its ``framework`` names the resumer
to call.

Verification needs only the signing secret and the registration ID, so a
receiver can start before the instance exists. Waking a run needs a client
for the instance credential, which exists only after provisioning: pass a
client, a factory that builds one on first wake, or call ``provision``.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import inspect
import json
import logging
import secrets
import time
import uuid
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Mapping

import httpx

from ._client import MAX_RESPONSE, USER_AGENT, AAPError, AsyncClient, ProvisionError, WebhookVerificationFailed, validate_base_url
from ._wire import ProtocolError, Request, loads

log = logging.getLogger("agentapprovalprotocol")

Resumer = Callable[[Mapping[str, Any], Request], Awaitable[None] | None]
#: Builds the client on first wake, for example from a credential saved after provisioning.
ClientFactory = Callable[[], AsyncClient | Awaitable[AsyncClient]]


def new_secret() -> str:
    """A fresh signing secret: 32 random bytes as padded base64 with a ``whsec_`` prefix."""
    return "whsec_" + base64.b64encode(secrets.token_bytes(32)).decode()


@dataclass(frozen=True)
class Provisioned:
    """An instance created by ``Receiver.provision``.

    Save ``token`` as the instance credential, and ``secret``,
    ``registration_id`` and ``instance_id`` for the receiver's next start.
    """

    instance_id: str
    instance_name: str
    token: str
    #: When the credential expires, as the provider returned it. ``None`` if no expiry is scheduled.
    expires_at: str | None
    secret: str
    registration_id: str

    def __repr__(self) -> str:
        return f"Provisioned(instance_id={self.instance_id!r}, instance_name={self.instance_name!r}, registration_id={self.registration_id!r})"


def signing_key(secret: str) -> bytes:
    if not secret.startswith("whsec_"):
        raise ValueError("signing secret must start with whsec_")
    return base64.b64decode(secret[len("whsec_") :], validate=True)


def sign(secret: str, message_id: str, timestamp: int, body: bytes) -> str:
    """The ``webhook-signature`` header value for one delivery attempt."""
    digest = hmac.new(signing_key(secret), f"{message_id}.{timestamp}.".encode() + body, hashlib.sha256).digest()
    return "v1," + base64.b64encode(digest).decode()


def verify(secret: str, headers: Mapping[str, str], body: bytes, *, tolerance: int = 300, now: float | None = None) -> dict[str, Any]:
    """Verify a delivery and return its parsed body. Raises ``ValueError``."""
    lower = {k.lower(): v for k, v in headers.items()}
    message_id = lower.get("webhook-id", "")
    stamp = lower.get("webhook-timestamp", "")
    signatures = lower.get("webhook-signature", "").split()
    if not message_id or not stamp.isdigit() or not signatures:
        raise ValueError("missing webhook headers")
    if abs((now if now is not None else time.time()) - int(stamp)) > tolerance:
        raise ValueError("webhook timestamp outside tolerance")
    expected = sign(secret, message_id, int(stamp), body)
    if not any(hmac.compare_digest(expected, candidate) for candidate in signatures if candidate.startswith("v1,")):
        raise ValueError("invalid webhook signature")
    try:
        message = loads(body)
    except ProtocolError as err:
        raise ValueError("invalid webhook body") from err
    if not isinstance(message, dict) or message.get("id") != message_id:
        raise ValueError("webhook ID does not match the body")
    return message


class Receiver:
    """Verifies AAP webhooks and wakes paused runs.

    ``secret`` is the instance's signing secret. ``registration_id`` is the
    ID the provisioner generated for this receiver; verification messages for
    any other registration are refused. ``provision`` generates both when
    they are not given. ``instance_id``, once known, restricts notifications
    to that instance.

    ``client`` reads requests when a run is woken. It may be a client, a
    zero-argument function returning one (called on first wake, then
    cached), or ``None`` until ``provision`` installs one. ``resumers`` maps
    a framework name to a function that resumes a run from its resume handle.
    """

    def __init__(
        self,
        *,
        resumers: Mapping[str, Resumer],
        secret: str | None = None,
        client: AsyncClient | ClientFactory | None = None,
        registration_id: str | None = None,
        instance_id: str | None = None,
        tolerance: int = 300,
    ):
        if secret is not None:
            signing_key(secret)
        self.secret = secret
        self.client: AsyncClient | None = None if callable(client) else client
        self._factory: ClientFactory | None = client if callable(client) else None
        self._loading: asyncio.Future[AsyncClient] | None = None
        self.resumers = dict(resumers)
        self.registration_id = registration_id
        self.instance_id = instance_id
        self.tolerance = tolerance
        self._tasks: set[asyncio.Task[None]] = set()

    async def handle(self, headers: Mapping[str, str], body: bytes) -> tuple[int, bytes]:
        """Process one delivery. Returns the HTTP status and body to send.

        A notification is acknowledged at once and the run is woken in the
        background, because a delivery attempt has a ten second limit.
        """
        if self.secret is None:
            return 401, b""
        try:
            message = verify(self.secret, headers, body, tolerance=self.tolerance)
        except ValueError:
            return 401, b""
        kind = message.get("type")
        if kind == "webhook.verification":
            if self.registration_id is None or message.get("registration_id") != self.registration_id or not isinstance(message.get("challenge"), str):
                return 403, b""
            return 200, json.dumps({"challenge": message["challenge"]}).encode()
        if kind == "request.resolved":
            if self.instance_id is not None and message.get("instance_id") != self.instance_id:
                return 403, b""
            request_id = message.get("request_id")
            if isinstance(request_id, str):
                task = asyncio.ensure_future(self.wake(request_id))
                self._tasks.add(task)
                task.add_done_callback(self._tasks.discard)
            return 204, b""
        return 400, b""

    async def wake(self, request_id: str) -> bool:
        """Resume the run waiting on a request. Also the recovery sweep's entry point.

        Returns ``False`` when nothing was resumed, including when the
        receiver has no client yet.
        """
        try:
            client = await self._client()
        except Exception:  # noqa: BLE001 - a failing factory must not crash the receiver
            log.exception("could not create a client to resume request %s", request_id)
            return False
        if client is None:
            log.warning("cannot resume request %s: the receiver has no client yet", request_id)
            return False
        try:
            request = await client.get(request_id)
        except (AAPError, ProtocolError):
            log.warning("could not read request %s to resume it", request_id, exc_info=True)
            return False
        handle = (request.context or {}).get("resume")
        resumer = self.resumers.get(handle.get("framework", "")) if isinstance(handle, dict) else None
        if resumer is None:
            log.warning("request %s has no resume handle this receiver can use", request_id)
            return False
        try:
            result = resumer(handle, request)
            if inspect.isawaitable(result):
                await result
            return True
        except Exception:  # noqa: BLE001 - a failed resume must not crash the receiver
            log.exception("resuming the run for request %s failed", request_id)
            return False

    async def _client(self) -> AsyncClient | None:
        """The client, building it with the factory once if needed."""
        if self.client is not None or self._factory is None:
            return self.client
        if self._loading is None:
            self._loading = asyncio.ensure_future(_build(self._factory))
        loading = self._loading
        try:
            client = await asyncio.shield(loading)
        except BaseException:
            if self._loading is loading and loading.done():
                self._loading = None
            raise
        if self.client is None:
            self.client = client
        return self.client

    async def provision(
        self,
        *,
        provider_url: str,
        provisioner_token: str,
        url: str,
        instance_name: str | None = None,
        idempotency_key: str | None = None,
        http: httpx.AsyncClient | None = None,
    ) -> Provisioned:
        """Create an instance whose notifications come to this receiver.

        ``provider_url`` is the provider's AAP base URL and ``url`` this
        receiver's public HTTPS URL. The provider verifies the receiver before
        it answers, so the receiver must already be serving at ``url``.

        Generates the signing secret and registration ID if the receiver has
        none. ``idempotency_key`` defaults to the registration ID, so calling
        again after a failure retries the same submission. On success the
        receiver uses the new credential to wake runs and accepts
        notifications only for the new instance. Save the result: nothing is
        stored.

        Raises ``WebhookVerificationFailed`` when the provider could not
        verify the receiver, ``ProvisionError`` for other failures and
        ``ProtocolError`` for a malformed answer.
        """
        if not provisioner_token or "\n" in provisioner_token or "\r" in provisioner_token:
            raise ValueError("provisioner token is required and must not contain newlines")
        base_url = validate_base_url(provider_url)
        if self.secret is None:
            self.secret = new_secret()
        if self.registration_id is None:
            self.registration_id = str(uuid.uuid4())
        submission: dict[str, Any] = {"delivery": {"type": "webhook", "url": url, "registration_id": self.registration_id, "signing_secret": self.secret}}
        if instance_name is not None:
            submission = {"instance_name": instance_name, **submission}
        headers = {
            "Authorization": f"Bearer {provisioner_token}",
            "Content-Type": "application/json",
            "Idempotency-Key": idempotency_key or self.registration_id,
            "User-Agent": USER_AGENT,
        }
        transport = http or httpx.AsyncClient(timeout=40.0, follow_redirects=False)
        try:
            response = await transport.post(base_url + "/v1/instances", headers=headers, content=json.dumps(submission).encode())
            raw = await response.aread()
        except httpx.TransportError as err:
            raise ProvisionError("the provider could not be reached") from err
        finally:
            if http is None:
                await transport.aclose()
        instance_id, name, token, expires_at = _provisioned(response.status_code, raw)
        self.client = AsyncClient(base_url, token, http=http)
        self._factory = None
        self.instance_id = instance_id
        return Provisioned(instance_id=instance_id, instance_name=name, token=token, expires_at=expires_at, secret=self.secret, registration_id=self.registration_id)

    def asgi(self) -> Callable[..., Awaitable[None]]:
        """An ASGI app that accepts POSTed webhooks at any path it is served on.

        It is an object rather than a function, so Starlette and FastAPI
        routes serve it as an ASGI app.
        """
        return _ASGIApp(self)


class _ASGIApp:
    def __init__(self, receiver: Receiver):
        self.receiver = receiver

    async def __call__(self, scope: dict[str, Any], receive: Callable[[], Awaitable[dict[str, Any]]], send: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
        if scope["type"] != "http":
            return
        if scope["method"] != "POST":
            await _respond(send, 405, b"")
            return
        chunks = []
        more = True
        while more:
            event = await receive()
            chunks.append(event.get("body", b""))
            more = event.get("more_body", False)
        headers = {k.decode("latin-1"): v.decode("latin-1") for k, v in scope.get("headers", [])}
        status, body = await self.receiver.handle(headers, b"".join(chunks))
        await _respond(send, status, body)


async def _build(factory: ClientFactory) -> AsyncClient:
    client = factory()
    return await client if inspect.isawaitable(client) else client


def _provisioned(status: int, raw: bytes) -> tuple[str, str, str, str | None]:
    """Check a provisioning answer and return the instance ID, name, token and expiry."""
    if status not in (200, 201):
        code = None
        try:
            error = loads(raw)["error"]
            code = error["code"] if isinstance(error["code"], str) else None
        except (ProtocolError, KeyError, TypeError):
            pass
        if status == 422 and code == "webhook_verification_failed":
            raise WebhookVerificationFailed("the provider could not verify the receiver", status=status, code=code)
        raise ProvisionError(f"provisioning failed (HTTP {status}{f': {code}' if code else ''})", status=status, code=code)
    if len(raw) > MAX_RESPONSE:
        raise ProtocolError("AAP response too large")
    body = loads(raw)
    instance = body.get("instance") if isinstance(body, dict) else None
    credential = body.get("credential") if isinstance(body, dict) else None
    if not isinstance(instance, dict) or not isinstance(credential, dict):
        raise ProtocolError("invalid provisioning response")
    instance_id, name, token, expires_at = instance.get("id"), instance.get("name"), credential.get("token"), credential.get("expires_at")
    if not all(isinstance(v, str) and v for v in (instance_id, name, token)) or not (expires_at is None or isinstance(expires_at, str)):
        raise ProtocolError("invalid provisioning response")
    return instance_id, name, token, expires_at


async def _respond(send: Callable[[dict[str, Any]], Awaitable[None]], status: int, body: bytes) -> None:
    headers = [(b"content-type", b"application/json")] if body else []
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})
