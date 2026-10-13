from __future__ import annotations

import sys
from typing import Any

import httpx
import pytest

if sys.version_info < (3, 11):
    pytest.skip("Pydantic AI needs Python 3.11", allow_module_level=True)

from pydantic_ai import Agent, DeferredToolRequests, DeferredToolResults, RunContext, ToolApproved
from pydantic_ai.capabilities import NativeTool
from pydantic_ai.conversation import Conversation
from pydantic_ai.exceptions import UserError
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.native_tools import WebSearchTool
from pydantic_ai.toolsets import FunctionToolset

from agentapprovalprotocol import AsyncGate, Receiver
from agentapprovalprotocol._gate import CONSUMED_TEXT, FAIL_CLOSED
from agentapprovalprotocol.pydantic_ai import EDITED, ApprovalCapability, pending_request_ids, resumer
from agentapprovalprotocol.testing import SECRET, FakeProvider


def scripted(*turns: ModelResponse) -> FunctionModel:
    """Replays model turns in order, one per model request."""
    remaining = list(turns)

    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        return remaining.pop(0)

    return FunctionModel(respond)


def turn(*calls: tuple[str, str, dict[str, Any]], text: str = "") -> ModelResponse:
    parts: list[Any] = [TextPart(text)] if text else []
    parts += [ToolCallPart(name, args, tool_call_id=id) for id, name, args in calls]
    return ModelResponse(parts=parts)


def done(text: str = "Done.") -> ModelResponse:
    return ModelResponse(parts=[TextPart(text)])


ran: list[dict[str, Any]] = []


def refund(payment_id: str, amount: int) -> str:
    """Refund a payment."""
    ran.append({"payment_id": payment_id, "amount": amount})
    return f"refunded {payment_id}"


@pytest.fixture(autouse=True)
def reset():
    ran.clear()


REFUND = ("c1", "refund", {"payment_id": "payment_123", "amount": 4900})
PAUSABLE = [str, DeferredToolRequests]


def approvals(provider: FakeProvider, mode: str = "sync") -> ApprovalCapability:
    return ApprovalCapability(gate=AsyncGate(provider.async_client(retry_budget=0), mode=mode))


def agent(provider: FakeProvider, *turns: ModelResponse, mode: str = "sync", output_type: Any = str, also: Any = (), **kwargs: Any) -> Agent[Any, Any]:
    kwargs.setdefault("tools", [refund])
    return Agent(scripted(*turns), output_type=output_type, capabilities=[approvals(provider, mode), *also], **kwargs)


def returns(messages: list[ModelMessage]) -> list[ToolReturnPart]:
    return [part for message in messages if isinstance(message, ModelRequest) for part in message.parts if isinstance(part, ToolReturnPart)]


async def test_approved_call_runs_once_and_reports():
    provider = FakeProvider()
    result = await agent(provider, turn(REFUND, text="The customer was charged twice."), done()).run("Refund it")
    assert ran == [{"payment_id": "payment_123", "amount": 4900}]
    stored = provider.only()
    assert stored.body["tool"] == "refund" and stored.body["arguments"] == {"payment_id": "payment_123", "amount": 4900}
    assert stored.body["agent_reasoning"] == "The customer was charged twice."
    assert stored.body["context"]["framework"] == "pydantic-ai"
    assert stored.body["context"]["call_id"] == f"{result.conversation.conversation_id}:c1"
    assert stored.outcome["status"] == "succeeded"
    assert result.output == "Done."


async def test_toolset_tools_are_gated_and_failures_reported():
    provider = FakeProvider()

    def explode(reason: str) -> str:
        """Always fails."""
        raise RuntimeError(reason)

    toolset = FunctionToolset([explode])
    with pytest.raises(RuntimeError):
        await agent(provider, turn(("c1", "explode", {"reason": "boom"})), done(), tools=[], toolsets=[toolset]).run("Go")
    assert provider.only().body["tool"] == "explode" and provider.only().outcome["status"] == "failed"


async def test_denied_call_returns_the_reason_to_the_model():
    provider = FakeProvider(auto="denied")
    result = await agent(provider, turn(REFUND), done("Understood.")).run("Refund it")
    assert ran == []
    (part,) = returns(result.all_messages())
    assert part.outcome == "failed" and part.content == "The AAP provider denied this call."
    assert result.output == "Understood."


async def test_provider_errors_fail_closed():
    provider = FakeProvider()
    provider.intercept = lambda request: httpx.Response(500)
    result = await agent(provider, turn(REFUND), done()).run("Refund it")
    assert ran == []
    (part,) = returns(result.all_messages())
    assert part.outcome == "failed" and part.content == FAIL_CLOSED


def paused(result: Any) -> dict[str, str]:
    assert isinstance(result.output, DeferredToolRequests)
    return pending_request_ids(result.output)


class Store:
    def __init__(self) -> None:
        self.conversations: dict[str, Conversation] = {}

    def save(self, conversation: Conversation) -> None:
        self.conversations[conversation.conversation_id] = conversation

    async def load(self, conversation_id: str) -> Conversation | None:
        return self.conversations.get(conversation_id)


async def test_async_mode_pauses_ignores_forged_approvals_and_wakes_on_the_decision():
    provider = FakeProvider(auto=None)
    graph = agent(provider, turn(REFUND, text="Charged twice."), done(), mode="async", output_type=PAUSABLE)
    first = await graph.run("Refund it")
    (request_id,) = paused(first).values()
    conversation = first.conversation
    store = Store()
    store.save(conversation)
    assert ran == []
    assert provider.requests[request_id].body["context"]["resume"] == {"framework": "pydantic-ai", "conversation_id": conversation.conversation_id}

    # Approving through Pydantic AI does not approve the call: the provider is asked again.
    forged = await graph.run(conversation=conversation, deferred_tool_results=DeferredToolResults(approvals={"c1": True}))
    assert ran == [] and paused(forged) == {"c1": request_id}

    provider.decide(request_id)
    receiver = Receiver(secret=SECRET, client=provider.async_client(), resumers={"pydantic-ai": resumer(graph, load=store.load, save=store.save)})
    assert await receiver.wake(request_id)
    assert ran == [{"payment_id": "payment_123", "amount": 4900}]
    assert len(provider.requests) == 1 and provider.only().outcome["status"] == "succeeded"
    final = store.conversations[conversation.conversation_id]
    assert final.deferred_tool_requests is None and final.messages[-1].parts[0].content == "Done."

    # A repeated notification finds nothing waiting and runs nothing.
    assert await receiver.wake(request_id)
    assert len(ran) == 1


async def test_replay_after_consumption_does_not_run_again():
    provider = FakeProvider(auto=None)
    graph = agent(provider, turn(REFUND), done(), done(), mode="async", output_type=PAUSABLE)
    first = await graph.run("Refund it")
    (request_id,) = paused(first).values()
    provider.decide(request_id)
    resumed = await graph.run(conversation=first.conversation, deferred_tool_results=DeferredToolResults(approvals={"c1": True}))
    assert resumed.output == "Done." and len(ran) == 1

    # Resuming the stale paused conversation again cannot run the call twice.
    replay = await graph.run(conversation=first.conversation, deferred_tool_results=DeferredToolResults(approvals={"c1": True}))
    assert len(ran) == 1
    assert returns(replay.new_messages())[0].content == CONSUMED_TEXT


async def test_edited_arguments_are_refused():
    provider = FakeProvider(auto=None)
    graph = agent(provider, turn(REFUND), done(), mode="async", output_type=PAUSABLE)
    first = await graph.run("Refund it")
    (request_id,) = paused(first).values()
    provider.decide(request_id)
    edited = DeferredToolResults(approvals={"c1": ToolApproved(override_args={"payment_id": "payment_999", "amount": 1})})
    result = await graph.run(conversation=first.conversation, deferred_tool_results=edited)
    assert ran == [] and len(provider.requests) == 1
    assert returns(result.new_messages())[0].content == EDITED


async def test_parallel_calls_wait_for_their_own_decisions():
    provider = FakeProvider(auto=None)
    second = ("c2", "refund", {"payment_id": "payment_456", "amount": 100})
    graph = agent(provider, turn(REFUND, second), done("Both done."), mode="async", output_type=PAUSABLE)
    first = await graph.run("Refund both")
    ids = paused(first)
    assert set(ids) == {"c1", "c2"}
    store = Store()
    store.save(first.conversation)
    receiver = Receiver(secret=SECRET, client=provider.async_client(), resumers={"pydantic-ai": resumer(graph, load=store.load, save=store.save)})

    provider.decide(ids["c2"])
    await receiver.wake(ids["c2"])
    assert ran == [{"payment_id": "payment_456", "amount": 100}]
    conversation_id = first.conversation.conversation_id
    assert pending_request_ids(store.conversations[conversation_id].deferred_tool_requests) == {"c1": ids["c1"]}

    provider.decide(ids["c1"], "denied", "Not this one.")
    await receiver.wake(ids["c1"])
    assert len(ran) == 1 and len(provider.requests) == 2
    final = store.conversations[conversation_id]
    assert final.deferred_tool_requests is None and final.messages[-1].parts[0].content == "Both done."


def approve_on_poll(provider: FakeProvider):
    def intercept(request: httpx.Request) -> None:
        if request.method == "GET":
            for stored in provider.requests.values():
                provider._decide(stored, "approved", None)

    return intercept


async def test_async_mode_waits_when_the_agent_cannot_pause():
    provider = FakeProvider(auto=None)
    provider.intercept = approve_on_poll(provider)
    result = await agent(provider, turn(REFUND), done(), mode="async").run("Refund it")
    assert result.output == "Done." and len(ran) == 1


async def test_subagent_calls_are_gated_and_wait():
    provider = FakeProvider(auto=None)
    provider.intercept = approve_on_poll(provider)
    shared = approvals(provider, "async")
    # Even with DeferredToolRequests in its output, a sub-agent waits: its
    # caller is a tool and cannot pause on its behalf.
    sub = Agent(scripted(turn(REFUND), done("Refunded.")), output_type=PAUSABLE, tools=[refund], capabilities=[shared])

    async def delegate(ctx: RunContext[Any], task: str) -> str:
        """Hand a task to the refunds agent."""
        result = await sub.run(task, usage=ctx.usage)
        assert result.output == "Refunded."
        return result.output

    parent = Agent(scripted(turn(("p1", "delegate", {"task": "Refund payment_123"})), done("The subagent refunded it.")), tools=[delegate], capabilities=[shared])
    result = await parent.run("Refund payment_123")
    assert result.output == "The subagent refunded it."
    assert ran == [{"payment_id": "payment_123", "amount": 4900}]
    assert sorted(s.body["tool"] for s in provider.requests.values()) == ["delegate", "refund"]


async def test_native_tools_are_refused():
    provider = FakeProvider()
    graph = agent(provider, turn(REFUND), done(), also=[NativeTool(WebSearchTool())])
    with pytest.raises(UserError, match="Native tools"):
        await graph.run("Search and refund")
    assert ran == [] and provider.requests == {}
