"""Approvals for Google Agent Development Kit (ADK) agents.

``ApprovalPlugin`` gates every tool call any agent in a runner makes,
including sub-agents and agents used as tools. In sync mode the call waits
for the decision. In async mode the run pauses with an ADK tool
confirmation, the process can exit, and a ``Receiver`` wakes the session
when the decision arrives. On resume the plugin asks the provider again and
ignores the confirmation's ``confirmed`` flag, so a confirmation sent by
anything else cannot approve a call.

Install with ``pip install "agentapprovalprotocol[adk]"``.
"""

from __future__ import annotations

import asyncio
import contextvars
from typing import Any, Awaitable, Callable, Iterable, Literal, Mapping

from google.adk.agents import BaseAgent, LlmAgent
from google.adk.apps import App
from google.adk.events import Event
from google.adk.plugins.base_plugin import BasePlugin
from google.adk.tools.agent_tool import AgentTool
from google.genai import types

from ._client import AsyncClient
from ._gate import Allow, AsyncGate, Call, Deny, Pending
from ._wire import Request

PAYLOAD_KEY = "aap_request_id"
CONFIRMATION = "adk_request_confirmation"
PENDING_TEXT = "This call is waiting for approval. It will run if it is approved."

# Tool fields Gemini executes itself, outside ADK's tool pipeline, are refused.
# Function declarations (and computer use, whose actions are function calls)
# come back to ADK as calls the plugin sees.
_CLIENT_RUN = {"function_declarations", "computer_use"}

# Set while an approved tool runs, so calls made inside it (an agent used as
# a tool runs a nested runner) know their run cannot pause.
_inside_tool: contextvars.ContextVar[bool] = contextvars.ContextVar("aap_adk_inside_tool", default=False)


class UnsupportedToolError(RuntimeError):
    """An agent uses something whose calls cannot wait for approval."""


def _function_call(events: Iterable[Event], call_id: str | None) -> tuple[Event, types.FunctionCall] | None:
    if not call_id:
        return None
    for event in reversed(list(events)):
        for call in event.get_function_calls():
            if call.id == call_id and call.name != CONFIRMATION:
                return event, call
    return None


def _reasoning(event: Event | None) -> str | None:
    if event is None or event.content is None:
        return None
    text = "".join(part.text for part in event.content.parts or [] if part.text and not part.thought)
    return text.strip() or None


def _failed(result: Any) -> bool:
    return isinstance(result, Mapping) and "error" in result


class ApprovalPlugin(BasePlugin):
    """Send every tool call to an AAP provider before it runs.

    Register it first in ``App(plugins=[...])``, so no other plugin answers
    or rewrites a call before the provider sees it, and keep tool arguments
    unchanged in later plugins and agent ``before_tool_callback``s.

    ``mode="async"`` pauses runs and needs ``App(resumability_config=
    ResumabilityConfig(is_resumable=True))``. Calls that cannot pause wait
    instead: calls in an app that is not resumable, inside an agent used as a
    tool, in live (bidi) runs and in workflow tool nodes.
    """

    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        *,
        mode: Literal["sync", "async"] = "sync",
        gate: AsyncGate | None = None,
        context: Mapping[str, Any] | None = None,
        name: str = "aap_approvals",
        **gate_options: Any,
    ):
        super().__init__(name)
        if gate is None and (base_url is None or token is None):
            raise ValueError("pass base_url and token, or a gate")
        self.gate = gate or AsyncGate(AsyncClient(base_url, token), mode=mode, **gate_options)  # type: ignore[arg-type]
        self.context = {"framework": "adk", **(context or {})}
        self._allowed: dict[str, Allow] = {}

    def _call(self, tool: Any, args: Mapping[str, Any], tool_context: Any) -> tuple[Call, bool]:
        ic = tool_context.get_invocation_context()
        session = ic.session
        found = _function_call(session.events, tool_context.function_call_id)
        # A call inside a running tool never pauses, so nothing should wake a run for it.
        resume = None if _inside_tool.get() else {"framework": "adk", "app_name": session.app_name, "user_id": session.user_id, "session_id": session.id}
        call = Call(
            key=f"{session.app_name}:{session.user_id}:{session.id}:{ic.invocation_id}:{tool_context.function_call_id}",
            tool=tool.name,
            arguments=dict(args),
            reasoning=_reasoning(found[0] if found else None),
            context={**self.context, "agent": tool_context.agent_name},
            resume=resume,
        )
        # A pause needs a resumable app, a model function call ADK can resume,
        # and a run that is not live or nested inside another tool.
        can_pause = ic.is_resumable and found is not None and ic.live_request_queue is None and not _inside_tool.get()
        return call, can_pause

    async def before_tool_callback(self, *, tool: Any, tool_args: dict[str, Any], tool_context: Any) -> dict[str, Any] | None:
        confirmation = tool_context.tool_confirmation
        if (confirmation is None or not confirmation.confirmed) and await tool.check_require_confirmation(tool_args, tool_context) is True:
            # The tool has its own ADK confirmation, which answers this call
            # without running it. Ask the provider once the user confirms.
            return None
        call, can_pause = self._call(tool, tool_args, tool_context)
        # A confirmation never approves a call: the provider is asked again.
        verdict = await self.gate.check(call, can_pause=can_pause)
        if isinstance(verdict, Pending):
            tool_context.request_confirmation(hint=PENDING_TEXT, payload={PAYLOAD_KEY: verdict.request_id})
            tool_context.actions.skip_summarization = True
            return {"status": "pending", "message": PENDING_TEXT}
        if isinstance(verdict, Deny):
            return {"error": verdict.reason}
        self._allowed[call.key] = verdict
        _inside_tool.set(True)
        return None

    async def after_tool_callback(self, *, tool: Any, tool_args: dict[str, Any], tool_context: Any, result: Any) -> None:
        await self._report(tool, tool_args, tool_context, "failed" if _failed(result) else "succeeded")
        return None

    async def on_tool_error_callback(self, *, tool: Any, tool_args: dict[str, Any], tool_context: Any, error: Exception) -> None:
        await self._report(tool, tool_args, tool_context, "failed")
        return None

    async def _report(self, tool: Any, tool_args: Mapping[str, Any], tool_context: Any, status: Literal["succeeded", "failed"]) -> None:
        call, _ = self._call(tool, tool_args, tool_context)
        verdict = self._allowed.pop(call.key, None)
        if verdict is not None and self.gate.report_outcomes:
            await verdict.report(status)

    async def before_model_callback(self, *, callback_context: Any, llm_request: Any) -> None:
        agent = callback_context.get_invocation_context().agent
        _refuse_code_executor(agent)
        for tool in (llm_request.config.tools if llm_request.config else None) or []:
            fields = set(tool.model_dump(exclude_none=True)) if isinstance(tool, types.Tool) else {type(tool).__name__}
            if fields - _CLIENT_RUN:
                names = ", ".join(sorted(fields - _CLIENT_RUN))
                raise UnsupportedToolError(f"Agent {getattr(agent, 'name', '?')!r} uses {names}, which Gemini runs itself, so its calls cannot wait for approval. Remove it from the agent.")
        return None


def _refuse_code_executor(agent: Any) -> None:
    if getattr(agent, "code_executor", None) is not None:
        raise UnsupportedToolError(f"Agent {agent.name!r} runs model-written code with a code executor, which cannot wait for approval. Remove the code executor.")


def check_coverage(app: App, plugin: ApprovalPlugin) -> None:
    """Raise ``UnsupportedToolError`` where calls would not reach ``plugin``.

    Checks that the plugin is the app's first plugin, and walks every agent,
    sub-agent and agent used as a tool for code executors, agents used as
    tools without the app's plugins, and remote agents. Gemini built-in tools
    are refused when the model is called.
    """
    if not app.plugins or app.plugins[0] is not plugin:
        raise UnsupportedToolError("Register the approval plugin first in App(plugins=[...]).")
    seen: set[int] = set()

    def walk(agent: BaseAgent) -> None:
        if id(agent) in seen:
            return
        seen.add(id(agent))
        if type(agent).__name__ == "RemoteA2aAgent":
            raise UnsupportedToolError(f"Agent {agent.name!r} runs on another server. Add an approval plugin there.")
        _refuse_code_executor(agent)
        if isinstance(agent, LlmAgent):
            for tool in agent.tools:
                if isinstance(tool, AgentTool):
                    if not tool.include_plugins:
                        raise UnsupportedToolError(f"Agent tool {tool.name!r} runs without the app's plugins. Remove include_plugins=False.")
                    walk(tool.agent)
        for sub in agent.sub_agents:
            walk(sub)

    if app.root_agent is not None:
        walk(app.root_agent)  # type: ignore[arg-type]


def waiting(events: Iterable[Event], request_id: str) -> list[str]:
    """IDs of the confirmation calls to answer to resume calls waiting on one request.

    A call is waiting when its latest response is a pause on this request.
    ADK re-runs a call when its latest confirmation is answered, even again,
    so a call paused a second time is resumed through the same confirmation.
    """
    events = list(events)
    last: dict[str, Event] = {}
    confirmations: dict[str, str] = {}
    for event in events:
        for response in event.get_function_responses():
            if response.id and response.name != CONFIRMATION:
                last[response.id] = event
        for call in event.get_function_calls():
            original = (call.args or {}).get("originalFunctionCall") if call.name == CONFIRMATION else None
            if call.id and isinstance(original, Mapping) and isinstance(original.get("id"), str):
                confirmations[original["id"]] = call.id
    out = []
    for call_id, event in last.items():
        pause = (event.actions.requested_tool_confirmations or {}).get(call_id)
        payload = getattr(pause, "payload", None)
        if isinstance(payload, Mapping) and payload.get(PAYLOAD_KEY) == request_id and call_id in confirmations:
            out.append(confirmations[call_id])
    return out


def wake_message(events: Iterable[Event], request_id: str) -> types.Content | None:
    """The message that resumes a session paused on one request, or None.

    Send it as ``new_message`` to the runner, or to an ADK API server's
    ``/run`` endpoint. The plugin asks the provider again on resume, so the
    message itself approves nothing.
    """
    ids = waiting(events, request_id)
    if not ids:
        return None
    parts = [types.Part(function_response=types.FunctionResponse(name=CONFIRMATION, id=i, response={"confirmed": True})) for i in ids]
    return types.Content(role="user", parts=parts)


def resumer(runner: Any, *, run_config: Any = None) -> Callable[[Mapping[str, Any], Request], Awaitable[None]]:
    """A ``Receiver`` resumer for a ``Runner`` in this process.

    It resumes only the confirmations waiting on the decided request, one
    resume per session at a time. The resumed run continues here, so read
    results from the session, not from the run that started it.
    """
    locks: dict[tuple[str, str], asyncio.Lock] = {}

    async def resume(handle: Mapping[str, Any], request: Request) -> None:
        user, session_id = handle.get("user_id"), handle.get("session_id")
        if handle.get("app_name") != runner.app_name or not isinstance(user, str) or not isinstance(session_id, str):
            return
        async with locks.setdefault((user, session_id), asyncio.Lock()):
            session = await runner.session_service.get_session(app_name=runner.app_name, user_id=user, session_id=session_id)
            message = wake_message(session.events, request.id) if session else None
            if message is None:
                return
            async for _ in runner.run_async(user_id=user, session_id=session_id, new_message=message, run_config=run_config):
                pass

    return resume
