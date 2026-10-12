"""Webhook receiver for asynchronous mode.

The receiver verifies AAP webhooks, answers receiver verification during
provisioning, and wakes paused runs. A notification only wakes a run: the
gate fetches and consumes the decision itself, so the receiver keeps no
state and a repeated or forged event at most wakes a run that pauses again.

The resume handle is read from the request's ``context.resume``, which the
gate wrote when it created the request. Its ``framework`` names the resumer
to call.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import inspect
import json
import logging
import time
from typing import Any, Awaitable, Callable, Mapping

from ._client import AAPError, AsyncClient
from ._wire import ProtocolError, Request, loads

log = logging.getLogger("agentapprovalprotocol")

Resumer = Callable[[Mapping[str, Any], Request], Awaitable[None] | None]


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

    ``registration_id`` is the ID the provisioner generated for this
    receiver; verification messages for any other registration are refused.
    ``instance_id``, once known, restricts notifications to that instance.
    ``resumers`` maps a framework name to a function that resumes a run from
    its resume handle.
    """

    def __init__(
        self,
        *,
        secret: str,
        client: AsyncClient,
        resumers: Mapping[str, Resumer],
        registration_id: str | None = None,
        instance_id: str | None = None,
        tolerance: int = 300,
    ):
        signing_key(secret)
        self.secret = secret
        self.client = client
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
        """Resume the run waiting on a request. Also the recovery sweep's entry point."""
        try:
            request = await self.client.get(request_id)
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

    def asgi(self) -> Callable[..., Awaitable[None]]:
        """An ASGI app that accepts POSTed webhooks at any path it is mounted on."""

        async def app(scope: dict[str, Any], receive: Callable[[], Awaitable[dict[str, Any]]], send: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
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
            status, body = await self.handle(headers, b"".join(chunks))
            await _respond(send, status, body)

        return app


async def _respond(send: Callable[[dict[str, Any]], Awaitable[None]], status: int, body: bytes) -> None:
    headers = [(b"content-type", b"application/json")] if body else []
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})
