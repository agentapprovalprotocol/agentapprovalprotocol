"""Approvals for LangChain agents, LangGraph tool nodes and Deep Agents.

``ApprovalMiddleware`` gates every tool call an agent makes, whatever tools
it was given. In sync mode the call waits for the decision. In async mode
the run pauses with a LangGraph interrupt, the process can exit, and a
``Receiver`` wakes the thread when the decision arrives. On resume the
middleware asks the provider again and ignores the resume value, so a
thread resumed by anything else cannot approve a call.

Install with ``pip install "agentapprovalprotocol[langgraph]"``.
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, Iterable, Literal, Mapping, Sequence

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.runnables.config import var_child_runnable_config
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command, interrupt

from ._client import AsyncClient, Client
from ._gate import Allow, AsyncGate, Call, Deny, Gate, Pending, Verdict
from ._wire import Request

INTERRUPT_KEY = "aap_request_id"

Handler = Callable[[ToolCallRequest], "ToolMessage | Command"]
AsyncHandler = Callable[[ToolCallRequest], Awaitable["ToolMessage | Command"]]


def _thread(request: ToolCallRequest) -> tuple[str | None, str, str | None]:
    runtime = request.runtime
    info = getattr(runtime, "execution_info", None)
    server = getattr(runtime, "server_info", None)
    return getattr(info, "thread_id", None), getattr(info, "checkpoint_ns", "") or "", getattr(server, "assistant_id", None)


def _reasoning(state: Any) -> str | None:
    messages = state.get("messages", []) if isinstance(state, Mapping) else getattr(state, "messages", [])
    for message in reversed(messages):
        if isinstance(message, AIMessage):
            text = message.text if isinstance(message.text, str) else message.text()
            return text.strip() or None
    return None


def _pause(request: ToolCallRequest, request_id: str, tool: str) -> None:
    """Interrupt the run. Returns only on resume, and the value is never read:
    the provider is asked again, so a resume cannot approve a call."""
    value = {INTERRUPT_KEY: request_id, "tool": tool, "tool_call_id": request.tool_call["id"]}
    try:
        interrupt(value)
    except RuntimeError:
        # Python 3.10 can lose the run's config in tasks LangGraph gathers for
        # parallel tool calls; the tool runtime still carries it.
        config = getattr(request.runtime, "config", None)
        if config is None:
            raise
        token = var_child_runnable_config.set(config)
        try:
            interrupt(value)
        finally:
            var_child_runnable_config.reset(token)


def _denied(request: ToolCallRequest, verdict: Deny) -> ToolMessage:
    return ToolMessage(content=verdict.reason, name=request.tool_call["name"], tool_call_id=request.tool_call["id"], status="error")


def _failed(result: Any) -> bool:
    return isinstance(result, ToolMessage) and result.status == "error"


class ApprovalMiddleware(AgentMiddleware):
    """Send every tool call to an AAP provider before it runs.

    Pass the same instance to the agent and to every subagent. Place it last
    among middleware that change tool arguments, so the provider approves the
    arguments that will run.

    ``mode="async"`` needs a checkpointer; without one, calls wait instead.
    """

    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        *,
        mode: Literal["sync", "async"] = "sync",
        gate: Gate | None = None,
        async_gate: AsyncGate | None = None,
        context: Mapping[str, Any] | None = None,
        **gate_options: Any,
    ):
        super().__init__()
        self.context = {"framework": "langgraph", **(context or {})}
        if gate is None and async_gate is None and (base_url is None or token is None):
            raise ValueError("pass base_url and token, or gates")
        self._gate = gate
        self._async_gate = async_gate
        self._make = lambda client_cls, gate_cls: gate_cls(client_cls(base_url, token), mode=mode, **gate_options)
        self.mode = mode

    @property
    def gate(self) -> Gate:
        if self._gate is None:
            self._gate = self._make(Client, Gate)
        return self._gate

    @property
    def async_gate(self) -> AsyncGate:
        if self._async_gate is None:
            self._async_gate = self._make(AsyncClient, AsyncGate)
        return self._async_gate

    def _call(self, request: ToolCallRequest) -> tuple[Call, bool]:
        thread, namespace, assistant = _thread(request)
        tool_call = request.tool_call
        resume = None
        if thread is not None:
            resume = {"framework": "langgraph", "thread_id": thread}
            if assistant:
                resume["assistant_id"] = assistant
        call = Call(
            key=f"{thread or '-'}:{namespace}:{tool_call['id']}",
            tool=tool_call["name"],
            arguments=tool_call.get("args") or {},
            reasoning=_reasoning(request.state),
            context=self.context,
            resume=resume,
        )
        return call, thread is not None

    def wrap_tool_call(self, request: ToolCallRequest, handler: Handler) -> ToolMessage | Command:
        call, can_pause = self._call(request)
        verdict: Verdict = self.gate.check(call, can_pause=can_pause)
        while isinstance(verdict, Pending):
            _pause(request, verdict.request_id, call.tool)
            verdict = self.gate.check(call, can_pause=can_pause)
        if isinstance(verdict, Deny):
            return _denied(request, verdict)
        try:
            result = handler(request)
        except BaseException:
            if self.gate.report_outcomes:
                verdict.report("failed")
            raise
        if self.gate.report_outcomes:
            verdict.report("failed" if _failed(result) else "succeeded")
        return result

    async def awrap_tool_call(self, request: ToolCallRequest, handler: AsyncHandler) -> ToolMessage | Command:
        call, can_pause = self._call(request)
        verdict: Verdict = await self.async_gate.check(call, can_pause=can_pause)
        while isinstance(verdict, Pending):
            _pause(request, verdict.request_id, call.tool)
            verdict = await self.async_gate.check(call, can_pause=can_pause)
        if isinstance(verdict, Deny):
            return _denied(request, verdict)
        assert isinstance(verdict, Allow)
        try:
            result = await handler(request)
        except BaseException:
            if self.async_gate.report_outcomes:
                await verdict.report("failed")
            raise
        if self.async_gate.report_outcomes:
            await verdict.report("failed" if _failed(result) else "succeeded")
        return result


def _waiting(interrupts: Iterable[Any], request_id: str) -> dict[str, str]:
    """Resume values for the interrupts waiting on one request."""
    out = {}
    for item in interrupts:
        value = item.get("value") if isinstance(item, Mapping) else getattr(item, "value", None)
        identifier = item.get("id") if isinstance(item, Mapping) else getattr(item, "id", None)
        if isinstance(value, Mapping) and value.get(INTERRUPT_KEY) == request_id and identifier:
            out[identifier] = "wake"
    return out


def resumer(graph: Any, *, config: Mapping[str, Any] | None = None) -> Callable[[Mapping[str, Any], Request], Awaitable[None]]:
    """A ``Receiver`` resumer for a graph running in this process.

    It resumes only the interrupts waiting on the decided request, one
    resume per thread at a time. The resumed run continues here, so read
    results from the thread's state, not from the run that started it.
    """
    locks: dict[str, asyncio.Lock] = {}

    async def resume(handle: Mapping[str, Any], request: Request) -> None:
        thread = handle.get("thread_id")
        if not isinstance(thread, str):
            return
        base = dict(config or {})
        settings = {**base, "configurable": {**base.get("configurable", {}), "thread_id": thread}}
        async with locks.setdefault(thread, asyncio.Lock()):
            try:
                state = await graph.aget_state(settings)
            except NotImplementedError:
                state = await asyncio.to_thread(graph.get_state, settings)
            values = _waiting(state.interrupts, request.id)
            if not values:
                return
            try:
                await graph.ainvoke(Command(resume=values), settings)
            except NotImplementedError:
                await asyncio.to_thread(graph.invoke, Command(resume=values), settings)

    return resume


def deployment_resumer(client: Any, *, assistant_id: str | None = None) -> Callable[[Mapping[str, Any], Request], Awaitable[None]]:
    """A ``Receiver`` resumer for graphs on LangSmith Deployment.

    ``client`` is a ``langgraph_sdk`` async client. The resume is queued on
    the deployment behind any run already active on the thread.
    """

    async def resume(handle: Mapping[str, Any], request: Request) -> None:
        thread = handle.get("thread_id")
        assistant = handle.get("assistant_id") or assistant_id
        if not isinstance(thread, str) or not assistant:
            return
        state = await client.threads.get_state(thread)
        values = _waiting(state.get("interrupts") or [], request.id)
        if values:
            await client.runs.create(thread, assistant, command={"resume": values}, multitask_strategy="enqueue")

    return resume


def deep_agent_subagents(middleware: ApprovalMiddleware, subagents: Sequence[Mapping[str, Any]] = ()) -> list[dict[str, Any]]:
    """Subagent specs for ``create_deep_agent`` with approvals on every one.

    Deep Agents gives subagents the parent's ``interrupt_on`` but not its
    custom middleware, so pass the result as ``subagents``. It also replaces
    the default general-purpose subagent with the same spec plus approvals.
    Compiled and async subagents run their own graphs and are refused: add
    the middleware to those graphs yourself.
    """
    from deepagents.middleware.subagents import GENERAL_PURPOSE_SUBAGENT

    out: list[dict[str, Any]] = []
    for spec in subagents:
        if "runnable" in spec or "graph_id" in spec or "url" in spec:
            raise ValueError(f"subagent {spec.get('name')!r} runs its own graph; add ApprovalMiddleware to it directly")
        out.append({**spec, "middleware": [*spec.get("middleware", []), middleware]})
    if not any(spec.get("name") == GENERAL_PURPOSE_SUBAGENT["name"] for spec in out):
        out.append({**GENERAL_PURPOSE_SUBAGENT, "middleware": [middleware]})
    return out
