"""Approvals for the OpenAI Agents SDK.

``Approvals.protect`` walks an agent, its handoff targets, agents used as
tools and local MCP servers, and sends every tool call to an AAP provider
before it runs. In sync mode a tool input guardrail waits for the decision.
In async mode every call pauses the run with the SDK's own approval
interruption, the run state is saved, and a ``Receiver`` resumes it when the
decision arrives. The run state's approval flag is never trusted: a call
runs only after the gate checked and consumed the provider's approval in
this process.

Tools that run inside OpenAI's response cannot be intercepted, so
``protect`` refuses them. Hosted MCP servers are gated through their
approval callback.

Install with ``pip install "agentapprovalprotocol[openai-agents]"``.
"""

from __future__ import annotations

import asyncio
import contextvars
import inspect
import json
from collections import OrderedDict
from typing import Any, Awaitable, Callable, Literal, Mapping

from agents import Agent, AgentHooks, FunctionTool, HostedMCPTool, Runner, RunState, ToolSearchTool
from agents.items import ModelResponse, ToolApprovalItem
from agents.mcp import MCPServer
from agents.mcp.util import get_mcp_server_log_name
from agents.result import RunResult
from agents.tool import MCPToolApprovalRequest, ToolOriginType
from agents.tool_guardrails import (
    ToolGuardrailFunctionOutput,
    ToolInputGuardrail,
    ToolInputGuardrailData,
    ToolOutputGuardrail,
    ToolOutputGuardrailData,
)

from ._client import AsyncClient
from ._gate import FAIL_CLOSED, Allow, AsyncGate, Call, Deny, Pending, Verdict
from ._wire import Request

FRAMEWORK = "openai-agents"
NOT_APPROVED = "This call was approved outside the approval provider, so it was not run."
PRE_APPROVAL = "Approvals do not support pre_approval_tool_input_guardrails."

Save = Callable[[str, str], "Awaitable[None] | None"]
Load = Callable[[str], "Awaitable[str | None] | str | None"]

_run_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("aap_openai_agents_run_id", default=None)


async def _maybe(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


def _arguments(raw: str | None) -> dict[str, Any] | None:
    try:
        parsed = json.loads(raw) if raw and raw.strip() else {}
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _text(response: ModelResponse) -> str | None:
    parts = []
    for item in response.output:
        if getattr(item, "type", None) == "message":
            parts.extend(getattr(c, "text", "") or "" for c in getattr(item, "content", []) or [])
    return "".join(parts).strip() or None


def _hosted(tool: Any) -> bool:
    environment = getattr(tool, "environment", None)
    return isinstance(environment, Mapping) and environment.get("type") != "local"


class Approvals:
    """Send every tool call an OpenAI agent makes to an AAP provider.

    Call ``protect(agent)`` once, after the agent and its subagents are
    configured, with nothing added to their tools afterwards.

    ``mode="async"`` needs ``save`` and ``load``: they store a run's state,
    as a string, by run ID. Keep that store on the server. Without them,
    calls wait instead. Start and resume async runs only through ``run``
    and ``resumer``.

    An allowed call's outcome is reported as succeeded when the tool
    returns. The SDK turns most tool errors into a message for the model,
    and those count as returned.
    """

    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        *,
        mode: Literal["sync", "async"] = "sync",
        gate: AsyncGate | None = None,
        context: Mapping[str, Any] | None = None,
        save: Save | None = None,
        load: Load | None = None,
        **gate_options: Any,
    ):
        if gate is None and (base_url is None or token is None):
            raise ValueError("pass base_url and token, or a gate")
        if (save is None) != (load is None):
            raise ValueError("pass both save and load, or neither")
        self.gate = gate or AsyncGate(AsyncClient(base_url, token), mode=mode, **gate_options)
        self.mode = self.gate.mode
        self.context = {"framework": FRAMEWORK, **(context or {})}
        self._save = save
        self._load = load
        self._reasoning: OrderedDict[str, str | None] = OrderedDict()
        self._ready: dict[str, Allow] = {}  # consumed by a resume, waiting for the guardrail
        self._running: dict[str, Allow] = {}  # started, waiting for the outcome
        self._locks: dict[str, asyncio.Lock] = {}
        self._before = ToolInputGuardrail(self._check_function, name="aap_approval")
        self._after = ToolOutputGuardrail(self._report_function, name="aap_outcome")
        self._servers: dict[int, tuple[ToolInputGuardrail[Any], ToolOutputGuardrail[Any]]] = {}

    # Installing

    def protect(self, agent: Agent[Any]) -> Agent[Any]:
        """Gate every tool the agent can reach. Raises ``ValueError`` for tools that cannot be gated."""
        seen: set[int] = set()
        stack = [agent]
        while stack:
            current = stack.pop()
            if id(current) in seen:
                continue
            seen.add(id(current))
            if any(cls.__name__ == "SandboxAgent" for cls in type(current).__mro__):
                raise ValueError(f"agent {current.name!r} is a sandbox agent; its sandbox tools cannot be gated")
            self._record_reasoning(current)
            for tool in current.tools:
                if isinstance(tool, FunctionTool):
                    self._install(tool, self._before, self._after)
                    nested = getattr(tool, "_agent_instance", None)
                    if isinstance(nested, Agent):
                        stack.append(nested)
                elif isinstance(tool, HostedMCPTool):
                    self._install_hosted(tool)
                elif isinstance(tool, ToolSearchTool):
                    continue  # only loads tool definitions
                elif _hosted(tool) or type(tool).__name__ in ("WebSearchTool", "FileSearchTool", "CodeInterpreterTool", "ImageGenerationTool", "ProgrammaticToolCallingTool"):
                    raise ValueError(f"tool {tool.name!r} on agent {current.name!r} runs inside OpenAI's response and cannot be gated")
                else:
                    raise ValueError(f"tool {tool.name!r} on agent {current.name!r} cannot be gated; wrap the action in a function tool instead")
            for server in current.mcp_servers:
                self._install_server(server)
            for handoff in current.handoffs:
                target = handoff if isinstance(handoff, Agent) else None
                if target is None:
                    ref = getattr(handoff, "_agent_ref", None)
                    target = ref() if ref is not None else None
                if not isinstance(target, Agent):
                    raise ValueError(f"handoff {handoff.tool_name!r} on agent {current.name!r} has no agent to protect")
                stack.append(target)
        return agent

    def _install(self, tool: Any, before: ToolInputGuardrail[Any], after: ToolOutputGuardrail[Any]) -> None:
        inputs = list(getattr(tool, "tool_input_guardrails", None) or [])
        outputs = list(getattr(tool, "tool_output_guardrails", None) or [])
        if any(g.name == "aap_approval" and g is not before for g in inputs):
            raise ValueError("this tool is already protected by another Approvals")
        if before not in inputs:
            inputs.append(before)  # last, so other guardrails reject before an approval is used
        if after not in outputs:
            outputs.append(after)
        tool.tool_input_guardrails, tool.tool_output_guardrails = inputs, outputs
        if self.mode == "async" and isinstance(tool, FunctionTool):
            tool.needs_approval = True

    def _install_server(self, server: MCPServer) -> None:
        if id(server) not in self._servers:

            async def check(data: ToolInputGuardrailData) -> ToolGuardrailFunctionOutput:
                return await self._check_function(data, get_mcp_server_log_name(server.name))

            self._servers[id(server)] = (ToolInputGuardrail(check, name="aap_approval"), self._after)
        before, after = self._servers[id(server)]
        self._install(server, before, after)
        if self.mode == "async":
            if not hasattr(server, "_needs_approval_policy"):
                raise ValueError(f"MCP server {server.name!r} does not support approvals")
            server._needs_approval_policy = True

    def _install_hosted(self, tool: HostedMCPTool) -> None:
        if tool.on_approval_request is not None and getattr(tool.on_approval_request, "__self__", None) is not self:
            raise ValueError(f"hosted MCP server {tool.name!r} already has on_approval_request")
        tool.tool_config = {**tool.tool_config, "require_approval": "always"}  # type: ignore[typeddict-item]
        tool.on_approval_request = self._check_hosted

    def _record_reasoning(self, agent: Agent[Any]) -> None:
        hooks = agent.hooks
        if hooks is None:
            hooks = agent.hooks = AgentHooks()
        if getattr(hooks, "_aap_recorded", None) is self:
            return
        inner = hooks.on_llm_end

        async def on_llm_end(context: Any, agent: Any, response: ModelResponse) -> None:
            text = _text(response)
            for item in response.output:
                if getattr(item, "type", None) == "function_call":
                    self._reasoning[item.call_id] = text
                    while len(self._reasoning) > 1024:
                        self._reasoning.popitem(last=False)
            await inner(context, agent, response)

        hooks.on_llm_end = on_llm_end  # type: ignore[method-assign]
        hooks._aap_recorded = self  # type: ignore[attr-defined]

    # Checking

    def _key(self, run_id: str | None, agent_name: str, call_id: str) -> str:
        return f"{run_id or '-'}:{agent_name}:{call_id}"

    def _call(self, key: str, tool: str, arguments: dict[str, Any], server: str | None, reasoning: str | None, run_id: str | None) -> Call:
        resume = {"framework": FRAMEWORK, "run_id": run_id} if run_id is not None and self._save is not None else None
        return Call(key=key, tool=tool, arguments=arguments, server=server, reasoning=reasoning, context=self.context, resume=resume)

    async def _check_function(self, data: ToolInputGuardrailData, server: str | None = None) -> ToolGuardrailFunctionOutput:
        context = data.context
        settings = getattr(context.run_config, "tool_execution", None)
        if getattr(settings, "pre_approval_tool_input_guardrails", False):
            return ToolGuardrailFunctionOutput.raise_exception(output_info=PRE_APPROVAL)
        key = self._key(_run_id.get(), data.agent.name, context.tool_call_id)
        verdict: Verdict
        if self.mode == "async":
            # Only an approval this process checked and consumed may run.
            ready = self._ready.pop(key, None)
            if ready is None:
                return ToolGuardrailFunctionOutput.raise_exception(output_info=NOT_APPROVED)
            verdict = ready
        else:
            arguments = _arguments(context.tool_arguments)
            if arguments is None:
                return ToolGuardrailFunctionOutput.reject_content(FAIL_CLOSED)
            call = self._call(key, context.qualified_tool_name, arguments, server, self._reasoning.get(context.tool_call_id), None)
            verdict = await self.gate.check(call, can_pause=False)
        if isinstance(verdict, Allow):
            self._running[key] = verdict
            return ToolGuardrailFunctionOutput.allow()
        return ToolGuardrailFunctionOutput.reject_content(verdict.reason if isinstance(verdict, Deny) else FAIL_CLOSED)

    async def _report_function(self, data: ToolOutputGuardrailData) -> ToolGuardrailFunctionOutput:
        verdict = self._running.pop(self._key(_run_id.get(), data.agent.name, data.context.tool_call_id), None)
        if verdict is not None and self.gate.report_outcomes:
            await verdict.report("succeeded")
        return ToolGuardrailFunctionOutput.allow()

    async def _check_hosted(self, request: MCPToolApprovalRequest) -> dict[str, Any]:
        """Hosted MCP calls run at OpenAI after this answer, so they always wait."""
        item = request.data
        arguments = _arguments(item.arguments)
        if arguments is None:
            return {"approve": False, "reason": FAIL_CLOSED}
        call = self._call(self._key(_run_id.get(), item.server_label, item.id), item.name, arguments, item.server_label, None, None)
        verdict = await self.gate.check(call, can_pause=False)
        if isinstance(verdict, Allow):
            return {"approve": True}
        return {"approve": False, "reason": verdict.reason if isinstance(verdict, Deny) else FAIL_CLOSED}

    # Running and resuming

    async def run(self, agent: Agent[Any], input: Any, *, run_id: str | None = None, **options: Any) -> RunResult:
        """Run a protected agent. Other options go to ``Runner.run``.

        ``run_id`` identifies the run to the provider and, in async mode,
        names its stored state. In async mode a result with
        ``interruptions`` is paused, and a ``Receiver`` continues it.
        """
        if self.mode == "async" and self._save is not None and run_id is None:
            raise ValueError("async mode needs a run_id")
        return await self._drive(agent, input, run_id, set(), [], options)

    def resumer(self, agent: Agent[Any], **options: Any) -> Callable[[Mapping[str, Any], Request], Awaitable[None]]:
        """A ``Receiver`` resumer for runs paused in async mode.

        It loads the run's state, asks the provider about the decided call
        and continues the run here, one resume per run at a time. Read the
        result from the stored state, not from the run that paused.
        """

        async def resume(handle: Mapping[str, Any], request: Request) -> None:
            run_id = handle.get("run_id")
            if not isinstance(run_id, str) or self._load is None:
                return
            async with self._locks.setdefault(run_id, asyncio.Lock()):
                stored = await _maybe(self._load(run_id))
                if stored is None:
                    return
                state = await RunState.from_string(agent, stored)
                waiting = state.get_interruptions()
                # Other waiting calls keep their requests and wake their own resumes.
                known = {self._item_key(item, run_id) for item in waiting}
                ready: list[str] = []
                if await self._settle(state, waiting, known, ready, run_id, request):
                    await self._drive(agent, state, run_id, known, ready, options)

        return resume

    async def _drive(self, agent: Agent[Any], current: Any, run_id: str | None, known: set[str], ready: list[str], options: Mapping[str, Any]) -> RunResult:
        token = _run_id.set(run_id)
        try:
            while True:
                try:
                    result = await Runner.run(agent, current, **options)
                finally:
                    while ready:  # an approval the run did not use is not kept for later
                        self._ready.pop(ready.pop(), None)
                if self.mode == "sync":
                    return result
                current = result.to_state()
                if not result.interruptions or not await self._settle(current, result.interruptions, known, ready, run_id, None):
                    break
            if self._save is not None and run_id is not None:
                await _maybe(self._save(run_id, current.to_string()))
            return result
        finally:
            _run_id.reset(token)

    def _item_key(self, item: ToolApprovalItem, run_id: str | None) -> str:
        return self._key(run_id, item.agent.name, item.call_id or "")

    async def _settle(self, state: RunState[Any, Any], items: list[ToolApprovalItem], known: set[str], ready: list[str], run_id: str | None, decided: Request | None) -> bool:
        """Ask the provider about each new call, or only the decided one. True if any was settled."""
        settled = False
        for item in items:
            key = self._item_key(item, run_id)
            if decided is not None:
                if key != (decided.context or {}).get("call_id"):
                    continue
                reasoning = decided.agent_reasoning  # as first sent, so the check finds the same request
            elif key in known:
                continue
            else:
                reasoning = self._reasoning.get(item.call_id or "")
            known.add(key)
            arguments = _arguments(item.arguments)
            origin = item.tool_origin
            server = origin.mcp_server_name if origin is not None and origin.type == ToolOriginType.MCP else None
            verdict: Verdict
            if arguments is None or not item.call_id:
                verdict = Deny(FAIL_CLOSED, "error")
            else:
                call = self._call(key, item.qualified_name or item.name or "", arguments, server, reasoning, run_id)
                verdict = await self.gate.check(call, can_pause=self._save is not None and run_id is not None)
            if isinstance(verdict, Pending):
                continue
            if isinstance(verdict, Allow):
                self._ready[key] = verdict
                ready.append(key)
                state.approve(item)
            else:
                state.reject(item, rejection_message=verdict.reason)
            settled = True
        return settled
