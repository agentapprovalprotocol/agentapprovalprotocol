"""An in-memory AAP provider for tests.

``FakeProvider`` implements the AAP request operations, including consume
and outcome, as an httpx transport, so ``Client`` and ``AsyncClient`` talk
to it without a network. Framework shims run the conformance scenarios in
their own tests against it.

It also provisions instances with webhook delivery through the async
transport: register a receiver's handler in ``receivers`` under its URL, and
``POST /v1/instances`` sends it a signed verification message first.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

import httpx

from ._client import AsyncClient, Client
from .receiver import sign

BASE_URL = "https://provider.test/aap"
TOKEN = "test-token"
PROVISIONER_TOKEN = "test-provisioner-token"
SECRET = "whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="


def _stamp(at: datetime) -> str:
    return at.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


@dataclass
class Stored:
    body: dict[str, Any]
    id: str
    created_at: datetime
    deadline_at: datetime
    status: str = "pending"
    note: str | None = None
    decided_at: datetime | None = None
    expires_at: datetime | None = None
    consumed_key: str | None = None
    consumed_at: datetime | None = None
    outcome: dict[str, Any] | None = None

    def wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {**self.body, "id": self.id, "status": self.status, "created_at": _stamp(self.created_at), "deadline_at": _stamp(self.deadline_at)}
        if self.decided_at:
            decision: dict[str, Any] = {"status": self.status, "decided_at": _stamp(self.decided_at)}
            if self.note:
                decision["note"] = self.note
            if self.expires_at:
                decision["expires_at"] = _stamp(self.expires_at)
            out["decision"] = decision
        if self.consumed_at:
            out["consumption"] = {"consumed_at": _stamp(self.consumed_at), **({"outcome": self.outcome} if self.outcome else {})}
        return out


@dataclass
class FakeProvider:
    """In-memory provider. ``auto`` decides each new request at once."""

    auto: str | None = "approved"
    validity: timedelta = timedelta(minutes=5)
    requests: dict[str, Stored] = field(default_factory=dict)
    keys: dict[str, str] = field(default_factory=dict)
    calls: list[tuple[str, str]] = field(default_factory=list)
    #: Optional hook to replace a response: return an httpx.Response to use it.
    intercept: Callable[[httpx.Request], httpx.Response | None] | None = None
    #: Receivers by URL for delivery verification, such as ``Receiver.handle``.
    receivers: dict[str, Callable[[dict[str, str], bytes], Awaitable[tuple[int, bytes]]]] = field(default_factory=dict)
    #: Provisioned instances by ID, each with its ``name`` and ``delivery``.
    instances: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: Provisioning results by idempotency key: the submission and the response body.
    provisions: dict[str, tuple[dict[str, Any], dict[str, Any]]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self._lock = threading.Lock()

    # Test controls

    def decide(self, request_id: str, status: str = "approved", note: str | None = None) -> None:
        with self._lock:
            self._decide(self.requests[request_id], status, note)

    def only(self) -> Stored:
        (stored,) = self.requests.values()
        return stored

    def client(self, **kwargs: Any) -> Client:
        return Client(BASE_URL, TOKEN, http=httpx.Client(transport=httpx.MockTransport(self.handle)), **kwargs)

    def async_client(self, **kwargs: Any) -> AsyncClient:
        return AsyncClient(BASE_URL, TOKEN, http=self.async_http(), **kwargs)

    def async_http(self) -> httpx.AsyncClient:
        """An httpx client routed to this provider, for ``Receiver.provision(http=...)``."""
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handle_async))

    def webhook(self, request_id: str, *, instance_id: str = "b29a43a7-1949-4b9f-9d61-b7ae66f85d31", secret: str = SECRET) -> tuple[dict[str, str], bytes]:
        """Headers and body of a signed request.resolved notification."""
        event_id = str(uuid.uuid4())
        body = json.dumps({"id": event_id, "type": "request.resolved", "instance_id": instance_id, "request_id": request_id, "created_at": _stamp(datetime.now(timezone.utc))}).encode()
        stamp = int(time.time())
        return {"webhook-id": event_id, "webhook-timestamp": str(stamp), "webhook-signature": sign(secret, event_id, stamp, body)}, body

    # Transport

    def _decide(self, stored: Stored, status: str, note: str | None) -> None:
        if stored.status != "pending":
            return
        now = datetime.now(timezone.utc)
        stored.status, stored.note, stored.decided_at = status, note, now
        stored.expires_at = now + self.validity if status == "approved" else None

    async def handle_async(self, request: httpx.Request) -> httpx.Response:
        """The async transport, which also provisions instances."""
        if request.url.path != "/aap/v1/instances":
            return self.handle(request)
        if self.intercept and (replaced := self.intercept(request)) is not None:
            return replaced
        return await self._provision(request)

    async def _provision(self, request: httpx.Request) -> httpx.Response:
        self.calls.append((request.method, "/instances"))
        if request.headers.get("authorization") != f"Bearer {PROVISIONER_TOKEN}":
            return httpx.Response(401)
        if request.method != "POST":
            return httpx.Response(405)
        key = request.headers.get("idempotency-key")
        if not key:
            return _error(400, "invalid_request", "missing_idempotency_key")
        body = json.loads(request.content)
        if key in self.provisions:
            original, response = self.provisions[key]
            return httpx.Response(200, json=response) if original == body else _error(409, "conflict", "idempotency_conflict")
        instance_id = str(uuid.uuid4())
        delivery = body.get("delivery")
        if delivery is not None and not await self._verify(delivery, instance_id):
            return _error(422, "invalid_request", "webhook_verification_failed")
        name = body.get("instance_name") or f"instance-{instance_id[:8]}"
        self.instances[instance_id] = {"name": name, "delivery": delivery}
        response = {"instance": {"id": instance_id, "name": name}, "credential": {"token": TOKEN, "expires_at": _stamp(datetime.now(timezone.utc) + timedelta(days=30))}}
        self.provisions[key] = (body, response)
        return httpx.Response(201, json=response)

    async def _verify(self, delivery: dict[str, Any], instance_id: str) -> bool:
        """Send a signed verification message and check the challenge comes back."""
        receiver = self.receivers.get(delivery.get("url", ""))
        if receiver is None:
            return False
        message_id, challenge = str(uuid.uuid4()), str(uuid.uuid4())
        message = {"id": message_id, "type": "webhook.verification", "registration_id": delivery["registration_id"], "instance_id": instance_id, "created_at": _stamp(datetime.now(timezone.utc)), "challenge": challenge}
        raw = json.dumps(message).encode()
        stamp = int(time.time())
        headers = {"content-type": "application/json", "webhook-id": message_id, "webhook-timestamp": str(stamp), "webhook-signature": sign(delivery["signing_secret"], message_id, stamp, raw)}
        try:
            status, answer = await asyncio.wait_for(receiver(headers, raw), 10)
            return status == 200 and json.loads(answer) == {"challenge": challenge}
        except (asyncio.TimeoutError, ValueError):
            return False

    def handle(self, request: httpx.Request) -> httpx.Response:
        if self.intercept and (replaced := self.intercept(request)) is not None:
            return replaced
        with self._lock:
            return self._handle(request)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization") != f"Bearer {TOKEN}":
            return httpx.Response(401)
        path = request.url.path.removeprefix("/aap/v1/requests")
        self.calls.append((request.method, path or "/"))
        key = request.headers.get("idempotency-key")
        if request.method == "POST" and path == "":
            if not key:
                return _error(400, "invalid_request", "missing_idempotency_key")
            body = json.loads(request.content)
            if key in self.keys:
                stored = self.requests[self.keys[key]]
                if json.dumps(stored.body, sort_keys=True, default=str) != json.dumps(body, sort_keys=True, default=str):
                    return _error(409, "conflict", "idempotency_conflict")
                return httpx.Response(200, json=stored.wire())
            now = datetime.now(timezone.utc)
            stored = Stored(body=body, id=str(uuid.uuid4()), created_at=now, deadline_at=now + timedelta(minutes=30))
            self.requests[stored.id] = stored
            self.keys[key] = stored.id
            if self.auto:
                self._decide(stored, self.auto, None)
            return httpx.Response(201, json=stored.wire())
        parts = path.strip("/").split("/")
        stored = self.requests.get(parts[0])
        if stored is None:
            return _error(404, "not_found", "not_found")
        if request.method == "GET" and len(parts) == 1:
            return httpx.Response(200, json=stored.wire())
        if request.method == "DELETE" and len(parts) == 1:
            if stored.status != "pending" and stored.status != "cancelled":
                return _error(409, "conflict", "already_terminal")
            self._decide(stored, "cancelled", None)
            return httpx.Response(200, json=stored.wire())
        if request.method == "POST" and parts[1:] == ["consume"]:
            if not key:
                return _error(400, "invalid_request", "missing_idempotency_key")
            if stored.consumed_key == key:
                return httpx.Response(200, json=stored.wire())
            if stored.consumed_key is not None:
                return _error(409, "conflict", "already_consumed")
            if stored.status != "approved":
                return _error(409, "conflict", "not_approved")
            if stored.expires_at is None or datetime.now(timezone.utc) >= stored.expires_at:
                return _error(409, "conflict", "approval_expired")
            stored.consumed_key, stored.consumed_at = key, datetime.now(timezone.utc)
            return httpx.Response(200, json=stored.wire())
        if request.method == "POST" and parts[1:] == ["outcome"]:
            report = json.loads(request.content)
            if stored.consumed_at is None:
                return _error(409, "conflict", "not_consumed")
            if stored.outcome is not None:
                same = stored.outcome["status"] == report.get("status") and stored.outcome.get("note") == report.get("note")
                return httpx.Response(200, json=stored.wire()) if same else _error(409, "conflict", "outcome_conflict")
            stored.outcome = {**report, "reported_at": _stamp(datetime.now(timezone.utc))}
            return httpx.Response(200, json=stored.wire())
        return httpx.Response(405)


def _error(status: int, kind: str, code: str) -> httpx.Response:
    return httpx.Response(status, json={"error": {"type": kind, "code": code, "message": code, "request_id": str(uuid.uuid4())}})
