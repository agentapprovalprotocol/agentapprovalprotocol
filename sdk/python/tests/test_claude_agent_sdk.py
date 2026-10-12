"""The Claude Agent SDK integration, run against the real Claude Code CLI.

The CLI bundled with ``claude-agent-sdk`` talks to a scripted Messages API
on localhost, so the hooks, deferral and resume below are the CLI's own.
Nothing reaches Anthropic.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

import claude_agent_sdk
import httpx
import pytest
from claude_agent_sdk import ClaudeAgentOptions, PermissionResultAllow, PermissionResultDeny, ResultMessage, ToolPermissionContext, create_sdk_mcp_server, query, tool

from agentapprovalprotocol import AsyncGate, Receiver
from agentapprovalprotocol._gate import CONSUMED_TEXT, FAIL_CLOSED
from agentapprovalprotocol.claude_agent_sdk import NO_HANDLER, ApprovalHooks, identify, resumer
from agentapprovalprotocol.testing import SECRET, FakeProvider

CLI = Path(claude_agent_sdk.__file__).parent / "_bundled" / ("claude.exe" if sys.platform == "win32" else "claude")
needs_cli = pytest.mark.skipif(not CLI.exists(), reason="the bundled Claude Code CLI is not installed")

Blocks = list[dict[str, Any]]


class ScriptedAPI:
    """A Messages API that answers agent turns from ``script(body)``."""

    def __init__(self, script: Callable[[dict[str, Any]], Blocks]):
        self.script = script
        self.agent_requests: list[dict[str, Any]] = []
        api = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
                if "count_tokens" in self.path:
                    return self._json({"input_tokens": 10})
                blocks = api.answer(body)
                stop = "tool_use" if any(b["type"] == "tool_use" for b in blocks) else "end_turn"
                message = {"id": f"msg_{uuid.uuid4().hex}", "type": "message", "role": "assistant", "model": body.get("model", "claude"), "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 1}}
                if not body.get("stream"):
                    return self._json({**message, "content": blocks, "stop_reason": stop})
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.end_headers()
                self._event({"type": "message_start", "message": message})
                for index, block in enumerate(blocks):
                    if block["type"] == "text":
                        start, delta = {"type": "text", "text": ""}, {"type": "text_delta", "text": block["text"]}
                    else:
                        start, delta = {**block, "input": {}}, {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}
                    self._event({"type": "content_block_start", "index": index, "content_block": start})
                    self._event({"type": "content_block_delta", "index": index, "delta": delta})
                    self._event({"type": "content_block_stop", "index": index})
                self._event({"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 5}})
                self._event({"type": "message_stop"})

            def do_GET(self) -> None:
                self._json({})

            def _event(self, data: dict[str, Any]) -> None:
                self.wfile.write(f"event: {data['type']}\ndata: {json.dumps(data)}\n\n".encode())
                self.wfile.flush()

            def _json(self, data: Any) -> None:
                out = json.dumps(data).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def answer(self, body: dict[str, Any]) -> Blocks:
        if not body.get("tools"):
            return [{"type": "text", "text": "ok"}]  # titles and other side requests
        self.agent_requests.append(body)
        return self.script(body)

    def tool_results(self) -> list[dict[str, Any]]:
        last = self.agent_requests[-1]["messages"]
        return [block for message in last if isinstance(message["content"], list) for block in message["content"] if block.get("type") == "tool_result"]


def answered(body: dict[str, Any]) -> bool:
    return "tool_result" in json.dumps(body["messages"])


def call(id: str, payment_id: str, name: str = "mcp__pay__refund") -> dict[str, Any]:
    return {"type": "tool_use", "id": id, "name": name, "input": {"payment_id": payment_id}}


def script(*calls: dict[str, Any], final: str = "Done.") -> Callable[[dict[str, Any]], Blocks]:
    """One turn with ``calls``, then ``final`` once results are in."""
    return lambda body: [{"type": "text", "text": final}] if answered(body) else [{"type": "text", "text": "Refunding."}, *calls]


ran: list[str] = []


@tool("refund", "Refund a payment", {"payment_id": str})
async def refund(args: dict[str, Any]) -> dict[str, Any]:
    ran.append(args["payment_id"])
    return {"content": [{"type": "text", "text": f"refunded {args['payment_id']}"}]}


@pytest.fixture(autouse=True)
def reset():
    ran.clear()


@pytest.fixture
def cli(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Isolates the CLI: its own config, no inherited Claude settings, a local API."""
    for name in list(os.environ):
        if name.startswith(("CLAUDE", "ANTHROPIC")):
            monkeypatch.delenv(name)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setenv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
    monkeypatch.setenv("DISABLE_AUTOUPDATER", "1")
    work = tmp_path / "work"
    work.mkdir()
    servers: list[ScriptedAPI] = []

    def start(responder: Callable[[dict[str, Any]], Blocks]) -> tuple[ScriptedAPI, ClaudeAgentOptions]:
        api = ScriptedAPI(responder)
        servers.append(api)
        monkeypatch.setenv("ANTHROPIC_BASE_URL", api.url)
        base = ClaudeAgentOptions(mcp_servers={"pay": create_sdk_mcp_server("pay", tools=[refund])}, tools=["Bash"], cwd=str(work), model="claude-sonnet-4-5")
        return api, base

    yield start
    for api in servers:
        api.server.shutdown()


def hooks(provider: FakeProvider, mode: str = "sync") -> ApprovalHooks:
    return ApprovalHooks(gate=AsyncGate(provider.async_client(), mode=mode))


async def run(options: ClaudeAgentOptions, prompt: str = "Refund it") -> list[ResultMessage]:
    results = []
    async for message in query(prompt=prompt, options=options):
        if isinstance(message, ResultMessage):
            results.append(message)
    return results


def approve_when_polled(provider: FakeProvider, tool_name: str) -> None:
    """Decide pending requests for ``tool_name`` once the gate waits on them."""

    def intercept(request: httpx.Request) -> None:
        if request.method == "GET":
            for stored in provider.requests.values():
                if stored.body["tool"] == tool_name:
                    provider._decide(stored, "approved", None)

    provider.intercept = intercept


@needs_cli
async def test_approved_call_runs_once_and_reports(cli):
    provider = FakeProvider()
    api, base = cli(script(call("toolu_1", "payment_123")))
    (result,) = await run(hooks(provider).options(base))
    assert ran == ["payment_123"] and result.result == "Done."
    stored = provider.only()
    assert stored.body["tool"] == "refund" and stored.body["server"] == "pay"
    assert stored.body["arguments"] == {"payment_id": "payment_123"}
    assert stored.body["context"]["framework"] == "claude-agent-sdk"
    assert stored.body["context"]["call_id"] == f"{result.session_id}:toolu_1"
    assert "resume" not in stored.body["context"]
    assert stored.outcome["status"] == "succeeded"


@needs_cli
async def test_denied_call_returns_the_reason_to_the_model(cli):
    provider = FakeProvider(auto="denied")
    api, base = cli(script(call("toolu_1", "payment_123"), final="Understood."))
    (result,) = await run(hooks(provider).options(base))
    assert ran == [] and result.result == "Understood."
    (denied,) = api.tool_results()
    assert denied["is_error"] and "The provider denied this call." in json.dumps(denied["content"])


@needs_cli
async def test_built_in_tools_are_gated_and_failures_reported(cli):
    provider = FakeProvider()
    api, base = cli(script({"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "exit 3"}}))
    await run(hooks(provider).options(base))
    stored = provider.only()
    assert stored.body["tool"] == "Bash" and "server" not in stored.body
    assert stored.outcome["status"] == "failed"


@needs_cli
async def test_replay_after_consumption_does_not_run_again(cli):
    provider = FakeProvider()
    approvals = hooks(provider)
    api, base = cli(script(call("toolu_1", "payment_123")))
    (result,) = await run(approvals.options(base))
    replay = {"hook_event_name": "PreToolUse", "session_id": result.session_id, "tool_use_id": "toolu_1", "tool_name": "mcp__pay__refund", "tool_input": {"payment_id": "payment_123"}, "cwd": base.cwd, "mcp_server": {"name": "pay"}}
    out = await approvals.pre_tool_use(replay, "toolu_1")
    assert out["hookSpecificOutput"] == {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": CONSUMED_TEXT}
    assert len(provider.requests) == 1 and ran == ["payment_123"]


@needs_cli
async def test_provider_errors_fail_closed(cli):
    provider = FakeProvider()
    provider.intercept = lambda request: httpx.Response(503)
    api, base = cli(script(call("toolu_1", "payment_123"), final="Understood."))
    approvals = ApprovalHooks(gate=AsyncGate(provider.async_client(retry_budget=0.5)))
    await run(approvals.options(base))
    assert ran == []
    (denied,) = api.tool_results()
    assert denied["is_error"] and FAIL_CLOSED in json.dumps(denied["content"])


@needs_cli
async def test_async_mode_defers_ignores_forged_resumes_and_wakes_on_the_decision(cli):
    provider = FakeProvider(auto=None)
    approvals = hooks(provider, "async")
    api, base = cli(script(call("toolu_1", "payment_123")))
    options = approvals.options(base)
    (paused,) = await run(options)
    assert paused.stop_reason == "tool_deferred" and paused.deferred_tool_use.id == "toolu_1"
    stored = provider.only()
    assert ran == [] and stored.body["context"]["resume"] == {"framework": "claude-agent-sdk", "session_id": paused.session_id, "tool_use_id": "toolu_1", "cwd": stored.body["context"]["resume"]["cwd"]}

    # Resuming the session before the decision asks the provider again and pauses again.
    messages: list[Any] = []
    resume = resumer(options, on_message=messages.append)
    await resume(stored.body["context"]["resume"], None)
    assert ran == [] and isinstance(messages[-1], ResultMessage) and messages[-1].stop_reason == "tool_deferred"

    provider.decide(stored.id)
    receiver = Receiver(secret=SECRET, client=provider.async_client(), resumers={"claude-agent-sdk": resumer(options, on_message=messages.append)})
    assert await receiver.wake(stored.id)
    assert ran == ["payment_123"] and len(provider.requests) == 1
    assert stored.outcome["status"] == "succeeded"
    assert messages[-1].result == "Done."

    # A repeated notification finds the call answered and resumes nothing.
    count = len(messages)
    assert await receiver.wake(stored.id)
    assert ran == ["payment_123"] and len(messages) == count


@needs_cli
async def test_parallel_calls_defer_one_and_wait_for_the_other(cli):
    provider = FakeProvider(auto=None)
    api, base = cli(script(call("toolu_1", "payment_123"), call("toolu_2", "payment_456"), final="Both done."))
    options = hooks(provider, "async").options(base)
    order: list[Any] = []

    def intercept(request: httpx.Request) -> None:
        # The second call waits, so decide it when it polls.
        if request.method == "GET":
            for stored in provider.requests.values():
                if stored.body["arguments"]["payment_id"] == "payment_456":
                    provider._decide(stored, "approved", None)

    provider.intercept = intercept
    (paused,) = await run(options)
    assert paused.stop_reason == "tool_deferred" and paused.deferred_tool_use.id == "toolu_1"
    assert ran == ["payment_456"]
    first = next(s for s in provider.requests.values() if s.body["arguments"]["payment_id"] == "payment_123")
    provider.decide(first.id)
    receiver = Receiver(secret=SECRET, client=provider.async_client(), resumers={"claude-agent-sdk": resumer(options, on_message=order.append)})
    assert await receiver.wake(first.id)
    assert ran == ["payment_456", "payment_123"] and len(provider.requests) == 2
    assert order[-1].result == "Both done."


@needs_cli
async def test_subagent_calls_wait_instead_of_deferring(cli):
    provider = FakeProvider(auto=None)

    def intercept(request: httpx.Request) -> None:
        if request.method == "POST" and request.url.path.endswith("/requests"):
            provider.auto = "approved" if json.loads(request.content)["tool"] == "Agent" else None
        elif request.method == "GET":
            for stored in provider.requests.values():
                provider._decide(stored, "approved", None)

    provider.intercept = intercept

    def responder(body: dict[str, Any]) -> Blocks:
        if "Refund payment_123 as a subagent" in json.dumps(body["messages"][:1]):
            return [{"type": "text", "text": "Sub done."}] if answered(body) else [call("toolu_s", "payment_123")]
        if answered(body):
            return [{"type": "text", "text": "Main done."}]
        return [{"type": "tool_use", "id": "toolu_a", "name": "Agent", "input": {"description": "Refund", "prompt": "Refund payment_123 as a subagent", "subagent_type": "general-purpose"}}]

    api, base = cli(responder)
    await run(hooks(provider, "async").options(base, tools=["Agent"]))
    for _ in range(100):  # the subagent may run in the background
        if ran:
            break
        await asyncio.sleep(0.1)
    assert ran == ["payment_123"]
    sub = next(s for s in provider.requests.values() if s.body["tool"] == "refund")
    assert "resume" not in sub.body["context"] and sub.body["context"]["agent_type"] == "general-purpose"
    assert sorted(s.body["tool"] for s in provider.requests.values()) == ["Agent", "refund"]


async def test_ignored_deferral_waits_in_the_permission_handler():
    """When the CLI ignores a deferral, the hook's ask sends the call to can_use_tool, which waits."""
    provider = FakeProvider(auto=None)
    options = hooks(provider, "async").options(ClaudeAgentOptions())
    pre, ask = options.hooks["PreToolUse"][-1].hooks
    event = {"hook_event_name": "PreToolUse", "session_id": "s1", "tool_use_id": "toolu_1", "tool_name": "mcp__pay__refund", "tool_input": {"payment_id": "payment_123"}, "cwd": "/w", "prompt_id": "p1"}
    deferred, asked = await asyncio.gather(pre(event, "toolu_1", {}), ask(event, "toolu_1", {}))
    assert deferred["hookSpecificOutput"]["permissionDecision"] == "defer"
    assert asked["hookSpecificOutput"]["permissionDecision"] == "ask"
    context = ToolPermissionContext(tool_use_id="toolu_1")

    # Input that differs from what the provider was sent is refused.
    changed = await options.can_use_tool("mcp__pay__refund", {"payment_id": "payment_999"}, context)
    assert isinstance(changed, PermissionResultDeny) and changed.message == FAIL_CLOSED

    await asyncio.gather(pre(event, "toolu_1", {}), ask(event, "toolu_1", {}))
    approve_when_polled(provider, "refund")
    assert isinstance(await options.can_use_tool("mcp__pay__refund", {"payment_id": "payment_123"}, context), PermissionResultAllow)
    await options.hooks["PostToolUse"][-1].hooks[0]({"hook_event_name": "PostToolUse", "tool_use_id": "toolu_1", "tool_response": []}, "toolu_1", {})
    assert provider.only().outcome["status"] == "succeeded"


async def test_permission_handler_passes_other_calls_on():
    async def mine(name: str, tool_input: dict[str, Any], context: Any) -> PermissionResultAllow:
        return PermissionResultAllow()

    context = ToolPermissionContext(tool_use_id="toolu_9")
    refused = await hooks(FakeProvider(), "async").options(ClaudeAgentOptions()).can_use_tool("Bash", {"command": "ls"}, context)
    assert isinstance(refused, PermissionResultDeny) and refused.message == NO_HANDLER
    delegated = hooks(FakeProvider(), "async").options(ClaudeAgentOptions(can_use_tool=mine))
    assert isinstance(await delegated.can_use_tool("Bash", {"command": "ls"}, context), PermissionResultAllow)


async def test_malformed_hook_input_fails_closed():
    approvals = hooks(FakeProvider())
    out = await approvals.pre_tool_use({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {}}, "toolu_1")
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert out["hookSpecificOutput"]["permissionDecisionReason"] == FAIL_CLOSED


def test_options_install_once_and_leave_out_user_settings():
    approvals = hooks(FakeProvider())
    options = approvals.options(ClaudeAgentOptions(model="m"))
    assert options.model == "m" and options.setting_sources == ["project", "local"]
    assert options.can_use_tool is None and options.hooks["PreToolUse"][-1].timeout == approvals.timeout
    assert approvals.options(ClaudeAgentOptions(setting_sources=["user"])).setting_sources == ["user"]
    with pytest.raises(ValueError):
        approvals.options(options)
    with pytest.raises(ValueError):
        hooks(FakeProvider(), "async").options(ClaudeAgentOptions(permission_prompt_tool_name="mcp__x__y"))
    with pytest.raises(ValueError):
        ApprovalHooks()


def test_identify_splits_mcp_names():
    assert identify("mcp__pay__refund") == ("refund", "pay")
    assert identify("mcp__pay__refund__v2") == ("refund__v2", "pay")
    assert identify("mcp__pay_api__refund", {"name": "pay.api", "source": "sdk"}) == ("refund", "pay.api")
    assert identify("Bash") == ("Bash", None)
    assert identify("mcp__broken") == ("mcp__broken", None)
