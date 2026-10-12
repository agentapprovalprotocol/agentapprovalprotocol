"""Approvals for CrewAI crews, agents and flows.

``ApprovalHooks`` installs CrewAI's global tool-call hooks, so every tool
call any agent makes in this process goes to the provider first: native
function calls, text (ReAct) tool calls, ``Agent.kickoff``, flows and
coworker delegation. CrewAI hooks are synchronous and cannot pause a run,
so each call waits for the decision while the run blocks.

CrewAI ignores any error a hook raises except ``HookAborted`` and runs the
tool anyway. Every failure here is turned into a block, so a broken
provider or a bug in this module stops the call instead of letting it run.

Known limits, all outside what a hook can see:

- Hooks registered after ``install()``, including the ones a ``@CrewBase``
  crew registers when it is created, run after the approval and could
  change the arguments. The arguments are snapshotted before approval; a
  change is logged and reported to the provider as a failed outcome.
- Tools run directly through ``llm.call(available_functions=...)`` skip
  CrewAI's hooks and are not gated.
- A wait blocks the thread that runs the tool, which is the event loop for
  ``akickoff`` and other native async runs.

Install with ``pip install "agentapprovalprotocol[crewai]"``.
"""

from __future__ import annotations

import contextvars
import copy
import functools
import hashlib
import inspect
import logging
import threading
import uuid
from dataclasses import dataclass
from typing import Any, Mapping

from crewai.hooks import (
    HookAborted,
    LLMCallHookContext,
    ToolCallHookContext,
    register_after_tool_call_hook,
    register_before_llm_call_hook,
    register_before_tool_call_hook,
    unregister_after_tool_call_hook,
    unregister_before_llm_call_hook,
    unregister_before_tool_call_hook,
)
from crewai.tools.structured_tool import CrewStructuredTool
from crewai.tools.tool_failure import ToolFailure

from ._client import Client
from ._gate import FAIL_CLOSED, Allow, Call, Deny, Gate, Verdict
from ._wire import dumps

log = logging.getLogger("agentapprovalprotocol")

PROVIDER_TOOLS = "This model runs built-in tools at the model provider, which cannot be sent for approval. Remove builtin_tools from the LLM."
SPENT = "The tool failed, and its approval covers one attempt, so it was not retried. Request approval again if it still needs to happen."
CHANGED = "Tool arguments were changed after approval by a hook that runs after the approval hook."
BLOCKED = "Tool execution blocked by hook."
FAILED_PREFIXES = (BLOCKED, "Error executing tool", "I encountered an error while trying to use the tool")


@dataclass(frozen=True)
class _Pending:
    """One checked call, from the before hook to its after hook."""

    tool_name: str
    tool_input: Any
    snapshot: dict[str, Any]
    verdict: Verdict
    restore: tuple[CrewStructuredTool, Any] | None = None


class ApprovalSpent(Exception):
    """A tool was invoked again under an approval that was already used."""


def _once(func: Any) -> Any:
    """Let ``func`` run once. CrewAI retries a text tool call that raised
    without asking the hooks again, so the approval must stop the retries."""
    lock, used = threading.Lock(), [False]

    def take() -> None:
        with lock:
            if used[0]:
                raise ApprovalSpent(SPENT)
            used[0] = True

    if inspect.iscoroutinefunction(func):

        @functools.wraps(func)
        async def guarded_async(*args: Any, **kwargs: Any) -> Any:
            take()
            return await func(*args, **kwargs)

        guarded: Any = guarded_async
    else:

        @functools.wraps(func)
        def guarded(*args: Any, **kwargs: Any) -> Any:
            take()
            return func(*args, **kwargs)

    guarded.__aap_once__ = True
    return guarded


def _guard(tool: Any) -> tuple[CrewStructuredTool, Any] | None:
    """Make the tool run at most once until the after hook restores it."""
    if not isinstance(tool, CrewStructuredTool) or tool.func is None or getattr(tool.func, "__aap_once__", False):
        return None
    original = tool.func
    tool.func = _once(original)
    return tool, original


# Before and after hooks for one call get different context objects. They
# run in the same thread or task, nested around any calls the tool makes
# itself (a coworker delegation), so the latest matching entry is this one.
_checked: contextvars.ContextVar[tuple[_Pending, ...]] = contextvars.ContextVar("aap_crewai_checked", default=())


def _tool(ctx: ToolCallHookContext) -> tuple[str, str | None]:
    """The tool name and MCP server alias the provider sees."""
    original = getattr(ctx.tool, "_original_tool", None)
    server = getattr(original, "server_name", None)
    name = getattr(original, "original_tool_name", None)
    if isinstance(server, str) and server and isinstance(name, str) and name:
        return name, server
    return ctx.tool_name, None


def _failed(ctx: ToolCallHookContext) -> bool:
    raw = ctx.raw_tool_result
    if isinstance(raw, ToolFailure):
        return True
    return isinstance(raw, str) and raw == ctx.tool_result and raw.lstrip().startswith(FAILED_PREFIXES)


class ApprovalHooks:
    """Send every CrewAI tool call to an AAP provider before it runs.

    Call ``install()`` once before running crews, or use the instance as a
    context manager. Register any hook that changes tool arguments before
    it, so the provider approves the arguments that will run. A ``Gate`` in
    async mode waits too: CrewAI cannot pause a run at a tool call.
    """

    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        *,
        gate: Gate | None = None,
        context: Mapping[str, Any] | None = None,
        **gate_options: Any,
    ):
        if gate is None and (base_url is None or token is None):
            raise ValueError("pass base_url and token, or a gate")
        self.gate = gate if gate is not None else Gate(Client(base_url, token), **gate_options)
        self.context = {"framework": "crewai", **(context or {})}
        self._run = uuid.uuid4().hex
        self._counts: dict[tuple[str, str], int] = {}
        self._lock = threading.Lock()
        self._installed = False

    # Installation

    def install(self) -> ApprovalHooks:
        """Register the hooks globally. Safe to call more than once."""
        with self._lock:
            if not self._installed:
                register_before_tool_call_hook(self.before_tool_call)
                register_after_tool_call_hook(self.after_tool_call)
                register_before_llm_call_hook(self.before_llm_call)
                self._installed = True
        return self

    def uninstall(self) -> None:
        with self._lock:
            unregister_before_tool_call_hook(self.before_tool_call)
            unregister_after_tool_call_hook(self.after_tool_call)
            unregister_before_llm_call_hook(self.before_llm_call)
            self._installed = False

    def __enter__(self) -> ApprovalHooks:
        return self.install()

    def __exit__(self, *exc: Any) -> None:
        self.uninstall()

    # Hooks

    def before_tool_call(self, ctx: ToolCallHookContext) -> None:
        try:
            snapshot = copy.deepcopy(dict(ctx.tool_input or {}))
            verdict = self.gate.check(self._call(ctx, snapshot), can_pause=False)
        except Exception:  # noqa: BLE001 - CrewAI would run the tool on any other error
            log.exception("approval hook failed")
            snapshot, verdict = {}, Deny(FAIL_CLOSED, "error")
        try:
            restore = _guard(ctx.tool) if isinstance(verdict, Allow) else None
            _checked.set((*_checked.get(), _Pending(ctx.tool_name, ctx.tool_input, snapshot, verdict, restore)))
        except Exception:  # noqa: BLE001
            log.exception("approval hook failed")
            raise HookAborted(FAIL_CLOSED) from None
        if not isinstance(verdict, Allow):
            raise HookAborted(verdict.reason)

    def after_tool_call(self, ctx: ToolCallHookContext) -> str | None:
        try:
            entry = self._take(ctx)
            if entry is None:
                return None
            if entry.restore is not None:
                tool, original = entry.restore
                tool.func = original
            if isinstance(entry.verdict, Deny):
                return entry.verdict.reason
            if isinstance(entry.verdict, Allow) and self.gate.report_outcomes:
                changed = dict(ctx.tool_input or {}) != entry.snapshot
                if changed:
                    log.error("%s: %s", ctx.tool_name, CHANGED)
                note = CHANGED if changed else ("Blocked by another hook." if str(ctx.tool_result).startswith(BLOCKED) else None)
                entry.verdict.report("failed" if changed or _failed(ctx) else "succeeded", note)
        except Exception:  # noqa: BLE001 - reporting is best effort
            log.warning("could not handle a tool result", exc_info=True)
        return None

    def before_llm_call(self, ctx: LLMCallHookContext) -> None:
        try:
            refused = bool(getattr(ctx.llm, "builtin_tools", None))
        except Exception:  # noqa: BLE001
            refused = True
        if refused:
            raise HookAborted(PROVIDER_TOOLS)

    # Internals

    def _call(self, ctx: ToolCallHookContext, arguments: dict[str, Any]) -> Call:
        """CrewAI gives hooks no tool call id, so the key is the task (or
        agent, for ``Agent.kickoff``), a digest of the call, and how many
        times this process has seen that call in that task. A repeat within
        a run, such as a guardrail retry, is a new attempt and asks again. A
        task resumed from a checkpoint keeps its id, so the same call finds
        the request already made: it waits on it if pending and is refused
        if its approval was used. The count is per call, not global, so
        parallel tool calls get the same keys whatever order they run in.
        """
        tool, server = _tool(ctx)
        scope = getattr(ctx.task, "id", None) or getattr(ctx.agent, "id", None) or self._run
        digest = hashlib.sha256(dumps({"tool": tool, "server": server, "arguments": arguments})).hexdigest()[:32]
        with self._lock:
            attempt = self._counts.get((str(scope), digest), 0)
            self._counts[(str(scope), digest)] = attempt + 1
        role = getattr(ctx.agent, "role", None)
        context = {**self.context, **({"agent_role": role} if isinstance(role, str) and role else {})}
        return Call(key=f"{scope}:{digest}:{attempt}", tool=tool, arguments=arguments, server=server, context=context)

    def _take(self, ctx: ToolCallHookContext) -> _Pending | None:
        entries = _checked.get()
        for index in range(len(entries) - 1, -1, -1):
            entry = entries[index]
            if entry.tool_name == ctx.tool_name and (entry.tool_input is ctx.tool_input or entry.snapshot == dict(ctx.tool_input or {})):
                _checked.set(entries[:index] + entries[index + 1 :])
                return entry
        return None
