from __future__ import annotations

from typing import Any

import httpx
import pytest
from agents import (
    Agent,
    AgentHooks,
    CodeInterpreterTool,
    FileSearchTool,
    HostedMCPTool,
    LocalShellTool,
    Runner,
    RunState,
    WebSearchTool,
    function_tool,
    set_tracing_disabled,
)
from agents.exceptions import ToolInputGuardrailTripwireTriggered
from agents.mcp import MCPServer
from agents.testing import ScriptedModel, assistant_message, function_call
from mcp.types import CallToolResult, TextContent, Tool as MCPTool
from openai.types.responses.response_output_item import McpApprovalRequest

from agentapprovalprotocol import AsyncGate, Receiver
from agentapprovalprotocol._gate import CONSUMED_TEXT, FAIL_CLOSED
from agentapprovalprotocol.openai_agents import Approvals
from agentapprovalprotocol.testing import SECRET, FakeProvider

set_tracing_disabled(True)

ran: list[dict[str, Any]] = []


@function_tool
def refund(payment_id: str, amount: int) -> str:
    """Refund a payment."""
    ran.append({"payment_id": payment_id, "amount": amount})
    return f"refunded {payment_id}"


@pytest.fixture(autouse=True)
def reset():
    ran.clear()
    # The tool is shared across tests; each test protects it afresh.
    refund.tool_input_guardrails = refund.tool_output_guardrails = None
    refund.needs_approval = False


REFUND = {"payment_id": "payment_123", "amount": 4900}


def refund_turn(call_id: str = "c1", args: dict[str, Any] = REFUND, text: str | None = None) -> list[Any]:
    return [*([assistant_message(text)] if text else []), function_call("refund", args, call_id=call_id)]


def approvals(provider: FakeProvider, mode: str = "sync", store: dict[str, str] | None = None) -> Approvals:
    options: dict[str, Any] = {}
    if store is not None:
        options = {"save": store.__setitem__, "load": store.get}
    return Approvals(gate=AsyncGate(provider.async_client(), mode=mode), **options)


def outputs(model: ScriptedModel) -> list[str]:
    """Tool results the model saw on its last call."""
    return [item["output"] for item in model.last_call.input if isinstance(item, dict) and item.get("type") == "function_call_output"]


async def test_approved_call_runs_once_and_reports():
    provider = FakeProvider()
    model = ScriptedModel([refund_turn(text="The customer was charged twice."), [assistant_message("Done.")]])
    agent = approvals(provider).protect(Agent(name="support", model=model, tools=[refund]))
    result = await Runner.run(agent, "Refund it")
    assert ran == [REFUND]
    stored = provider.only()
    assert stored.body["tool"] == "refund" and stored.body["arguments"] == REFUND
    assert stored.body["agent_reasoning"] == "The customer was charged twice."
    assert stored.body["context"]["framework"] == "openai-agents"
    assert stored.outcome["status"] == "succeeded"
    assert result.final_output == "Done."


async def test_denied_call_returns_the_reason_to_the_model():
    provider = FakeProvider(auto="denied")
    model = ScriptedModel([refund_turn(), [assistant_message("Understood.")]])
    agent = approvals(provider).protect(Agent(name="support", model=model, tools=[refund]))
    await Runner.run(agent, "Refund it")
    assert ran == []
    assert outputs(model) == ["The provider denied this call."]


async def test_a_replayed_call_does_not_run_again():
    provider = FakeProvider()
    model = ScriptedModel([refund_turn(), [assistant_message("Done.")], refund_turn(), [assistant_message("Done again.")]])
    agent = approvals(provider).protect(Agent(name="support", model=model, tools=[refund]))
    await Runner.run(agent, "Refund it")
    await Runner.run(agent, "Refund it")
    assert ran == [REFUND]
    assert len(provider.requests) == 1
    assert outputs(model) == [CONSUMED_TEXT]


async def test_provider_errors_fail_closed():
    provider = FakeProvider()
    provider.intercept = lambda request: httpx.Response(500) if request.method == "POST" else None
    model = ScriptedModel([refund_turn(), [assistant_message("Understood.")]])
    gate = Approvals(gate=AsyncGate(provider.async_client(retry_budget=0.3)))
    agent = gate.protect(Agent(name="support", model=model, tools=[refund]))
    await Runner.run(agent, "Refund it")
    assert ran == []
    assert outputs(model) == [FAIL_CLOSED]


async def test_the_agents_own_hooks_still_run():
    class Hooks(AgentHooks):
        def __init__(self) -> None:
            self.responses = 0

        async def on_llm_end(self, context: Any, agent: Any, response: Any) -> None:
            self.responses += 1

    hooks = Hooks()
    provider = FakeProvider()
    model = ScriptedModel([refund_turn(text="Charged twice."), [assistant_message("Done.")]])
    agent = approvals(provider).protect(Agent(name="support", model=model, tools=[refund], hooks=hooks))
    await Runner.run(agent, "Refund it")
    assert hooks.responses == 2 and provider.only().body["agent_reasoning"] == "Charged twice."


async def test_async_mode_pauses_ignores_forged_approvals_and_wakes_on_the_decision():
    provider = FakeProvider(auto=None)
    store: dict[str, str] = {}
    model = ScriptedModel([refund_turn(), [assistant_message("Done.")]])
    gate = approvals(provider, "async", store)
    agent = gate.protect(Agent(name="support", model=model, tools=[refund]))

    paused = await gate.run(agent, "Refund it", run_id="r1")
    assert [item.call_id for item in paused.interruptions] == ["c1"]
    stored = provider.only()
    assert ran == [] and stored.body["context"]["resume"] == {"framework": "openai-agents", "run_id": "r1"}

    # Resuming without an approval pauses again.
    forged = await Runner.run(agent, await RunState.from_string(agent, store["r1"]))
    assert ran == [] and forged.interruptions
    # Approving the run state directly does not run the call: only the provider approves.
    state = await RunState.from_string(agent, store["r1"])
    state.approve(state.get_interruptions()[0])
    with pytest.raises(ToolInputGuardrailTripwireTriggered):
        await Runner.run(agent, state)
    assert ran == []

    receiver = Receiver(secret=SECRET, client=provider.async_client(), resumers={"openai-agents": gate.resumer(agent)})
    # A wake before the decision runs nothing.
    assert await receiver.wake(stored.id)
    assert ran == []

    provider.decide(stored.id)
    assert await receiver.wake(stored.id)
    assert ran == [REFUND]
    assert len(provider.requests) == 1 and stored.outcome["status"] == "succeeded"
    finished = await RunState.from_string(agent, store["r1"])
    assert finished.get_interruptions() == [] and model.remaining_steps == 0
    # A repeated notification finds nothing waiting and runs nothing.
    assert await receiver.wake(stored.id)
    assert len(ran) == 1


async def test_async_mode_denial_returns_the_reason():
    provider = FakeProvider(auto=None)
    store: dict[str, str] = {}
    model = ScriptedModel([refund_turn(), [assistant_message("Understood.")]])
    gate = approvals(provider, "async", store)
    agent = gate.protect(Agent(name="support", model=model, tools=[refund]))
    await gate.run(agent, "Refund it", run_id="r1")
    stored = provider.only()
    provider.decide(stored.id, "denied", "Not today.")
    receiver = Receiver(secret=SECRET, client=provider.async_client(), resumers={"openai-agents": gate.resumer(agent)})
    assert await receiver.wake(stored.id)
    assert ran == [] and model.remaining_steps == 0
    assert outputs(model) == ["The provider denied this call: Not today."]


async def test_parallel_calls_wait_for_their_own_decisions():
    provider = FakeProvider(auto=None)
    store: dict[str, str] = {}
    second = {"payment_id": "payment_456", "amount": 100}
    model = ScriptedModel([[*refund_turn("c1"), *refund_turn("c2", second)], [assistant_message("Both done.")]])
    gate = approvals(provider, "async", store)
    agent = gate.protect(Agent(name="support", model=model, tools=[refund]))
    paused = await gate.run(agent, "Refund both", run_id="r2")
    assert sorted(item.call_id for item in paused.interruptions) == ["c1", "c2"]
    ids = {s.body["arguments"]["payment_id"]: s.id for s in provider.requests.values()}
    receiver = Receiver(secret=SECRET, client=provider.async_client(), resumers={"openai-agents": gate.resumer(agent)})

    provider.decide(ids["payment_456"])
    await receiver.wake(ids["payment_456"])
    assert ran == [second]

    provider.decide(ids["payment_123"], "denied", "Not this one.")
    await receiver.wake(ids["payment_123"])
    assert ran == [second]
    assert model.remaining_steps == 0
    assert sorted(outputs(model)) == ["The provider denied this call: Not this one.", "refunded payment_456"]
    assert len(provider.requests) == 2


async def test_async_mode_without_a_store_waits():
    provider = FakeProvider(auto=None)

    def approve_on_poll(request):
        if request.method == "GET":
            for stored in provider.requests.values():
                provider._decide(stored, "approved", None)

    provider.intercept = approve_on_poll
    model = ScriptedModel([refund_turn(), [assistant_message("Done.")]])
    gate = approvals(provider, "async")
    agent = gate.protect(Agent(name="support", model=model, tools=[refund]))
    result = await gate.run(agent, "Refund it")
    assert ran == [REFUND] and result.final_output == "Done."


def refund_agent(model: ScriptedModel) -> Agent[Any]:
    return Agent(name="refunds", model=model, tools=[refund], handoff_description="Refunds payments.")


async def test_agents_used_as_tools_are_gated():
    provider = FakeProvider()
    inner = ScriptedModel([refund_turn(), [assistant_message("Refunded.")]])
    outer = ScriptedModel([[function_call("refunder", {"input": "Refund payment_123"}, call_id="o1")], [assistant_message("The subagent refunded it.")]])
    agent = Agent(name="support", model=outer, tools=[refund_agent(inner).as_tool("refunder", "Refund a payment.")])
    approvals(provider).protect(agent)
    await Runner.run(agent, "Refund payment_123")
    assert ran == [REFUND]
    assert sorted(s.body["tool"] for s in provider.requests.values()) == ["refund", "refunder"]


async def test_async_mode_pauses_inside_agents_used_as_tools():
    provider = FakeProvider(auto=None)
    store: dict[str, str] = {}
    inner = ScriptedModel([refund_turn(), [assistant_message("Refunded.")]])
    outer = ScriptedModel([[function_call("refunder", {"input": "Refund payment_123"}, call_id="o1")], [assistant_message("The subagent refunded it.")]])
    gate = approvals(provider, "async", store)
    agent = gate.protect(Agent(name="support", model=outer, tools=[refund_agent(inner).as_tool("refunder", "Refund a payment.")]))
    receiver = Receiver(secret=SECRET, client=provider.async_client(), resumers={"openai-agents": gate.resumer(agent)})

    await gate.run(agent, "Refund payment_123", run_id="r3")
    (outer_request,) = provider.requests.values()
    provider.decide(outer_request.id)
    await receiver.wake(outer_request.id)
    assert ran == []
    (inner_request,) = [s for s in provider.requests.values() if s.body["tool"] == "refund"]

    provider.decide(inner_request.id)
    await receiver.wake(inner_request.id)
    assert ran == [REFUND]
    assert inner.remaining_steps == 0 and outer.remaining_steps == 0
    assert len(provider.requests) == 2


async def test_handoff_targets_are_gated():
    provider = FakeProvider()
    inner = ScriptedModel([refund_turn(), [assistant_message("Refunded.")]])
    triage = ScriptedModel([[function_call("transfer_to_refunds", {}, call_id="h1")]])
    agent = Agent(name="triage", model=triage, handoffs=[refund_agent(inner)])
    approvals(provider).protect(agent)
    result = await Runner.run(agent, "Refund payment_123")
    assert ran == [REFUND] and result.final_output == "Refunded."
    assert provider.only().body["tool"] == "refund"


@pytest.mark.parametrize(
    "tool",
    [
        WebSearchTool(),
        FileSearchTool(vector_store_ids=["vs_1"]),
        CodeInterpreterTool(tool_config={"type": "code_interpreter", "container": {"type": "auto"}}),
        LocalShellTool(executor=lambda request: ""),
    ],
)
def test_tools_that_cannot_be_gated_are_refused(tool):
    gate = approvals(FakeProvider())
    with pytest.raises(ValueError):
        gate.protect(Agent(name="support", tools=[tool]))
    # Also when reached through a handoff.
    with pytest.raises(ValueError):
        gate.protect(Agent(name="triage", handoffs=[Agent(name="research", tools=[tool])]))


class CRM(MCPServer):
    """A local MCP server in this process."""

    def __init__(self) -> None:
        super().__init__()
        self.calls: list[tuple[str, Any]] = []

    @property
    def name(self) -> str:
        return "crm"

    async def connect(self) -> None:
        pass

    async def cleanup(self) -> None:
        pass

    async def list_tools(self, run_context: Any = None, agent: Any = None) -> list[MCPTool]:
        return [MCPTool(name="update_contact", inputSchema={"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]})]

    async def call_tool(self, tool_name: str, arguments: Any, meta: Any = None) -> CallToolResult:
        self.calls.append((tool_name, arguments))
        return CallToolResult(content=[TextContent(type="text", text="updated")])

    async def list_prompts(self) -> Any:
        raise NotImplementedError

    async def get_prompt(self, name: str, arguments: Any = None) -> Any:
        raise NotImplementedError


async def test_local_mcp_tools_are_gated_with_their_server():
    provider = FakeProvider()
    crm = CRM()
    model = ScriptedModel([[function_call("update_contact", {"id": "contact_1"}, call_id="m1")], [assistant_message("Done.")]])
    agent = approvals(provider).protect(Agent(name="support", model=model, mcp_servers=[crm]))
    await Runner.run(agent, "Update the contact")
    assert crm.calls == [("update_contact", {"id": "contact_1"})]
    stored = provider.only()
    assert (stored.body["tool"], stored.body["server"]) == ("update_contact", "crm")
    assert stored.outcome["status"] == "succeeded"


async def test_local_mcp_denial_does_not_call_the_server():
    provider = FakeProvider(auto="denied")
    crm = CRM()
    model = ScriptedModel([[function_call("update_contact", {"id": "contact_1"}, call_id="m1")], [assistant_message("Understood.")]])
    agent = approvals(provider).protect(Agent(name="support", model=model, mcp_servers=[crm]))
    await Runner.run(agent, "Update the contact")
    assert crm.calls == []
    assert outputs(model) == ["The provider denied this call."]


@pytest.mark.parametrize("status", ["approved", "denied"])
async def test_hosted_mcp_calls_go_through_the_approval_callback(status):
    provider = FakeProvider(auto=status)
    hosted = HostedMCPTool(tool_config={"type": "mcp", "server_label": "crm", "server_url": "https://crm.example.com/mcp"})
    request = McpApprovalRequest(id="mcpr_1", arguments='{"id": "contact_1"}', name="update_contact", server_label="crm", type="mcp_approval_request")
    model = ScriptedModel([[request], [assistant_message("Done.")]])
    agent = approvals(provider).protect(Agent(name="support", model=model, tools=[hosted]))
    assert hosted.tool_config["require_approval"] == "always"
    await Runner.run(agent, "Update the contact")
    stored = provider.only()
    assert (stored.body["tool"], stored.body["server"], stored.body["arguments"]) == ("update_contact", "crm", {"id": "contact_1"})
    (response,) = [item for item in model.last_call.input if isinstance(item, dict) and item.get("type") == "mcp_approval_response"]
    assert response["approve"] is (status == "approved")
