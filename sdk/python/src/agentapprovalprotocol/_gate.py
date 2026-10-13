"""The gate: whether one tool call may run now.

Every check runs the same steps, whether the call is new or seen again
after a resume: create the request with the call's idempotency key (a
replay returns the existing request), wait or report pending, check the
decision, consume it, allow. A value a framework passes back on resume is
never read, so only the provider can approve. Any failure denies.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Awaitable, Callable, Iterator, Literal, Mapping

from ._client import AAPError, AsyncClient, Client, ConflictError, CredentialRefused
from ._wire import APPROVED, CANCELLED, DENIED, EXPIRED, PENDING, ProtocolError, Request, dumps, loads, matches

log = logging.getLogger("agentapprovalprotocol")

FAIL_CLOSED = "The approval adapter could not obtain a valid AAP decision. The call was not run."
REFUSED = "The approval provider refused this agent's credential, so no tool call can run. Ask whoever manages the agent. The call was not run."
EXPIRED_TEXT = "The approval window or permission to start this call expired. The call was not run."
CANCELLED_TEXT = "The call was cancelled before execution."
CONSUMED_TEXT = "This approved call was already attempted, so it was not run again. Request approval again if it still needs to happen."
TIMED_OUT = "Approval was not obtained in time. The call was not run."

Mode = Literal["sync", "async"]


@dataclass(frozen=True)
class Call:
    """One tool call the gate is asked about.

    ``key`` must identify this tool call within its run and stay the same
    when the call is seen again after a resume or replay. ``resume`` is how
    a receiver wakes the run later, in async mode.
    """

    key: str
    tool: str
    arguments: Mapping[str, Any]
    server: str | None = None
    reasoning: str | None = None
    context: Mapping[str, Any] | None = None
    resume: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class Allow:
    """The approval was checked and consumed. Run the tool now."""

    request_id: str
    _report: Callable[[str, str | None], Any] = field(repr=False)

    def __bool__(self) -> bool:
        return True

    def report(self, status: Literal["succeeded", "failed"], note: str | None = None) -> Any:
        """Report the outcome. Best effort: failures are logged, never raised."""
        return self._report(status, note)


@dataclass(frozen=True)
class Deny:
    """The call must not run. ``reason`` is written for the model."""

    reason: str
    status: str
    request_id: str | None = None

    def __bool__(self) -> bool:
        return False


@dataclass(frozen=True)
class Pending:
    """Async mode: no decision yet. Pause the run; a receiver wakes it."""

    request_id: str

    def __bool__(self) -> bool:
        return False


Verdict = Allow | Deny | Pending


def submission(call: Call, timeout: str, defaults: Mapping[str, Any]) -> dict[str, Any]:
    context = {**defaults, **(call.context or {}), "call_id": call.key}
    if call.resume is not None:
        context["resume"] = dict(call.resume)
    body: dict[str, Any] = {"tool": call.tool, "arguments": dict(call.arguments), "timeout": timeout, "context": context}
    if call.server:
        body["server"] = call.server
    if call.reasoning:
        body["agent_reasoning"] = call.reasoning
    return body


def idempotency_key(call: Call, body: Mapping[str, Any]) -> str:
    """Stable for the same call and submission; any change asks again."""
    return hashlib.sha256(call.key.encode() + b"\x00" + dumps(body)).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _settled(request: Request) -> Deny | None:
    """The deny for a terminal request, or None when it may be consumed."""
    if request.status == DENIED:
        note = request.decision.note if request.decision else None
        return Deny(f"The Agent Approval Protocol (AAP) provider denied this call: {note}" if note else "The Agent Approval Protocol (AAP) provider denied this call.", DENIED, request.id)
    if request.status == CANCELLED:
        return Deny(CANCELLED_TEXT, CANCELLED, request.id)
    if request.status == EXPIRED:
        return Deny(EXPIRED_TEXT, EXPIRED, request.id)
    assert request.status == APPROVED and request.decision and request.decision.expires_at
    if request.consumption is not None:
        return Deny(CONSUMED_TEXT, "consumed", request.id)
    if _now() >= request.decision.expires_at:
        return Deny(EXPIRED_TEXT, EXPIRED, request.id)
    return None


def _consumed(request: Request, consumed: Request, body: Mapping[str, Any]) -> bool:
    return consumed.status == APPROVED and consumed.consumption is not None and matches(consumed, body, request)


def _conflict(err: ConflictError, request_id: str) -> Deny:
    if err.code == "already_consumed":
        return Deny(CONSUMED_TEXT, "consumed", request_id)
    if err.code == "approval_expired":
        return Deny(EXPIRED_TEXT, EXPIRED, request_id)
    return Deny(FAIL_CLOSED, "error", request_id)


def _failure(err: BaseException, request_id: str | None) -> Deny:
    if isinstance(err, CredentialRefused):
        return Deny(REFUSED, "error", request_id)
    if not isinstance(err, (AAPError, ProtocolError)):
        log.exception("approval gate failed", exc_info=err)
    return Deny(FAIL_CLOSED, "error", request_id)


class _GateConfig:
    def __init__(self, mode: Mode, timeout: str | None, wait_limit: float, context: Mapping[str, Any] | None, report_outcomes: bool):
        if mode not in ("sync", "async"):
            raise ValueError("mode must be sync or async")
        self.mode = mode
        self.timeout = timeout or ("24h" if mode == "async" else "10m")
        self.wait_limit = wait_limit
        self.context = dict(context or {})
        self.report_outcomes = report_outcomes

    def _poll_until(self, request: Request, started: float) -> float:
        remaining = (request.deadline_at - _now()).total_seconds() + 10
        return started + min(self.wait_limit, max(0.0, remaining))


class Gate(_GateConfig):
    """Synchronous gate.

    In sync mode ``check`` waits for the decision. In async mode it returns
    ``Pending`` when there is none yet, unless the caller says this call
    cannot be paused, in which case it waits.
    """

    def __init__(self, client: Client, *, mode: Mode = "sync", timeout: str | None = None, wait_limit: float = 540.0, context: Mapping[str, Any] | None = None, report_outcomes: bool = True):
        super().__init__(mode, timeout, wait_limit, context, report_outcomes)
        self.client = client

    def check(self, call: Call, *, can_pause: bool = True) -> Verdict:
        body = submission(call, self.timeout, self.context)
        request: Request | None = None
        try:
            request = self.client.create(body, idempotency_key(call, body))
            body = loads(dumps(body))  # compare responses with what was sent, exactly
            if not matches(request, body):
                raise ProtocolError("the provider returned a different request")
            started = time.monotonic()
            while request.status == PENDING:
                if self.mode == "async" and can_pause:
                    return Pending(request.id)
                left = self._poll_until(request, started) - time.monotonic()
                if left <= 0:
                    self._abandon(request.id)
                    return Deny(TIMED_OUT, EXPIRED, request.id)
                previous, polled = request, time.monotonic()
                request = self.client.get(request.id, wait=max(1, min(25, int(left))))
                if not matches(request, body, previous):
                    raise ProtocolError("the provider returned a different request")
                if request.status == PENDING and time.monotonic() - polled < 0.1:
                    time.sleep(0.1)  # the provider answered without waiting
            if (deny := _settled(request)) is not None:
                return deny
            try:
                consumed = self.client.consume(request.id, str(uuid.uuid4()))
            except ConflictError as err:
                return _conflict(err, request.id)
            if not _consumed(request, consumed, body):
                raise ProtocolError("invalid consumption")
            return Allow(request.id, self._reporter(request.id))
        except Exception as err:  # noqa: BLE001 - every failure denies
            return _failure(err, request.id if request else None)

    def _abandon(self, request_id: str) -> None:
        with contextlib.suppress(Exception):
            self.client.cancel(request_id)

    def _reporter(self, request_id: str) -> Callable[[str, str | None], bool]:
        def report(status: str, note: str | None) -> bool:
            try:
                self.client.report_outcome(request_id, status, note)
                return True
            except Exception:  # noqa: BLE001
                log.warning("could not report the outcome of %s", request_id, exc_info=True)
                return False

        return report

    @contextlib.contextmanager
    def guard(self, call: Call, *, can_pause: bool = True) -> Iterator[Verdict]:
        """Check the call; on an allow, report the outcome when the block exits."""
        verdict = self.check(call, can_pause=can_pause)
        try:
            yield verdict
        except BaseException:
            if isinstance(verdict, Allow) and self.report_outcomes:
                verdict.report("failed")
            raise
        if isinstance(verdict, Allow) and self.report_outcomes:
            verdict.report("succeeded")


class AsyncGate(_GateConfig):
    """Asynchronous gate, the same rules as ``Gate`` on an ``AsyncClient``."""

    def __init__(self, client: AsyncClient, *, mode: Mode = "sync", timeout: str | None = None, wait_limit: float = 540.0, context: Mapping[str, Any] | None = None, report_outcomes: bool = True):
        super().__init__(mode, timeout, wait_limit, context, report_outcomes)
        self.client = client

    async def check(self, call: Call, *, can_pause: bool = True) -> Verdict:
        body = submission(call, self.timeout, self.context)
        request: Request | None = None
        try:
            request = await self.client.create(body, idempotency_key(call, body))
            body = loads(dumps(body))  # compare responses with what was sent, exactly
            if not matches(request, body):
                raise ProtocolError("the provider returned a different request")
            started = time.monotonic()
            while request.status == PENDING:
                if self.mode == "async" and can_pause:
                    return Pending(request.id)
                left = self._poll_until(request, started) - time.monotonic()
                if left <= 0:
                    await self._abandon(request.id)
                    return Deny(TIMED_OUT, EXPIRED, request.id)
                previous, polled = request, time.monotonic()
                request = await self.client.get(request.id, wait=max(1, min(25, int(left))))
                if not matches(request, body, previous):
                    raise ProtocolError("the provider returned a different request")
                if request.status == PENDING and time.monotonic() - polled < 0.1:
                    await asyncio.sleep(0.1)  # the provider answered without waiting
            if (deny := _settled(request)) is not None:
                return deny
            try:
                consumed = await self.client.consume(request.id, str(uuid.uuid4()))
            except ConflictError as err:
                return _conflict(err, request.id)
            if not _consumed(request, consumed, body):
                raise ProtocolError("invalid consumption")
            return Allow(request.id, self._reporter(request.id))
        except Exception as err:  # noqa: BLE001 - every failure denies
            return _failure(err, request.id if request else None)

    async def _abandon(self, request_id: str) -> None:
        with contextlib.suppress(Exception):
            await self.client.cancel(request_id)

    def _reporter(self, request_id: str) -> Callable[[str, str | None], Awaitable[bool]]:
        async def report(status: str, note: str | None) -> bool:
            try:
                await self.client.report_outcome(request_id, status, note)
                return True
            except Exception:  # noqa: BLE001
                log.warning("could not report the outcome of %s", request_id, exc_info=True)
                return False

        return report

    @contextlib.asynccontextmanager
    async def guard(self, call: Call, *, can_pause: bool = True) -> AsyncIterator[Verdict]:
        """Check the call; on an allow, report the outcome when the block exits."""
        verdict = await self.check(call, can_pause=can_pause)
        try:
            yield verdict
        except BaseException:
            if isinstance(verdict, Allow) and self.report_outcomes:
                await verdict.report("failed")
            raise
        if isinstance(verdict, Allow) and self.report_outcomes:
            await verdict.report("succeeded")
