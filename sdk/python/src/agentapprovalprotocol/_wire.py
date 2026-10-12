"""Strict parsing of AAP wire objects.

Protocol objects reject unknown fields, nulls and duplicate keys. Tool
arguments and runtime context keep arbitrary JSON. Numbers are parsed as
Decimal so a response can be compared exactly with the submission.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Iterable, Mapping

PENDING = "pending"
APPROVED = "approved"
DENIED = "denied"
EXPIRED = "expired"
CANCELLED = "cancelled"
TERMINAL = frozenset({APPROVED, DENIED, EXPIRED, CANCELLED})
OUTCOMES = frozenset({"succeeded", "failed"})


class ProtocolError(Exception):
    """The provider sent a response that does not satisfy the AAP contract."""


@dataclass(frozen=True)
class Outcome:
    status: str
    reported_at: datetime
    note: str | None = None


@dataclass(frozen=True)
class Consumption:
    consumed_at: datetime
    outcome: Outcome | None = None


@dataclass(frozen=True)
class Decision:
    status: str
    decided_at: datetime
    note: str | None = None
    expires_at: datetime | None = None


@dataclass(frozen=True)
class Request:
    id: str
    tool: str
    arguments: Mapping[str, Any]
    timeout: str
    status: str
    created_at: datetime
    deadline_at: datetime
    server: str | None = None
    agent_reasoning: str | None = None
    context: Mapping[str, Any] | None = None
    decision: Decision | None = None
    consumption: Consumption | None = None


def loads(raw: bytes | str) -> Any:
    """Parse JSON, rejecting duplicate keys and keeping numbers exact."""

    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for key, value in items:
            if key in out:
                raise ProtocolError("duplicate JSON key")
            out[key] = value
        return out

    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_float=Decimal)
    except (ValueError, TypeError) as err:
        raise ProtocolError("invalid JSON") from err


def dumps(value: Any) -> bytes:
    """Serialize a submission. Key order is stable so retries send the same bytes."""

    def default(item: Any) -> Any:
        if isinstance(item, Decimal):
            return float(item) if item != item.to_integral_value() else int(item)
        raise TypeError(f"{type(item).__name__} is not JSON serializable")

    return json.dumps(value, separators=(",", ":"), sort_keys=True, ensure_ascii=False, default=default, allow_nan=False).encode()


def same(a: Any, b: Any) -> bool:
    """JSON equality that keeps booleans, numbers and strings distinct."""
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, Decimal)) and isinstance(b, (int, Decimal)):
        return Decimal(a) == Decimal(b)
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


_TIMESTAMP = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z$")


def timestamp(value: Any) -> datetime:
    match = _TIMESTAMP.match(value) if isinstance(value, str) else None
    if not match:
        raise ProtocolError("invalid timestamp")
    fraction = (match.group(2) or ".0")[1:7].ljust(6, "0")
    try:
        return datetime.fromisoformat(f"{match.group(1)}.{fraction}").replace(tzinfo=timezone.utc)
    except ValueError as err:
        raise ProtocolError("invalid timestamp") from err


def _object(value: Any, allowed: Iterable[str], required: Iterable[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProtocolError("invalid AAP object")
    allowed = set(allowed)
    for key, item in value.items():
        if key not in allowed or item is None:
            raise ProtocolError("invalid AAP field")
    for key in required:
        if key not in value:
            raise ProtocolError("missing AAP field")
    return value


def _text(value: Any) -> str:
    if not isinstance(value, str) or not value:
        raise ProtocolError("invalid AAP field")
    return value


def parse_request(value: Any) -> Request:
    obj = _object(
        value,
        ["id", "tool", "server", "arguments", "timeout", "agent_reasoning", "context", "status", "created_at", "deadline_at", "decision", "consumption"],
        ["id", "tool", "arguments", "timeout", "status", "created_at", "deadline_at"],
    )
    try:
        uuid.UUID(obj["id"])
    except (ValueError, AttributeError, TypeError) as err:
        raise ProtocolError("invalid request ID") from err
    if not isinstance(obj["arguments"], dict) or ("context" in obj and not isinstance(obj["context"], dict)):
        raise ProtocolError("invalid AAP field")
    status = obj["status"]
    if status != PENDING and status not in TERMINAL:
        raise ProtocolError("invalid status")
    created, deadline = timestamp(obj["created_at"]), timestamp(obj["deadline_at"])
    if deadline <= created:
        raise ProtocolError("deadline is not after creation")

    decision = None
    if status == PENDING:
        if "decision" in obj or "consumption" in obj:
            raise ProtocolError("pending request has a decision")
    else:
        if "decision" not in obj:
            raise ProtocolError("terminal request has no decision")
        d = _object(obj["decision"], ["status", "note", "decided_at", "expires_at"], ["status", "decided_at"])
        decided = timestamp(d["decided_at"])
        if d["status"] != status or decided < created:
            raise ProtocolError("decision does not match the request")
        expires = None
        if status == APPROVED:
            if "expires_at" not in d:
                raise ProtocolError("approval has no expiry")
            expires = timestamp(d["expires_at"])
            if expires <= decided:
                raise ProtocolError("approval expires before it was decided")
        elif "expires_at" in d:
            raise ProtocolError("only approvals expire")
        decision = Decision(status=status, decided_at=decided, note=_text(d["note"]) if "note" in d else None, expires_at=expires)

    consumption = None
    if "consumption" in obj:
        if status != APPROVED:
            raise ProtocolError("only approvals are consumed")
        c = _object(obj["consumption"], ["consumed_at", "outcome"], ["consumed_at"])
        consumed = timestamp(c["consumed_at"])
        if decision is None or consumed < decision.decided_at:
            raise ProtocolError("consumed before the decision")
        outcome = None
        if "outcome" in c:
            o = _object(c["outcome"], ["status", "note", "reported_at"], ["status", "reported_at"])
            reported = timestamp(o["reported_at"])
            if o["status"] not in OUTCOMES or reported < consumed:
                raise ProtocolError("invalid outcome")
            outcome = Outcome(status=o["status"], reported_at=reported, note=_text(o["note"]) if "note" in o else None)
        consumption = Consumption(consumed_at=consumed, outcome=outcome)

    return Request(
        id=obj["id"],
        tool=_text(obj["tool"]),
        server=_text(obj["server"]) if "server" in obj else None,
        arguments=obj["arguments"],
        timeout=_text(obj["timeout"]),
        agent_reasoning=obj.get("agent_reasoning"),
        context=obj.get("context"),
        status=status,
        created_at=created,
        deadline_at=deadline,
        decision=decision,
        consumption=consumption,
    )


def matches(request: Request, submission: Mapping[str, Any], previous: Request | None = None) -> bool:
    """Whether a returned request is the one submitted, unchanged since it was last seen."""
    if (
        request.tool != submission["tool"]
        or request.server != submission.get("server")
        or request.timeout != submission["timeout"]
        or request.agent_reasoning != submission.get("agent_reasoning")
        or not same(request.arguments, submission["arguments"])
        or not same(request.context or {}, submission.get("context") or {})
    ):
        return False
    if previous is not None and (request.id, request.created_at, request.deadline_at) != (previous.id, previous.created_at, previous.deadline_at):
        return False
    return True
