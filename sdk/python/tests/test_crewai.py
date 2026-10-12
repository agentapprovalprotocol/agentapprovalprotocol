from __future__ import annotations

import os
import socket
import tempfile
from typing import Any

import pytest

# Keep CrewAI offline: no telemetry, tracing, version checks or user storage.
_storage = tempfile.TemporaryDirectory()
os.environ.update(
    {
        "OTEL_SDK_DISABLED": "true",
        "CREWAI_DISABLE_TELEMETRY": "true",
        "CREWAI_DISABLE_TRACKING": "true",
        "CREWAI_TRACING_ENABLED": "false",
        "CREWAI_TESTING": "true",
        "CREWAI_DISABLE_VERSION_CHECK": "true",
        "CREWAI_STORAGE_DIR": _storage.name,
    }
)

pytest.importorskip("crewai", reason="CrewAI supports Python 3.10 to 3.13")

import httpx  # noqa: E402
from crewai import Agent, Crew, Task  # noqa: E402
from crewai.hooks import clear_all_global_hooks, register_before_tool_call_hook  # noqa: E402
from crewai.llms.base_llm import BaseLLM  # noqa: E402
from crewai.tools import BaseTool, tool  # noqa: E402
from crewai.tools.mcp_native_tool import MCPNativeTool  # noqa: E402

from agentapprovalprotocol import Gate  # noqa: E402
from agentapprovalprotocol._gate import CONSUMED_TEXT, FAIL_CLOSED  # noqa: E402
from agentapprovalprotocol.crewai import CHANGED, PROVIDER_TOOLS, SPENT, ApprovalHooks  # noqa: E402
from agentapprovalprotocol.testing import FakeProvider  # noqa: E402


class Scripted(BaseLLM):
    """Replays scripted model turns and records what the model was shown."""

    turns: list[Any] = []
    native: bool = True
    builtin_tools: list[str] | None = None
    seen: list[list[dict[str, Any]]] = []

    def call(self, messages: Any, tools: Any = None, callbacks: Any = None, available_functions: Any = None, from_task: Any = None, from_agent: Any = None, response_model: Any = None) -> Any:
        self.seen.append([dict(m) for m in messages] if isinstance(messages, list) else [{"role": "user", "content": messages}])
        return self.turns.pop(0)

    def supports_function_calling(self) -> bool:
        return self.native

    def supports_stop_words(self) -> bool:
        return False

    def get_context_window_size(self) -> int:
        return 100_000

    def tool_results(self) -> list[str]:
        """Tool results the model saw, in order, from either calling style."""
        out = []
        for message in self.seen[-1]:
            if message.get("role") == "tool":
                out.append(message["content"])
            elif message.get("role") == "assistant" and "\nObservation: " in str(message.get("content")):
                out.append(message["content"].split("\nObservation: ", 1)[1])
        return out


def native(*calls: tuple[str, str, dict[str, Any]]) -> list[dict[str, Any]]:
    import json

    return [{"id": id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}} for id, name, args in calls]


def react(name: str, args: dict[str, Any]) -> str:
    import json

    return f"Thought: I should use the tool.\nAction: {name}\nAction Input: {json.dumps(args)}"


ran: list[dict[str, Any]] = []


@tool("refund")
def refund(payment_id: str, amount: int) -> str:
    """Refund a payment."""
    ran.append({"payment_id": payment_id, "amount": amount})
    return f"refunded {payment_id}"


REFUND = ("c1", "refund", {"payment_id": "payment_123", "amount": 4900})


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    """Fail the test if anything tries to reach the network."""
    attempts: list[Any] = []

    def connect(self, address):
        attempts.append(address)
        raise OSError("network disabled in tests")

    def getaddrinfo(host, *args, **kwargs):
        attempts.append(host)
        raise OSError("network disabled in tests")

    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket, "getaddrinfo", getaddrinfo)
    ran.clear()
    clear_all_global_hooks()
    yield
    clear_all_global_hooks()
    assert attempts == []


def hooks(provider: FakeProvider, **options: Any) -> ApprovalHooks:
    return ApprovalHooks(gate=Gate(provider.client(retry_budget=0.5), **options)).install()


def crew(llm: Scripted, tools: list[BaseTool] | None = None) -> tuple[Crew, Task]:
    agent = Agent(role="Support", goal="Resolve refunds", backstory="Handles billing.", llm=llm, tools=tools if tools is not None else [refund])
    task = Task(description="Refund payment_123", expected_output="A short confirmation", agent=agent)
    return Crew(agents=[agent], tasks=[task]), task


def decide_on_poll(provider: FakeProvider, decide):
    """Leave requests pending at creation, then decide each when it is first polled."""

    def intercept(request: httpx.Request) -> None:
        if request.method == "GET":
            for stored in provider.requests.values():
                if stored.status == "pending":
                    provider._decide(stored, *decide(stored.body))

    provider.intercept = intercept


def test_approved_call_runs_once_and_reports():
    provider = FakeProvider()
    hooks(provider)
    out = crew(Scripted(model="scripted", turns=[native(REFUND), "Refunded."]))[0].kickoff()
    assert out.raw == "Refunded."
    assert ran == [{"payment_id": "payment_123", "amount": 4900}]
    stored = provider.only()
    assert stored.body["tool"] == "refund" and stored.body["arguments"] == REFUND[2]
    assert stored.body["context"]["framework"] == "crewai" and stored.body["context"]["agent_role"] == "Support"
    assert "server" not in stored.body
    assert stored.outcome["status"] == "succeeded"


def test_denied_call_returns_the_reason_to_the_model():
    provider = FakeProvider(auto=None)
    decide_on_poll(provider, lambda body: ("denied", "Not this one."))
    llm = Scripted(model="scripted", turns=[native(REFUND), "Understood."])
    hooks(provider)
    crew(llm)[0].kickoff()
    assert ran == []
    assert llm.tool_results() == ["The provider denied this call: Not this one."]


def test_text_tool_calls_are_gated():
    provider = FakeProvider(auto="denied")
    llm = Scripted(model="scripted", native=False, turns=[react("refund", REFUND[2]), "Thought: done\nFinal Answer: Not refunded."])
    hooks(provider)
    out = crew(llm)[0].kickoff()
    assert ran == [] and out.raw == "Not refunded."
    assert "The provider denied this call." in llm.tool_results()[-1]

    provider.auto = "approved"
    llm = Scripted(model="scripted", native=False, turns=[react("refund", REFUND[2]), "Thought: done\nFinal Answer: Refunded."])
    crew(llm)[0].kickoff()
    assert len(ran) == 1
    assert [s.outcome for s in provider.requests.values()][-1]["status"] == "succeeded"


def test_a_consumed_approval_does_not_run_again():
    provider = FakeProvider()
    first = hooks(provider)
    llm = Scripted(model="scripted", turns=[native(REFUND), "Refunded.", native(REFUND), "Already done.", native(REFUND), "Refunded again."])
    team, _ = crew(llm)
    team.kickoff()
    assert len(ran) == 1

    # The same task seen again by a new process (a resumed checkpoint) gets
    # the same key, finds the consumed approval and does not run.
    first.uninstall()
    hooks(provider)
    team.kickoff()
    assert len(ran) == 1 and len(provider.requests) == 1
    assert llm.tool_results()[-1] == CONSUMED_TEXT

    # A repeat within the same run is a new attempt and asks again.
    team.kickoff()
    assert len(ran) == 2 and len(provider.requests) == 2


def test_parallel_calls_get_their_own_decisions():
    provider = FakeProvider(auto=None)
    decide_on_poll(provider, lambda body: ("approved", None) if body["arguments"]["amount"] == 100 else ("denied", "Too large."))
    second = ("c2", "refund", {"payment_id": "payment_456", "amount": 100})
    llm = Scripted(model="scripted", turns=[native(REFUND, second), "One refunded."])
    hooks(provider)
    crew(llm)[0].kickoff()
    assert ran == [{"payment_id": "payment_456", "amount": 100}]
    assert sorted(llm.tool_results()) == ["The provider denied this call: Too large.", "refunded payment_456"]
    assert len(provider.requests) == 2


def test_delegated_coworker_calls_are_gated():
    provider = FakeProvider(auto=None)
    decide_on_poll(provider, lambda body: ("denied", "No refunds today.") if body["tool"] == "refund" else ("approved", None))
    lead_llm = Scripted(
        model="lead",
        turns=[native(("d1", "delegate_work_to_coworker", {"task": "Refund payment_123", "context": "Charged twice", "coworker": "Billing"})), "Billing could not refund it."],
    )
    billing_llm = Scripted(model="billing", turns=[native(REFUND), "The refund was denied."])
    lead = Agent(role="Lead", goal="Coordinate", backstory="Delegates.", llm=lead_llm, allow_delegation=True)
    billing = Agent(role="Billing", goal="Refunds", backstory="Refunds payments.", llm=billing_llm, tools=[refund])
    task = Task(description="Get payment_123 refunded", expected_output="A short status", agent=lead)
    hooks(provider)
    Crew(agents=[lead, billing], tasks=[task]).kickoff()
    assert ran == []
    assert sorted(s.body["tool"] for s in provider.requests.values()) == ["delegate_work_to_coworker", "refund"]
    assert billing_llm.tool_results() == ["The provider denied this call: No refunds today."]
    assert "The refund was denied." in lead_llm.tool_results()[0]
    delegated = next(s for s in provider.requests.values() if s.body["tool"] == "delegate_work_to_coworker")
    assert delegated.outcome["status"] == "succeeded"


def test_agent_kickoff_is_gated():
    provider = FakeProvider(auto="denied")
    llm = Scripted(model="scripted", turns=[native(REFUND), "Not refunded."])
    hooks(provider)
    Agent(role="Support", goal="Refunds", backstory="b", llm=llm, tools=[refund]).kickoff("Refund payment_123")
    assert ran == [] and len(provider.requests) == 1
    assert llm.tool_results() == ["The provider denied this call."]


def test_mcp_tools_send_the_server_and_original_name():
    class Issues(MCPNativeTool):
        def _run(self, **kwargs: Any) -> str:
            ran.append(kwargs)
            return "issue"

    issues = Issues(client_factory=lambda: None, tool_name="get_issue", tool_schema={"description": "Get an issue"}, server_name="linear")
    provider = FakeProvider()
    hooks(provider)
    crew(Scripted(model="scripted", turns=[native(("m1", "linear_get_issue", {"id": "MET-1"})), "Found it."]), tools=[issues])[0].kickoff()
    stored = provider.only()
    assert stored.body["tool"] == "get_issue" and stored.body["server"] == "linear"
    assert len(ran) == 1


def test_provider_errors_fail_closed():
    provider = FakeProvider()
    provider.intercept = lambda request: httpx.Response(500) if request.method == "POST" else None
    llm = Scripted(model="scripted", turns=[native(REFUND), "Could not refund."])
    hooks(provider)
    crew(llm)[0].kickoff()
    assert ran == []
    assert llm.tool_results() == [FAIL_CLOSED]


def test_a_failing_hook_blocks_instead_of_running(monkeypatch):
    provider = FakeProvider()
    approvals = hooks(provider)

    def broken(*args: Any, **kwargs: Any):
        raise RuntimeError("bug")

    monkeypatch.setattr(approvals.gate, "check", broken)
    llm = Scripted(model="scripted", turns=[native(REFUND), "Could not refund."])
    crew(llm)[0].kickoff()
    assert ran == []
    assert llm.tool_results() == [FAIL_CLOSED]


def test_async_gate_mode_still_waits():
    provider = FakeProvider(auto=None)
    decide_on_poll(provider, lambda body: ("approved", None))
    hooks(provider, mode="async")
    crew(Scripted(model="scripted", turns=[native(REFUND), "Refunded."]))[0].kickoff()
    assert len(ran) == 1 and provider.only().outcome["status"] == "succeeded"


def test_failed_tools_report_failure():
    @tool("charge")
    def charge(amount: int) -> str:
        """Charge a card."""
        raise RuntimeError("card declined")

    provider = FakeProvider()
    hooks(provider)
    crew(Scripted(model="scripted", turns=[native(("c1", "charge", {"amount": 5})), "Declined."]), tools=[charge])[0].kickoff()
    assert provider.only().outcome["status"] == "failed"


def test_arguments_changed_after_approval_are_reported():
    provider = FakeProvider()
    hooks(provider)

    def later(ctx: Any) -> None:
        ctx.tool_input["amount"] = 1

    register_before_tool_call_hook(later)
    crew(Scripted(model="scripted", turns=[native(REFUND), "Refunded."]))[0].kickoff()
    # CrewAI runs hooks registered later after the approval hook.
    assert ran == [{"payment_id": "payment_123", "amount": 1}]
    assert provider.only().outcome == {**provider.only().outcome, "status": "failed", "note": CHANGED}


def test_models_with_provider_run_tools_are_refused():
    provider = FakeProvider()
    hooks(provider)
    llm = Scripted(model="scripted", builtin_tools=["web_search"], turns=[native(REFUND), "Refunded."])
    with pytest.raises(Exception, match="builtin_tools"):
        crew(llm)[0].kickoff()
    assert ran == [] and provider.requests == {}
    assert PROVIDER_TOOLS.endswith("Remove builtin_tools from the LLM.")


def test_uninstall_removes_the_hooks():
    provider = FakeProvider(auto="denied")
    with ApprovalHooks(gate=Gate(provider.client())):
        pass
    crew(Scripted(model="scripted", turns=[native(REFUND), "Refunded."]))[0].kickoff()
    assert len(ran) == 1 and provider.requests == {}


def test_a_failed_text_tool_call_is_not_retried_under_the_same_approval():
    runs: list[int] = []

    @tool("charge")
    def charge(amount: int) -> str:
        """Charge a card."""
        runs.append(amount)
        raise RuntimeError("card declined")

    seen: list[Any] = []
    register_before_tool_call_hook(lambda ctx: seen.append(ctx.tool))
    provider = FakeProvider()
    hooks(provider)
    llm = Scripted(model="scripted", native=False, turns=[react("charge", {"amount": 5}), "Thought: done\nFinal Answer: Declined."])
    crew(llm, tools=[charge])[0].kickoff()
    # CrewAI retries a raising tool without asking the hooks again.
    assert runs == [5] and len(provider.requests) == 1
    assert provider.only().outcome["status"] == "failed"
    assert SPENT in llm.tool_results()[-1]
    # The tool is restored after the call.
    (structured,) = seen
    assert not getattr(structured.func, "__aap_once__", False)


def test_async_mode_is_refused():
    with pytest.raises(ValueError, match="only supports sync mode"):
        ApprovalHooks("https://approvals.example.com/api/aap", "token", mode="async")
