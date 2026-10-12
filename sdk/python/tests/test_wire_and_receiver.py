from __future__ import annotations

import asyncio
import re
from pathlib import Path

import pytest

from agentapprovalprotocol import ProtocolError, Receiver
from agentapprovalprotocol._wire import loads, parse_request, same
from agentapprovalprotocol.receiver import sign, verify
from agentapprovalprotocol.testing import SECRET, FakeProvider

SPEC = Path(__file__).resolve().parents[3] / "docs" / "specification" / "7_async.md"


def approved(**extra):
    base = {
        "id": "7ab8c8ec-7b2d-4fd6-9b52-752f9515eb71",
        "tool": "issue_refund",
        "arguments": {"amount": 4900},
        "timeout": "30m",
        "status": "approved",
        "created_at": "2026-09-16T12:00:00Z",
        "deadline_at": "2026-09-16T12:30:00Z",
        "decision": {"status": "approved", "decided_at": "2026-09-16T12:02:00Z", "expires_at": "2026-09-16T12:07:00Z"},
    }
    base.update(extra)
    return base


def test_parses_a_consumed_request_with_an_outcome():
    request = parse_request(approved(consumption={"consumed_at": "2026-09-16T12:02:05.123456789Z", "outcome": {"status": "succeeded", "reported_at": "2026-09-16T12:02:07Z"}}))
    assert request.consumption.outcome.status == "succeeded"


@pytest.mark.parametrize(
    "change",
    [
        lambda r: r.update(reviewer="private"),
        lambda r: r.update(server=None),
        lambda r: r["decision"].pop("expires_at"),
        lambda r: r.update(status="denied"),
        lambda r: r.update(consumption={"consumed_at": "2026-09-16T12:01:00Z"}),
        lambda r: r.update(consumption={"consumed_at": "2026-09-16T12:03:00Z", "outcome": {"status": "maybe", "reported_at": "2026-09-16T12:04:00Z"}}),
        lambda r: r.update(created_at="2026-09-16 12:00:00"),
    ],
)
def test_rejects_malformed_requests(change):
    request = approved()
    change(request)
    with pytest.raises(ProtocolError):
        parse_request(request)


def test_rejects_duplicate_keys():
    with pytest.raises(ProtocolError):
        loads('{"a": 1, "a": 2}')


def test_json_equality_keeps_types_apart():
    assert same(loads("4900"), 4900)
    assert same(loads("1.50"), loads("1.5"))
    assert not same(True, 1)
    assert not same("1", 1)


def test_documented_signature_verifies():
    source = SPEC.read_text()
    secret = "whsec_" + re.search(r'"signing_secret": "whsec_([^"]+)"', source).group(1)
    block = next(b for b in re.findall(r"```http\n(.*?)\n```", source, re.S) if "webhook-signature:" in b)
    head, body = block.split("\n\n", 1)
    headers = dict(line.split(": ", 1) for line in head.splitlines()[1:])
    message = verify(secret, headers, body.encode(), now=int(headers["webhook-timestamp"]))
    assert message["type"] == "request.resolved"
    assert sign(secret, headers["webhook-id"], int(headers["webhook-timestamp"]), body.encode()) == headers["webhook-signature"]


def test_rejects_stale_and_forged_deliveries():
    headers, body = FakeProvider().webhook("7ab8c8ec-7b2d-4fd6-9b52-752f9515eb71")
    with pytest.raises(ValueError):
        verify(SECRET, headers, body, now=int(headers["webhook-timestamp"]) + 301)
    with pytest.raises(ValueError):
        verify(SECRET, {**headers, "webhook-signature": "v1,AAAA"}, body)


async def test_receiver_wakes_the_run_from_its_resume_handle():
    provider = FakeProvider()
    woken = []
    receiver = Receiver(secret=SECRET, client=provider.async_client(), resumers={"test": lambda handle, request: woken.append((handle["thread_id"], request.status))})
    from agentapprovalprotocol import Call, Gate

    Gate(provider.client(), mode="async").check(Call(key="k", tool="t", arguments={}, resume={"framework": "test", "thread_id": "t1"}))
    status, _ = await receiver.handle(*provider.webhook(provider.only().id))
    assert status == 204
    await asyncio.sleep(0.01)
    assert woken == [("t1", "approved")]


async def test_receiver_answers_only_its_own_verification():
    receiver = Receiver(secret=SECRET, client=FakeProvider().async_client(), resumers={}, registration_id="8246931c-4ce0-4c15-a94a-e9c078ad06e2")
    import json
    import time
    import uuid

    def delivery(registration_id):
        message_id = str(uuid.uuid4())
        body = json.dumps({"id": message_id, "type": "webhook.verification", "registration_id": registration_id, "instance_id": str(uuid.uuid4()), "created_at": "2026-09-16T11:59:00Z", "challenge": "2edc34d7"}).encode()
        stamp = int(time.time())
        return {"webhook-id": message_id, "webhook-timestamp": str(stamp), "webhook-signature": sign(SECRET, message_id, stamp, body)}, body

    assert await receiver.handle(*delivery("8246931c-4ce0-4c15-a94a-e9c078ad06e2")) == (200, b'{"challenge": "2edc34d7"}')
    assert (await receiver.handle(*delivery("00000000-0000-4000-8000-000000000000")))[0] == 403


async def test_receiver_refuses_bad_signatures_and_other_instances():
    provider = FakeProvider()
    receiver = Receiver(secret=SECRET, client=provider.async_client(), resumers={}, instance_id="b29a43a7-1949-4b9f-9d61-b7ae66f85d31")
    headers, body = provider.webhook("7ab8c8ec-7b2d-4fd6-9b52-752f9515eb71", instance_id="11111111-1111-4111-8111-111111111111")
    assert (await receiver.handle(headers, body))[0] == 403
    assert (await receiver.handle({**headers, "webhook-signature": "v1,AAAA"}, body))[0] == 401
