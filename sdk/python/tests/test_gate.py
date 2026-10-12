from __future__ import annotations

import threading
from datetime import timedelta

import httpx
import pytest

from agentapprovalprotocol import Allow, AsyncGate, Call, Deny, Gate, Pending
from agentapprovalprotocol.testing import FakeProvider


def call(**overrides) -> Call:
    values = dict(key="run-1:call-1", tool="issue_refund", arguments={"payment_id": "payment_123", "amount": 4900, "exact": 0.1}, server="stripe")
    values.update(overrides)
    return Call(**values)


def test_approved_call_is_consumed_and_reported():
    provider = FakeProvider()
    gate = Gate(provider.client())
    with gate.guard(call()) as verdict:
        assert isinstance(verdict, Allow)
    stored = provider.only()
    assert stored.consumed_at is not None
    assert stored.outcome["status"] == "succeeded"
    assert stored.body["context"]["call_id"] == "run-1:call-1"


def test_failure_inside_guard_reports_failed():
    provider = FakeProvider()
    with pytest.raises(RuntimeError):
        with Gate(provider.client()).guard(call()):
            raise RuntimeError("tool broke")
    assert provider.only().outcome["status"] == "failed"


def test_denial_carries_the_reviewers_note():
    provider = FakeProvider(auto=None)
    gate = Gate(provider.client(), mode="async")
    pending = gate.check(call())
    provider.decide(pending.request_id, "denied", "Refunds over 40 GBP need a manager.")
    verdict = gate.check(call())
    assert isinstance(verdict, Deny) and verdict.status == "denied"
    assert verdict.reason == "The provider denied this call: Refunds over 40 GBP need a manager."


def test_same_call_cannot_run_twice_across_replicas():
    provider = FakeProvider()
    results = []
    gates = [Gate(provider.client()) for _ in range(8)]
    threads = [threading.Thread(target=lambda g=g: results.append(g.check(call()))) for g in gates]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(isinstance(v, Allow) for v in results) == 1
    assert all(v.status == "consumed" for v in results if isinstance(v, Deny))
    assert len(provider.requests) == 1


def test_replay_after_consumption_is_refused():
    provider = FakeProvider()
    assert Gate(provider.client()).check(call())
    again = Gate(provider.client()).check(call())
    assert isinstance(again, Deny) and again.status == "consumed"


def test_async_mode_pauses_then_allows_the_same_request():
    provider = FakeProvider(auto=None)
    gate = Gate(provider.client(), mode="async")
    first = gate.check(call(resume={"framework": "test", "thread_id": "t1"}))
    assert isinstance(first, Pending)
    # A forged or early wake-up finds the request still pending.
    assert isinstance(gate.check(call(resume={"framework": "test", "thread_id": "t1"})), Pending)
    provider.decide(first.request_id)
    allowed = gate.check(call(resume={"framework": "test", "thread_id": "t1"}))
    assert isinstance(allowed, Allow) and allowed.request_id == first.request_id
    assert provider.only().body["context"]["resume"] == {"framework": "test", "thread_id": "t1"}


def test_changed_arguments_need_a_new_approval():
    provider = FakeProvider(auto=None)
    gate = Gate(provider.client(), mode="async")
    first = gate.check(call())
    provider.decide(first.request_id)
    changed = gate.check(call(arguments={"payment_id": "payment_123", "amount": 99999, "exact": 0.1}))
    assert isinstance(changed, Pending) and changed.request_id != first.request_id


def test_hybrid_waits_when_the_call_cannot_pause():
    provider = FakeProvider(auto=None)

    def approve_on_poll(request: httpx.Request):
        if request.method == "GET":
            for stored in provider.requests.values():
                provider._decide(stored, "approved", None)
        return None

    provider.intercept = approve_on_poll
    verdict = Gate(provider.client(), mode="async").check(call(), can_pause=False)
    assert isinstance(verdict, Allow)


def test_sync_wait_limit_cancels_and_denies():
    provider = FakeProvider(auto=None)
    verdict = Gate(provider.client(), wait_limit=0).check(call())
    assert isinstance(verdict, Deny) and verdict.status == "expired"
    assert provider.only().status == "cancelled"


def test_expired_approval_does_not_run():
    provider = FakeProvider(validity=timedelta(microseconds=1))
    verdict = Gate(provider.client()).check(call())
    assert isinstance(verdict, Deny) and verdict.status == "expired"
    assert provider.only().consumed_at is None


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, json={"surprise": True}),
        httpx.Response(500),
        httpx.Response(302, headers={"location": "https://elsewhere.test"}),
    ],
)
def test_bad_provider_responses_fail_closed(response):
    provider = FakeProvider()
    provider.intercept = lambda request: response
    verdict = Gate(provider.client(retry_budget=0.3)).check(call())
    assert isinstance(verdict, Deny) and verdict.status == "error"


def test_unreachable_provider_fails_closed():
    provider = FakeProvider()

    def down(request):
        raise httpx.ConnectError("refused")

    provider.intercept = down
    assert isinstance(Gate(provider.client(retry_budget=0.3)).check(call()), Deny)


def test_substituted_request_fails_closed():
    provider = FakeProvider()

    def substitute(request: httpx.Request):
        if request.method == "POST" and request.url.path.endswith("/requests"):
            response = provider._handle(request)
            body = response.json()
            body["arguments"]["amount"] = 1
            return httpx.Response(response.status_code, json=body)
        return None

    provider.intercept = substitute
    verdict = Gate(provider.client()).check(call())
    assert isinstance(verdict, Deny) and verdict.status == "error"
    assert provider.only().consumed_at is None


def test_refused_credential_says_so():
    provider = FakeProvider()
    provider.intercept = lambda request: httpx.Response(401)
    verdict = Gate(provider.client()).check(call())
    assert isinstance(verdict, Deny) and "refused this agent's credential" in verdict.reason


def test_consume_retry_keeps_its_key():
    provider = FakeProvider()
    keys = []

    def flaky(request: httpx.Request):
        if request.url.path.endswith("/consume"):
            keys.append(request.headers["idempotency-key"])
            if len(keys) == 1:
                return httpx.Response(503)
        return None

    provider.intercept = flaky
    assert isinstance(Gate(provider.client()).check(call()), Allow)
    assert len(keys) == 2 and keys[0] == keys[1]


async def test_async_gate_matches_the_sync_rules():
    provider = FakeProvider(auto=None)
    gate = AsyncGate(provider.async_client(), mode="async")
    pending = await gate.check(call())
    assert isinstance(pending, Pending)
    provider.decide(pending.request_id)
    async with gate.guard(call()) as verdict:
        assert isinstance(verdict, Allow)
    assert provider.only().outcome["status"] == "succeeded"
    replay = await AsyncGate(provider.async_client(), mode="async").check(call())
    assert isinstance(replay, Deny) and replay.status == "consumed"
