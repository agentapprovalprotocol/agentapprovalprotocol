"""Approvals for Pydantic AI agents.

``ApprovalCapability`` gates every function tool call an agent makes,
including MCP and other toolset tools, with the arguments the tool will
run with. In sync mode the call waits for the decision. In async mode the
run ends with ``DeferredToolRequests``, you store its ``conversation``, and
a ``Receiver`` continues it when the decision arrives. On resume the
capability asks the provider again and ignores the approval passed in, so a
conversation continued by anything else cannot approve a call.

Install with ``pip install "agentapprovalprotocol[pydantic-ai]"``.
"""

from __future__ import annotations

import asyncio
import contextvars
import inspect
import logging
import types
import typing
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, Mapping, Sequence

from pydantic_core import to_jsonable_python
from pydantic_ai import DeferredToolRequests, DeferredToolResults
from pydantic_ai.capabilities import AbstractCapability, CapabilityOrdering
from pydantic_ai.conversation import Conversation
from pydantic_ai.exceptions import ApprovalRequired, ToolFailed, UserError
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models import ModelRequestContext
from pydantic_ai.tools import RunContext, ToolDefinition
from pydantic_ai.toolsets import AbstractToolset, WrapperToolset
from pydantic_ai.toolsets.abstract import ToolsetTool

from ._client import AsyncClient
from ._gate import FAIL_CLOSED, AsyncGate, Call, Deny, Pending
from ._wire import Request

log = logging.getLogger("agentapprovalprotocol")

FRAMEWORK = "pydantic-ai"
METADATA_KEY = "aap_request_id"
EDITED = "An approved call cannot run with edited arguments. The call was not run."
# Native tool search only finds tools among the agent's own, which are gated.
SEARCH_ONLY = frozenset({"tool_search"})

# Set while a gated tool runs. An agent run started inside that tool (a
# sub-agent) cannot pause: its caller would get the pause as a tool result.
_in_tool: contextvars.ContextVar[bool] = contextvars.ContextVar("aap_pydantic_ai_in_tool", default=False)


def _allows_deferred(spec: Any) -> bool:
    """Whether an agent's output type includes ``DeferredToolRequests``."""
    if spec is DeferredToolRequests:
        return True
    if isinstance(spec, (list, tuple)):
        return any(_allows_deferred(item) for item in spec)
    if typing.get_origin(spec) in (typing.Union, types.UnionType):
        return any(_allows_deferred(item) for item in typing.get_args(spec))
    return False


def _response_with(messages: Sequence[ModelMessage], tool_call_id: str) -> tuple[ModelResponse, ToolCallPart] | None:
    for message in reversed(messages):
        if isinstance(message, ModelResponse):
            for part in message.parts:
                if isinstance(part, ToolCallPart) and part.tool_call_id == tool_call_id:
                    return message, part
    return None


def _reasoning(response: ModelResponse | None) -> str | None:
    if response is None:
        return None
    text = "\n".join(part.content for part in response.parts if isinstance(part, TextPart)).strip()
    return text or None


@dataclass(init=False)
class ApprovalCapability(AbstractCapability[Any]):
    """Send every tool call to an AAP provider before it runs.

    Add it to the agent's ``capabilities`` and to every agent that runs as
    a sub-agent. Provider-run (native) tools cannot be gated, so a model
    request that includes one is refused.

    ``mode="async"`` pauses only when the agent's ``output_type`` includes
    ``DeferredToolRequests``; otherwise, and inside a sub-agent, calls wait.
    """

    gate: AsyncGate = field(repr=False)
    context: dict[str, Any] = field(default_factory=dict)

    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        *,
        mode: Literal["sync", "async"] = "sync",
        gate: AsyncGate | None = None,
        context: Mapping[str, Any] | None = None,
        **gate_options: Any,
    ):
        if gate is None:
            if base_url is None or token is None:
                raise ValueError("pass base_url and token, or a gate")
            gate = AsyncGate(AsyncClient(base_url, token), mode=mode, **gate_options)
        self.gate = gate
        self.context = {"framework": FRAMEWORK, **(context or {})}

    @classmethod
    def get_serialization_name(cls) -> str | None:
        return None

    def get_ordering(self) -> CapabilityOrdering:
        # Outermost, so tools other capabilities add around the agent's own
        # (a search or code tool, say) are gated too.
        return CapabilityOrdering(position="outermost")

    def get_wrapper_toolset(self, toolset: AbstractToolset[Any]) -> AbstractToolset[Any]:
        return _GatedToolset(toolset, approvals=self)

    async def before_model_request(self, ctx: RunContext[Any], request_context: ModelRequestContext) -> ModelRequestContext:
        kinds = {getattr(tool, "kind", type(tool).__name__) for tool in request_context.model_request_parameters.native_tools} - SEARCH_ONLY
        if kinds:
            raise UserError(f"Native tools run at the model provider and cannot be sent for approval: {', '.join(sorted(kinds))}. Remove them, or use a local tool instead.")
        return request_context

    async def after_tool_validate(self, ctx: RunContext[Any], *, call: ToolCallPart, tool_def: ToolDefinition, args: dict[str, Any]) -> dict[str, Any]:
        # ToolApproved(override_args=...) replaces the call's arguments. An
        # approval covers the arguments it was given, so refuse the edit.
        if ctx.tool_call_approved:
            found = _response_with(ctx.messages, call.tool_call_id)
            if found is not None and found[1].args_as_dict() != call.args_as_dict():
                raise ToolFailed(EDITED)
        return args

    def _call(self, name: str, args: dict[str, Any], ctx: RunContext[Any]) -> tuple[Call, bool]:
        conversation = ctx.conversation_id
        tool_call_id = ctx.tool_call_id or "-"
        found = _response_with(ctx.messages, tool_call_id)
        resume = None
        if conversation is not None:
            resume = {"framework": FRAMEWORK, "conversation_id": conversation}
        call = Call(
            key=f"{conversation or '-'}:{tool_call_id}",
            tool=name,
            arguments=to_jsonable_python(args),
            reasoning=_reasoning(found[0] if found else None),
            context=self.context,
            resume=resume,
        )
        can_pause = (
            conversation is not None
            and ctx.tool_call_id is not None
            and not _in_tool.get()
            and ctx.agent is not None
            and _allows_deferred(ctx.agent.output_type)
        )
        return call, can_pause


@dataclass
class _GatedToolset(WrapperToolset[Any]):
    """Checks each call with the gate, at the point the tool runs."""

    approvals: ApprovalCapability = field(kw_only=True)

    async def call_tool(self, name: str, tool_args: dict[str, Any], ctx: RunContext[Any], tool: ToolsetTool[Any]) -> Any:
        gate = self.approvals.gate
        try:
            call, can_pause = self.approvals._call(name, tool_args, ctx)
        except Exception:  # noqa: BLE001 - arguments that cannot be sent are not run
            log.exception("could not build the approval request for %s", name)
            raise ToolFailed(FAIL_CLOSED) from None
        verdict = await gate.check(call, can_pause=can_pause)
        if isinstance(verdict, Pending):
            # The run ends with DeferredToolRequests. Any approval passed back
            # on resume is ignored: this check runs again and asks the provider.
            raise ApprovalRequired(metadata={METADATA_KEY: verdict.request_id})
        if isinstance(verdict, Deny):
            raise ToolFailed(verdict.reason)
        token = _in_tool.set(True)
        try:
            result = await self.wrapped.call_tool(name, tool_args, ctx, tool)
        except BaseException:
            if gate.report_outcomes:
                await verdict.report("failed")
            raise
        finally:
            _in_tool.reset(token)
        if gate.report_outcomes:
            await verdict.report("succeeded")
        return result


def pending_request_ids(requests: DeferredToolRequests | None) -> dict[str, str]:
    """The AAP request each paused call waits on, keyed by tool call ID."""
    if requests is None:
        return {}
    out = {}
    for call in requests.approvals:
        request_id = (requests.metadata.get(call.tool_call_id) or {}).get(METADATA_KEY)
        if isinstance(request_id, str):
            out[call.tool_call_id] = request_id
    return out


async def _maybe(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


def resumer(
    agent: Any,
    *,
    load: Callable[[str], Conversation | None | Awaitable[Conversation | None]],
    save: Callable[[Conversation], Any],
    **run_options: Any,
) -> Callable[[Mapping[str, Any], Request], Awaitable[None]]:
    """A ``Receiver`` resumer that continues a stored conversation.

    ``load(conversation_id)`` returns the ``Conversation`` you saved when the
    run paused, or ``None``. The resumed run's conversation is passed to
    ``save``. Either may be async. ``run_options`` (``deps``, for example)
    are passed to ``agent.run``.

    A conversation is continued only while it waits on the decided request,
    one resume per conversation at a time in this process. Every paused
    approval in it is answered, and each is checked with the provider again:
    calls still undecided pause again.
    """
    locks: dict[str, asyncio.Lock] = {}

    async def resume(handle: Mapping[str, Any], request: Request) -> None:
        conversation_id = handle.get("conversation_id")
        if not isinstance(conversation_id, str):
            return
        async with locks.setdefault(conversation_id, asyncio.Lock()):
            conversation = await _maybe(load(conversation_id))
            if conversation is None:
                return
            waiting = conversation.deferred_tool_requests
            ids = pending_request_ids(waiting)
            if request.id not in ids.values():
                return
            assert waiting is not None
            if waiting.calls or len(ids) != len(waiting.approvals):
                log.warning("conversation %s also waits on calls that are not AAP approvals; resume it yourself", conversation_id)
                return
            results = DeferredToolResults(approvals={tool_call_id: True for tool_call_id in ids})
            result = await agent.run(conversation=conversation, deferred_tool_results=results, **run_options)
            await _maybe(save(result.conversation))

    return resume
