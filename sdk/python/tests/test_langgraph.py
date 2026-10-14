from __future__ import annotations

import asyncio
import sys
from typing import Any

import pytest

pytest.importorskip("langgraph")
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from agentapprovalprotocol import AsyncGate, Gate, Receiver
from agentapprovalprotocol.langgraph import ApprovalMiddleware, deep_agent_subagents, resumer
from agentapprovalprotocol.testing import SECRET, FakeProvider


class Scripted(GenericFakeChatModel):
    """Replays scripted model turns; tools are bound by name only."""

    def bind_tools(self, tools: Any, **kwargs: Any) -> "Scripted":
        return self


def turn(*calls: tuple[str, str, dict[str, Any]], text: str = "") -> AIMessage:
    return AIMessage(content=text, tool_calls=[{"name": name, "id": id, "args": args} for id, name, args in calls])


ran: list[dict[str, Any]] = []


def refund(payment_id: str, amount: int) -> str:
    """Refund a payment."""
    ran.append({"payment_id": payment_id, "amount": amount})
    return f"refunded {payment_id}"


@pytest.fixture(autouse=True)
def reset():
    ran.clear()


def agent(provider: FakeProvider, *turns: AIMessage, mode: str = "sync", checkpointer: Any = None):
    middleware = ApprovalMiddleware(gate=Gate(provider.client(), mode=mode), async_gate=AsyncGate(provider.async_client(), mode=mode))
    return create_agent(Scripted(messages=iter(turns)), tools=[refund], middleware=[middleware], checkpointer=checkpointer)


REFUND = ("c1", "refund", {"payment_id": "payment_123", "amount": 4900})


def test_approved_call_runs_once_and_reports():
    provider = FakeProvider()
    result = agent(provider, turn(REFUND, text="The customer was charged twice."), AIMessage("Done.")).invoke({"messages": [HumanMessage("Refund it")]})
    assert ran == [{"payment_id": "payment_123", "amount": 4900}]
    stored = provider.only()
    assert stored.body["tool"] == "refund" and stored.body["agent_reasoning"] == "The customer was charged twice."
    assert stored.body["context"]["framework"] == "langgraph"
    assert stored.outcome["status"] == "succeeded"
    assert result["messages"][-1].content == "Done."


def test_denied_call_returns_the_reason_to_the_model():
    provider = FakeProvider(auto="denied")
    result = agent(provider, turn(REFUND), AIMessage("Understood.")).invoke({"messages": [HumanMessage("Refund it")]})
    assert ran == []
    message = next(m for m in result["messages"] if isinstance(m, ToolMessage))
    assert message.status == "error" and message.content == "The AAP provider denied this call."


def test_async_mode_pauses_ignores_forged_resumes_and_wakes_on_the_decision():
    provider = FakeProvider(auto=None)
    graph = agent(provider, turn(REFUND), AIMessage("Done."), mode="async", checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "t1"}}
    paused = graph.invoke({"messages": [HumanMessage("Refund it")]}, config)
    (pending,) = paused["__interrupt__"]
    request_id = pending.value["aap_request_id"]
    assert ran == [] and provider.requests[request_id].body["context"]["resume"] == {"framework": "langgraph", "thread_id": "t1"}

    forged = graph.invoke(Command(resume={"decisions": [{"type": "approve"}]}), config)
    assert ran == [] and forged["__interrupt__"]

    provider.decide(request_id)
    receiver = Receiver(secret=SECRET, client=provider.async_client(), resumers={"langgraph": resumer(graph)})

    async def deliver():
        assert await receiver.wake(request_id)

    asyncio.run(deliver())
    assert ran == [{"payment_id": "payment_123", "amount": 4900}]
    assert len(provider.requests) == 1
    assert graph.get_state(config).values["messages"][-1].content == "Done."
    # A repeated notification finds nothing waiting and runs nothing.
    asyncio.run(deliver())
    assert len(ran) == 1


def test_parallel_calls_wait_for_their_own_decisions():
    provider = FakeProvider(auto=None)
    second = ("c2", "refund", {"payment_id": "payment_456", "amount": 100})
    graph = agent(provider, turn(REFUND, second), AIMessage("Both done."), mode="async", checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "t2"}}
    paused = graph.invoke({"messages": [HumanMessage("Refund both")]}, config)
    ids = {i.value["tool_call_id"]: i.value["aap_request_id"] for i in paused["__interrupt__"]}
    assert set(ids) == {"c1", "c2"}
    receiver = Receiver(secret=SECRET, client=provider.async_client(), resumers={"langgraph": resumer(graph)})

    provider.decide(ids["c2"])
    asyncio.run(receiver.wake(ids["c2"]))
    assert ran == [{"payment_id": "payment_456", "amount": 100}]

    provider.decide(ids["c1"], "denied", "Not this one.")
    asyncio.run(receiver.wake(ids["c1"]))
    assert len(ran) == 1
    assert graph.get_state(config).values["messages"][-1].content == "Both done."
    assert len(provider.requests) == 2


def test_async_mode_without_a_checkpointer_waits():
    provider = FakeProvider(auto=None)

    def approve_on_poll(request):
        if request.method == "GET":
            for stored in provider.requests.values():
                provider._decide(stored, "approved", None)

    provider.intercept = approve_on_poll
    agent(provider, turn(REFUND), AIMessage("Done."), mode="async").invoke({"messages": [HumanMessage("Refund it")]})
    assert len(ran) == 1


@pytest.mark.skipif(sys.version_info < (3, 11), reason="Deep Agents needs Python 3.11")
def test_deep_agent_subagent_calls_are_gated():
    from deepagents import create_deep_agent

    provider = FakeProvider()
    middleware = ApprovalMiddleware(gate=Gate(provider.client()), async_gate=AsyncGate(provider.async_client()))
    model = Scripted(
        messages=iter(
            [
                turn(("t1", "task", {"description": "Refund payment_123", "subagent_type": "general-purpose"})),
                turn(REFUND),
                AIMessage("Refunded."),
                AIMessage("The subagent refunded it."),
            ]
        )
    )
    graph = create_deep_agent(model=model, tools=[refund], middleware=[middleware], subagents=deep_agent_subagents(middleware))
    graph.invoke({"messages": [HumanMessage("Refund payment_123")]})
    assert ran == [{"payment_id": "payment_123", "amount": 4900}]
    assert sorted(s.body["tool"] for s in provider.requests.values()) == ["refund", "task"]


@pytest.mark.skipif(sys.version_info < (3, 11), reason="Deep Agents needs Python 3.11")
def test_deep_agent_subagent_calls_wait_in_async_mode():
    from deepagents import create_deep_agent

    provider = FakeProvider(auto=None)

    def approve_the_waiting_refund(request):
        if request.method == "GET":
            for stored in provider.requests.values():
                if stored.body["tool"] == "refund":
                    provider._decide(stored, "approved", None)

    provider.intercept = approve_the_waiting_refund
    middleware = ApprovalMiddleware(gate=Gate(provider.client(), mode="async"), async_gate=AsyncGate(provider.async_client(), mode="async"))
    model = Scripted(
        messages=iter(
            [
                turn(("t1", "task", {"description": "Refund payment_123", "subagent_type": "general-purpose"})),
                turn(REFUND),
                AIMessage("Refunded."),
                AIMessage("The subagent refunded it."),
            ]
        )
    )
    graph = create_deep_agent(model=model, tools=[refund], middleware=[middleware], subagents=deep_agent_subagents(middleware), checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "t3"}}
    paused = graph.invoke({"messages": [HumanMessage("Refund payment_123")]}, config)
    (pending,) = paused["__interrupt__"]
    assert pending.value["tool"] == "task"

    provider.decide(pending.value["aap_request_id"])
    receiver = Receiver(secret=SECRET, client=provider.async_client(), resumers={"langgraph": resumer(graph)})
    assert asyncio.run(receiver.wake(pending.value["aap_request_id"]))
    # The subagent's call waited inside the approved task instead of pausing, so it ran.
    assert ran == [{"payment_id": "payment_123", "amount": 4900}]
    assert {s.body["tool"]: s.outcome["status"] for s in provider.requests.values()} == {"task": "succeeded", "refund": "succeeded"}
    state = graph.get_state(config)
    assert not state.interrupts and state.values["messages"][-1].content == "The subagent refunded it."


@pytest.mark.skipif(sys.version_info < (3, 11), reason="Deep Agents needs Python 3.11")
def test_deep_agent_helper_refuses_graphs_it_cannot_reach():
    middleware = ApprovalMiddleware(gate=Gate(FakeProvider().client()))
    with pytest.raises(ValueError):
        deep_agent_subagents(middleware, [{"name": "remote", "description": "Remote", "graph_id": "remote"}])
