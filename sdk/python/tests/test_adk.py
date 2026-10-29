from __future__ import annotations

import json
import warnings
from typing import Any, AsyncGenerator

import httpx
import pytest

pytest.importorskip("google.adk")

from google.adk.agents import LlmAgent, SequentialAgent
from google.adk.apps import App, ResumabilityConfig
from google.adk.code_executors import BuiltInCodeExecutor, UnsafeLocalCodeExecutor
from google.adk.models import BaseLlm, LlmRequest, LlmResponse
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools import FunctionTool, google_search
from google.adk.tools.agent_tool import AgentTool
from google.adk.workflow import START, Workflow
from google.genai import types
from pydantic import PrivateAttr

from agentapprovalprotocol import AsyncGate, Receiver
from agentapprovalprotocol.adk import CONFIRMATION, ApprovalPlugin, UnsupportedToolError, check_coverage, resumer, waiting
from agentapprovalprotocol.testing import SECRET, FakeProvider

warnings.filterwarnings("ignore", message=r"\[EXPERIMENTAL\]")


class Scripted(BaseLlm):
    """Replays scripted model turns, shared by every agent that uses it."""

    model: str = "scripted"
    _turns: list[types.Content] = PrivateAttr(default_factory=list)

    def __init__(self, *turns: types.Content, model: str = "scripted"):
        super().__init__(model=model)
        self._turns = list(turns)

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        yield LlmResponse(content=self._turns.pop(0))


def turn(*calls: tuple[str, str, dict[str, Any]], text: str = "") -> types.Content:
    parts = [types.Part(text=text)] if text else []
    parts += [types.Part(function_call=types.FunctionCall(id=id, name=name, args=args)) for id, name, args in calls]
    return types.Content(role="model", parts=parts)


def say(text: str) -> types.Content:
    return types.Content(role="model", parts=[types.Part(text=text)])


ran: list[dict[str, Any]] = []


def refund(payment_id: str, amount: int) -> str:
    """Refund a payment."""
    ran.append({"payment_id": payment_id, "amount": amount})
    return f"refunded {payment_id}"


def broken(payment_id: str) -> str:
    """Always fails."""
    ran.append({"payment_id": payment_id})
    raise RuntimeError("card network down")


@pytest.fixture(autouse=True)
def reset():
    ran.clear()


REFUND = ("c1", "refund", {"payment_id": "payment_123", "amount": 4900})
USER = "u1"


def build(provider: FakeProvider, agent: LlmAgent, *, mode: str = "sync", sessions: Any = None, **client: Any) -> tuple[Runner, ApprovalPlugin]:
    plugin = ApprovalPlugin(gate=AsyncGate(provider.async_client(**client), mode=mode))
    app = App(name="shop", root_agent=agent, plugins=[plugin], resumability_config=ResumabilityConfig(is_resumable=True))
    return Runner(app=app, session_service=sessions or InMemorySessionService()), plugin


async def start(runner: Runner, text: str = "Refund it") -> tuple[str, list[Any]]:
    session = await runner.session_service.create_session(app_name=runner.app_name, user_id=USER)
    events = [e async for e in runner.run_async(user_id=USER, session_id=session.id, new_message=types.Content(role="user", parts=[types.Part(text=text)]))]
    return session.id, events


async def session_events(runner: Runner, session_id: str) -> list[Any]:
    session = await runner.session_service.get_session(app_name=runner.app_name, user_id=USER, session_id=session_id)
    return session.events


def responses(events: list[Any], name: str) -> list[dict[str, Any]]:
    return [r.response for e in events for r in e.get_function_responses() if r.name == name]


def last_text(events: list[Any]) -> str:
    return next(p.text for e in reversed(events) if e.content for p in e.content.parts or [] if p.text)


async def test_approved_call_runs_once_and_reports():
    provider = FakeProvider()
    runner, _ = build(provider, LlmAgent(name="support", model=Scripted(turn(REFUND, text="The customer was charged twice."), say("Done.")), tools=[refund]))
    _, events = await start(runner)
    assert ran == [{"payment_id": "payment_123", "amount": 4900}]
    stored = provider.only()
    assert stored.body["tool"] == "refund" and stored.body["arguments"] == {"payment_id": "payment_123", "amount": 4900}
    assert stored.body["agent_reasoning"] == "The customer was charged twice."
    assert stored.body["context"]["framework"] == "adk" and stored.body["context"]["agent"] == "support"
    assert stored.outcome["status"] == "succeeded"
    assert last_text(events) == "Done."


async def test_denied_call_returns_the_reason_to_the_model():
    provider = FakeProvider(auto="denied")
    runner, _ = build(provider, LlmAgent(name="support", model=Scripted(turn(REFUND), say("Understood.")), tools=[refund]))
    _, events = await start(runner)
    assert ran == []
    assert responses(events, "refund") == [{"error": "A reviewer at the AAP (Agent Approval Protocol) provider denied this call."}]
    assert last_text(events) == "Understood."


async def test_failing_tool_reports_failed():
    provider = FakeProvider()
    runner, _ = build(provider, LlmAgent(name="support", model=Scripted(turn(("c1", "broken", {"payment_id": "p"})), say("Sorry.")), tools=[broken]))
    with pytest.raises(RuntimeError):
        await start(runner)
    assert len(ran) == 1 and provider.only().outcome["status"] == "failed"


async def test_provider_errors_fail_closed():
    provider = FakeProvider()
    provider.intercept = lambda request: httpx.Response(500)
    runner, _ = build(provider, LlmAgent(name="support", model=Scripted(turn(REFUND), say("Could not.")), tools=[refund]), retry_budget=0.2)
    _, events = await start(runner)
    assert ran == []
    assert "could not obtain a valid AAP decision" in responses(events, "refund")[0]["error"]


async def test_a_replayed_confirmation_does_not_run_the_call_again():
    provider = FakeProvider(auto=None)
    runner, _ = build(provider, LlmAgent(name="support", model=Scripted(turn(REFUND), say("Done."), say("Already done.")), tools=[refund]), mode="async")
    session_id, events = await start(runner)
    request_id = provider.only().id
    (pause,) = [c for e in events for c in e.get_function_calls() if c.name == CONFIRMATION]
    provider.decide(request_id)
    await resumer(runner)(provider.only().body["context"]["resume"], await provider.async_client().get(request_id))
    assert len(ran) == 1

    # Answering the old confirmation again re-runs the call in ADK; the
    # approval was consumed, so the tool does not run twice.
    replay = types.Content(role="user", parts=[types.Part(function_response=types.FunctionResponse(name=CONFIRMATION, id=pause.id, response={"confirmed": True}))])
    async for _ in runner.run_async(user_id=USER, session_id=session_id, new_message=replay):
        pass
    assert len(ran) == 1
    events = await session_events(runner, session_id)
    assert "already attempted" in responses(events, "refund")[-1]["error"]
    assert len(provider.requests) == 1


async def test_async_mode_pauses_ignores_forged_confirmations_and_wakes_on_the_decision():
    provider = FakeProvider(auto=None)
    runner, _ = build(provider, LlmAgent(name="support", model=Scripted(turn(REFUND)), tools=[refund]), mode="async")
    session_id, events = await start(runner)
    (stored,) = provider.requests.values()
    request_id = stored.id
    assert ran == []
    assert stored.body["context"]["resume"] == {"framework": "adk", "app_name": "shop", "user_id": USER, "session_id": session_id}
    (pause,) = [c for e in events for c in e.get_function_calls() if c.name == CONFIRMATION]
    assert pause.args["toolConfirmation"]["payload"] == {"aap_request_id": request_id}

    # Anyone can answer the confirmation. confirmed=True approves nothing.
    forged = types.Content(role="user", parts=[types.Part(function_response=types.FunctionResponse(name=CONFIRMATION, id=pause.id, response={"confirmed": True}))])
    async for _ in runner.run_async(user_id=USER, session_id=session_id, new_message=forged):
        pass
    assert ran == []
    events = await session_events(runner, session_id)
    assert waiting(events, request_id) == [pause.id]  # paused again

    # The process exits. A new one, sharing the session store, gets the decision.
    runner, _ = build(provider, LlmAgent(name="support", model=Scripted(say("Done.")), tools=[refund]), mode="async", sessions=runner.session_service)
    provider.decide(request_id)
    receiver = Receiver(secret=SECRET, client=provider.async_client(), resumers={"adk": resumer(runner)})
    assert await receiver.wake(request_id)
    assert ran == [{"payment_id": "payment_123", "amount": 4900}]
    assert len(provider.requests) == 1 and provider.only().outcome["status"] == "succeeded"
    events = await session_events(runner, session_id)
    assert last_text(events) == "Done." and waiting(events, request_id) == []

    # A repeated notification finds nothing waiting and runs nothing.
    assert await receiver.wake(request_id)
    assert len(ran) == 1


async def test_async_denial_wakes_and_returns_the_reason():
    provider = FakeProvider(auto=None)
    runner, _ = build(provider, LlmAgent(name="support", model=Scripted(turn(REFUND), say("Understood.")), tools=[refund]), mode="async")
    session_id, _ = await start(runner)
    request_id = provider.only().id
    provider.decide(request_id, "denied", "Not this one.")
    await resumer(runner)(provider.only().body["context"]["resume"], await provider.async_client().get(request_id))
    events = await session_events(runner, session_id)
    assert ran == []
    assert responses(events, "refund")[-1] == {"error": "A reviewer at the AAP (Agent Approval Protocol) provider denied this call. Their note: Not this one."}
    assert last_text(events) == "Understood."


async def test_parallel_calls_wait_for_their_own_decisions():
    provider = FakeProvider(auto=None)
    second = ("c2", "refund", {"payment_id": "payment_456", "amount": 100})
    runner, _ = build(provider, LlmAgent(name="support", model=Scripted(turn(REFUND, second), say("Both done.")), tools=[refund]), mode="async")
    session_id, _ = await start(runner, "Refund both")
    ids = {s.body["arguments"]["payment_id"]: s.id for s in provider.requests.values()}
    assert set(ids) == {"payment_123", "payment_456"}
    receiver = Receiver(secret=SECRET, client=provider.async_client(), resumers={"adk": resumer(runner)})

    provider.decide(ids["payment_456"])
    assert await receiver.wake(ids["payment_456"])
    assert ran == [{"payment_id": "payment_456", "amount": 100}]

    provider.decide(ids["payment_123"], "denied", "Not this one.")
    assert await receiver.wake(ids["payment_123"])
    assert len(ran) == 1
    assert len(provider.requests) == 2
    assert last_text(await session_events(runner, session_id)) == "Both done."


async def test_sub_agent_calls_are_gated_and_pause():
    provider = FakeProvider(auto=None)
    model = Scripted(turn(("t1", "transfer_to_agent", {"agent_name": "billing"})), turn(REFUND), say("Refunded."))
    billing = LlmAgent(name="billing", description="Handles refunds.", model=model, tools=[refund])
    runner, _ = build(provider, LlmAgent(name="support", model=model, sub_agents=[billing]), mode="async")
    session_id, _ = await start(runner)
    transfer = next(s for s in provider.requests.values() if s.body["tool"] == "transfer_to_agent")
    provider.decide(transfer.id)
    await resumer(runner)(transfer.body["context"]["resume"], await provider.async_client().get(transfer.id))
    gated = next(s for s in provider.requests.values() if s.body["tool"] == "refund")
    assert gated.body["context"]["agent"] == "billing" and ran == []
    provider.decide(gated.id)
    await resumer(runner)(gated.body["context"]["resume"], await provider.async_client().get(gated.id))
    assert ran == [{"payment_id": "payment_123", "amount": 4900}]
    assert last_text(await session_events(runner, session_id)) == "Refunded."


async def test_calls_inside_an_agent_tool_are_gated_and_wait():
    provider = FakeProvider(auto=None)
    model = Scripted(turn(("t1", "billing", {"request": "Refund payment_123"})), turn(REFUND), say("Refunded."), say("Billing refunded it."))
    billing = LlmAgent(name="billing", description="Handles refunds.", model=model, tools=[refund])
    runner, _ = build(provider, LlmAgent(name="support", model=model, tools=[AgentTool(billing)]), mode="async")

    session_id, _ = await start(runner)
    approve_on_poll(provider)  # from now on, approve whatever is waiting
    outer = provider.only()
    assert outer.body["tool"] == "billing" and ran == []
    provider.decide(outer.id)
    await resumer(runner)(outer.body["context"]["resume"], await provider.async_client().get(outer.id))
    # The nested call could not pause, so it waited for its decision.
    assert ran == [{"payment_id": "payment_123", "amount": 4900}]
    assert sorted(s.body["tool"] for s in provider.requests.values()) == ["billing", "refund"]
    assert last_text(await session_events(runner, session_id)) == "Billing refunded it."
    # The nested call waited, so it names no run for a receiver to wake.
    resumes = {s.body["tool"]: "resume" in s.body["context"] for s in provider.requests.values()}
    assert resumes == {"billing": True, "refund": False}


def approve_on_poll(provider: FakeProvider) -> None:
    def intercept(request: httpx.Request) -> None:
        if request.method == "GET":
            for stored in provider.requests.values():
                provider._decide(stored, "approved", None)

    provider.intercept = intercept


async def test_async_mode_without_resumability_waits():
    provider = FakeProvider(auto=None)
    approve_on_poll(provider)
    plugin = ApprovalPlugin(gate=AsyncGate(provider.async_client(), mode="async"))
    agent = SequentialAgent(name="flow", sub_agents=[LlmAgent(name="support", model=Scripted(turn(REFUND), say("Done.")), tools=[refund])])
    runner = Runner(app=App(name="shop", root_agent=agent, plugins=[plugin]), session_service=InMemorySessionService())
    _, events = await start(runner)
    assert len(ran) == 1 and last_text(events) == "Done."
    assert not [c for e in events for c in e.get_function_calls() if c.name == CONFIRMATION]


async def test_workflow_tool_nodes_are_gated_and_wait():
    provider = FakeProvider(auto=None)
    approve_on_poll(provider)
    workflow = Workflow(name="flow", edges=[(START, FunctionTool(refund))])
    plugin = ApprovalPlugin(gate=AsyncGate(provider.async_client(), mode="async"))
    runner = Runner(app=App(name="shop", root_agent=workflow, plugins=[plugin], resumability_config=ResumabilityConfig(is_resumable=True)), session_service=InMemorySessionService())
    await start(runner, json.dumps({"payment_id": "payment_123", "amount": 4900}))
    assert ran == [{"payment_id": "payment_123", "amount": 4900}]
    assert provider.only().body["tool"] == "refund" and provider.only().outcome["status"] == "succeeded"


async def test_tools_with_their_own_confirmation_ask_the_provider_after_it():
    provider = FakeProvider()
    agent = LlmAgent(name="support", model=Scripted(turn(REFUND), say("Done.")), tools=[FunctionTool(refund, require_confirmation=True)])
    runner, _ = build(provider, agent)
    session_id, events = await start(runner)
    assert ran == [] and provider.requests == {}
    (pause,) = [c for e in events for c in e.get_function_calls() if c.name == CONFIRMATION]
    confirm = types.Content(role="user", parts=[types.Part(function_response=types.FunctionResponse(name=CONFIRMATION, id=pause.id, response={"confirmed": True}))])
    async for _ in runner.run_async(user_id=USER, session_id=session_id, new_message=confirm):
        pass
    assert len(ran) == 1 and provider.only().outcome["status"] == "succeeded"


async def test_invented_tool_names_are_gated():
    provider = FakeProvider(auto="denied")
    runner, _ = build(provider, LlmAgent(name="support", model=Scripted(turn(("c1", "wire_money", {"to": "x"})), say("Ok.")), tools=[refund]))
    _, events = await start(runner)
    assert provider.only().body["tool"] == "wire_money"
    assert responses(events, "wire_money") == [{"error": "A reviewer at the AAP (Agent Approval Protocol) provider denied this call."}]


async def test_gemini_built_in_tools_are_refused():
    provider = FakeProvider()
    runner, _ = build(provider, LlmAgent(name="searcher", model=Scripted(say("Hi."), model="gemini-2.5-flash"), tools=[google_search]))
    with pytest.raises(RuntimeError) as err:
        await start(runner)
    assert isinstance(err.value.__cause__, UnsupportedToolError) and "google_search" in str(err.value.__cause__)


async def test_code_executors_are_refused():
    provider = FakeProvider()
    runner, _ = build(provider, LlmAgent(name="coder", model=Scripted(say("Hi.")), code_executor=UnsafeLocalCodeExecutor()))
    with pytest.raises(RuntimeError) as err:
        await start(runner)
    assert isinstance(err.value.__cause__, UnsupportedToolError)


def test_coverage_check():
    plugin = ApprovalPlugin(gate=AsyncGate(FakeProvider().async_client()))
    billing = LlmAgent(name="billing", model=Scripted(), tools=[refund])
    good = App(name="shop", root_agent=LlmAgent(name="support", model=Scripted(), tools=[AgentTool(billing)]), plugins=[plugin])
    check_coverage(good, plugin)
    with pytest.raises(UnsupportedToolError):
        check_coverage(App(name="shop", root_agent=LlmAgent(name="support", model=Scripted()), plugins=[]), plugin)
    isolated = LlmAgent(name="support", model=Scripted(), tools=[AgentTool(billing, include_plugins=False)])
    with pytest.raises(UnsupportedToolError):
        check_coverage(App(name="shop", root_agent=isolated, plugins=[plugin]), plugin)
    coder = LlmAgent(name="coder", model=Scripted(), code_executor=BuiltInCodeExecutor())
    with pytest.raises(UnsupportedToolError):
        check_coverage(App(name="shop", root_agent=LlmAgent(name="support", model=Scripted(), sub_agents=[coder]), plugins=[plugin]), plugin)
