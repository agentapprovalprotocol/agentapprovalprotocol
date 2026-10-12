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


RECEIVER_URL = "https://agent.test/aap/events"


def verification(registration_id, secret=SECRET):
    import json
    import time
    import uuid

    message_id = str(uuid.uuid4())
    body = json.dumps({"id": message_id, "type": "webhook.verification", "registration_id": registration_id, "instance_id": str(uuid.uuid4()), "created_at": "2026-09-16T11:59:00Z", "challenge": "2edc34d7"}).encode()
    stamp = int(time.time())
    return {"webhook-id": message_id, "webhook-timestamp": str(stamp), "webhook-signature": sign(secret, message_id, stamp, body)}, body


async def pending_request(provider, framework="test"):
    from agentapprovalprotocol import Call, Gate

    Gate(provider.client(), mode="async").check(Call(key="k", tool="t", arguments={}, resume={"framework": framework}))
    return provider.only().id


async def test_receiver_without_a_client_answers_verification_and_skips_wakes(caplog):
    provider = FakeProvider()
    woken = []
    receiver = Receiver(secret=SECRET, registration_id="8246931c-4ce0-4c15-a94a-e9c078ad06e2", resumers={"test": lambda handle, request: woken.append(request.id)})
    assert await receiver.handle(*verification("8246931c-4ce0-4c15-a94a-e9c078ad06e2")) == (200, b'{"challenge": "2edc34d7"}')
    request_id = await pending_request(provider)
    assert (await receiver.handle(*provider.webhook(request_id)))[0] == 204
    await asyncio.sleep(0.01)
    assert woken == []
    assert await receiver.wake(request_id) is False
    assert "has no client yet" in caplog.text


async def test_receiver_without_a_secret_refuses_deliveries():
    receiver = Receiver(resumers={}, registration_id="8246931c-4ce0-4c15-a94a-e9c078ad06e2")
    assert (await receiver.handle(*verification("8246931c-4ce0-4c15-a94a-e9c078ad06e2")))[0] == 401


@pytest.mark.parametrize("asynchronous", [False, True])
async def test_client_factory_is_called_once_on_first_wake(asynchronous):
    provider = FakeProvider()
    made = []

    def make():
        made.append(1)
        return provider.async_client()

    async def make_async():
        return make()

    woken = []
    receiver = Receiver(secret=SECRET, client=make_async if asynchronous else make, resumers={"test": lambda handle, request: woken.append(request.id)})
    assert receiver.client is None and made == []
    request_id = await pending_request(provider)
    assert await asyncio.gather(receiver.wake(request_id), receiver.wake(request_id)) == [True, True]
    assert await receiver.wake(request_id) is True
    assert made == [1]
    assert woken == [request_id] * 3


async def test_a_failing_factory_is_retried_on_the_next_wake(caplog):
    provider = FakeProvider()
    attempts = []

    def make():
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError("credential not saved yet")
        return provider.async_client()

    receiver = Receiver(secret=SECRET, client=make, resumers={"test": lambda handle, request: None})
    request_id = await pending_request(provider)
    assert await receiver.wake(request_id) is False
    assert await receiver.wake(request_id) is True
    assert len(attempts) == 2


async def test_provision_registers_the_receiver_and_installs_the_credential():
    from agentapprovalprotocol.testing import BASE_URL, PROVISIONER_TOKEN

    provider = FakeProvider()
    woken = []
    receiver = Receiver(resumers={"test": lambda handle, request: woken.append(request.id)})
    provider.receivers[RECEIVER_URL] = receiver.handle
    provisioned = await receiver.provision(provider_url=BASE_URL, provisioner_token=PROVISIONER_TOKEN, url=RECEIVER_URL, instance_name="codex-chris-laptop", http=provider.async_http())
    assert provisioned.instance_name == "codex-chris-laptop"
    assert provisioned.token == "test-token" and provisioned.expires_at
    assert provisioned.secret.startswith("whsec_") and len(provisioned.secret) == 50
    assert provisioned.secret == receiver.secret and provisioned.registration_id == receiver.registration_id
    assert receiver.instance_id == provisioned.instance_id
    assert provider.instances[provisioned.instance_id]["delivery"] == {"type": "webhook", "url": RECEIVER_URL, "registration_id": provisioned.registration_id, "signing_secret": provisioned.secret}
    assert "whsec_" not in repr(provisioned) and "test-token" not in repr(provisioned)

    request_id = await pending_request(provider)
    assert (await receiver.handle(*provider.webhook(request_id, instance_id=provisioned.instance_id, secret=provisioned.secret)))[0] == 204
    await asyncio.sleep(0.01)
    assert woken == [request_id]
    other = provider.webhook(request_id, secret=provisioned.secret)
    assert (await receiver.handle(*other))[0] == 403


async def test_provision_surfaces_verification_failure_and_retries_with_the_same_key():
    from agentapprovalprotocol import WebhookVerificationFailed
    from agentapprovalprotocol.testing import BASE_URL, PROVISIONER_TOKEN

    provider = FakeProvider()
    receiver = Receiver(secret=SECRET, resumers={})
    with pytest.raises(WebhookVerificationFailed) as failure:
        await receiver.provision(provider_url=BASE_URL, provisioner_token=PROVISIONER_TOKEN, url=RECEIVER_URL, http=provider.async_http())
    assert failure.value.status == 422 and failure.value.code == "webhook_verification_failed"
    assert receiver.client is None and receiver.instance_id is None and provider.instances == {}
    registration_id = receiver.registration_id
    assert registration_id is not None

    provider.receivers[RECEIVER_URL] = receiver.handle
    provisioned = await receiver.provision(provider_url=BASE_URL, provisioner_token=PROVISIONER_TOKEN, url=RECEIVER_URL, http=provider.async_http())
    assert provisioned.registration_id == registration_id and provisioned.secret == SECRET
    assert list(provider.provisions) == [registration_id]


async def test_provision_refuses_a_receiver_expecting_another_registration():
    from agentapprovalprotocol import WebhookVerificationFailed
    from agentapprovalprotocol.testing import BASE_URL, PROVISIONER_TOKEN

    provider = FakeProvider()
    receiver = Receiver(secret=SECRET, resumers={})
    provider.receivers[RECEIVER_URL] = Receiver(secret=SECRET, registration_id="00000000-0000-4000-8000-000000000000", resumers={}).handle
    with pytest.raises(WebhookVerificationFailed):
        await receiver.provision(provider_url=BASE_URL, provisioner_token=PROVISIONER_TOKEN, url=RECEIVER_URL, http=provider.async_http())
    assert (await receiver.handle(*verification("00000000-0000-4000-8000-000000000000")))[0] == 403


async def test_provision_surfaces_other_errors():
    from agentapprovalprotocol import ProvisionError, WebhookVerificationFailed
    from agentapprovalprotocol.testing import BASE_URL

    provider = FakeProvider()
    receiver = Receiver(resumers={})
    provider.receivers[RECEIVER_URL] = receiver.handle
    with pytest.raises(ProvisionError) as failure:
        await receiver.provision(provider_url=BASE_URL, provisioner_token="wrong", url=RECEIVER_URL, http=provider.async_http())
    assert failure.value.status == 401 and not isinstance(failure.value, WebhookVerificationFailed)
    assert str(failure.value) == "provisioning failed (HTTP 401)"


async def test_asgi_app_serves_on_a_starlette_route_without_redirecting():
    pytest.importorskip("starlette")
    from starlette.applications import Starlette
    from starlette.routing import Route

    provider = FakeProvider()
    receiver = Receiver(secret=SECRET, registration_id="8246931c-4ce0-4c15-a94a-e9c078ad06e2", resumers={})
    app = Starlette(routes=[Route("/aap/events", receiver.asgi(), methods=["POST"])])
    import httpx

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://agent.test") as http:
        headers, body = verification("8246931c-4ce0-4c15-a94a-e9c078ad06e2")
        response = await http.post("/aap/events", headers=headers, content=body)
        assert response.status_code == 200 and response.json() == {"challenge": "2edc34d7"}
        headers, body = provider.webhook("7ab8c8ec-7b2d-4fd6-9b52-752f9515eb71")
        assert (await http.post("/aap/events", headers=headers, content=body)).status_code == 204
