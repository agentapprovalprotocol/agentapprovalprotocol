"""Approvals for agents built on the Claude Agent SDK.

``ApprovalHooks`` installs a ``PreToolUse`` hook with no matcher, so every
tool call the agent makes goes to the provider: built-in tools, MCP tools
and calls made inside subagents. In sync mode the hook waits for the
decision. In async mode a call on the main thread is deferred: the run
ends with ``stop_reason="tool_deferred"``, the process can exit, and a
``Receiver`` resumes the session when the decision arrives. The resumed
session fires the hook again for the same call and the hook asks the
provider again, so resuming a session cannot approve a call.

Install with ``pip install "agentapprovalprotocol[claude-agent-sdk]"``.
"""

from __future__ import annotations

import asyncio
import logging
import weakref
from dataclasses import replace
from typing import Any, AsyncIterator, Awaitable, Callable, Literal, Mapping

from claude_agent_sdk import (
    ClaudeAgentOptions,
    HookMatcher,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    get_session_messages,
    get_session_messages_from_store,
    query,
)

from ._client import AsyncClient
from ._gate import FAIL_CLOSED, Allow, AsyncGate, Call, Deny, Pending, Verdict
from ._wire import Request

log = logging.getLogger("agentapprovalprotocol")

FRAMEWORK = "claude-agent-sdk"
NO_HANDLER = "This tool call needs permission and no permission handler is configured. The call was not run."

HookOutput = dict[str, Any]


def identify(name: str, mcp_server: Any = None) -> tuple[str, str | None]:
    """The tool and server a request records for a Claude tool name.

    MCP tools are spelled ``mcp__<server>__<tool>``: the server alias is
    everything up to the first double underscore after the marker, and the
    tool keeps any of its own. When the CLI names the server in the hook
    input, that name is used. Any other name is a built-in tool.
    """
    joined = name.removeprefix("mcp__")
    if joined == name:
        return name, None
    server, sep, tool = joined.partition("__")
    if not sep or not server or not tool:
        return name, None
    if isinstance(mcp_server, Mapping) and isinstance(mcp_server.get("name"), str) and mcp_server["name"]:
        server = mcp_server["name"]
    return tool, server


def _decision(decision: str, reason: str | None = None) -> HookOutput:
    out: dict[str, Any] = {"hookEventName": "PreToolUse", "permissionDecision": decision}
    if reason:
        out["permissionDecisionReason"] = reason
    return {"hookSpecificOutput": out}


def _failed(response: Any) -> bool:
    return isinstance(response, Mapping) and (response.get("isError") is True or response.get("is_error") is True)


class ApprovalHooks:
    """Send every tool call of a Claude Agent SDK agent to an AAP provider.

    Build the agent's options with ``options()``. It adds the hooks, leaves
    out user settings so a hook installed for Claude Code does not also run,
    and in async mode handles calls that cannot be deferred.

    Do not add other ``PreToolUse`` hooks that change tool input: the
    provider approves the input it was sent.
    """

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
        self.mode = gate.mode
        self.context = {"framework": FRAMEWORK, **(context or {})}
        # Hook calls wait up to the gate's limit; give them room to answer.
        self.timeout = gate.wait_limit + 60
        self._allowed: dict[str, Allow] = {}
        self._deferred: dict[str, Call] = {}
        self._published: dict[str, asyncio.Future[bool]] = {}
        self._asks = False
        self._slots: dict[str, tuple[str, str | None]] = {}
        self._locks: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[str, asyncio.Lock]] = weakref.WeakKeyDictionary()

    # Options

    def options(self, options: ClaudeAgentOptions | None = None, **fields: Any) -> ClaudeAgentOptions:
        """``options`` (or new options from ``fields``) with approvals installed."""
        options = replace(options or ClaudeAgentOptions(), **fields)
        hooks = {event: list(matchers) for event, matchers in (options.hooks or {}).items()}
        if any(self.pre_tool_use in matcher.hooks for matcher in hooks.get("PreToolUse", [])):
            raise ValueError("these options already have approvals installed")
        pre = [self.pre_tool_use, self._ask_while_deferred] if self.mode == "async" else [self.pre_tool_use]
        hooks.setdefault("PreToolUse", []).append(HookMatcher(hooks=pre, timeout=self.timeout))
        hooks.setdefault("PostToolUse", []).append(HookMatcher(hooks=[self.post_tool_use]))
        hooks.setdefault("PostToolUseFailure", []).append(HookMatcher(hooks=[self.post_tool_use]))
        changes: dict[str, Any] = {"hooks": hooks}
        if options.setting_sources is None:
            changes["setting_sources"] = ["project", "local"]
        if self.mode == "async":
            if options.permission_prompt_tool_name:
                raise ValueError("async mode answers permission prompts itself; remove permission_prompt_tool_name")
            changes["can_use_tool"] = self._permission_handler(options.can_use_tool)
            self._asks = True
        return replace(options, **changes)

    # Hooks

    async def pre_tool_use(self, input: Mapping[str, Any], tool_use_id: str | None, context: Any = None) -> HookOutput:
        """The ``PreToolUse`` callback. Any failure denies the call."""
        tool_use = (input.get("tool_use_id") if isinstance(input, Mapping) else None) or tool_use_id
        decision = _decision("deny", FAIL_CLOSED)
        try:
            decision = await self._pre_tool_use(input, tool_use)
        except Exception:  # noqa: BLE001 - every failure denies
            log.exception("approval hook failed")
        finally:
            if isinstance(tool_use, str):
                self._publish(tool_use, decision["hookSpecificOutput"]["permissionDecision"] == "defer")
        return decision

    async def _pre_tool_use(self, input: Mapping[str, Any], tool_use: Any) -> HookOutput:
        session = input.get("session_id")
        name = input.get("tool_name")
        arguments = input.get("tool_input")
        if input.get("hook_event_name", "PreToolUse") != "PreToolUse" or not all(isinstance(v, str) and v for v in (session, name, tool_use)) or not isinstance(arguments, Mapping):
            return _decision("deny", FAIL_CLOSED)
        subagent = bool(input.get("agent_id"))
        call = self._call(input, session, tool_use, name, arguments, pausable=self.mode == "async" and not subagent)
        if call.resume is None:
            verdict: Verdict = await self.gate.check(call, can_pause=False)
        else:
            verdict = await self._check_pausable(call, session, tool_use, input.get("prompt_id"))
        if isinstance(verdict, Pending):
            self._deferred[tool_use] = call
            return _decision("defer", "Waiting for approval.")
        self._deferred.pop(tool_use, None)
        if isinstance(verdict, Deny):
            return _decision("deny", verdict.reason)
        self._allowed[tool_use] = verdict
        return _decision("allow", "Approved.")

    def _call(self, input: Mapping[str, Any], session: str, tool_use: str, name: str, arguments: Mapping[str, Any], *, pausable: bool) -> Call:
        tool, server = identify(name, input.get("mcp_server"))
        context = dict(self.context)
        if isinstance(input.get("agent_type"), str):
            context["agent_type"] = input["agent_type"]
        resume = None
        if pausable:
            resume = {"framework": FRAMEWORK, "session_id": session, "tool_use_id": tool_use}
            if isinstance(input.get("cwd"), str) and input["cwd"]:
                resume["cwd"] = input["cwd"]
        return Call(key=f"{session}:{tool_use}", tool=tool, server=server, arguments=arguments, context=context, resume=resume)

    async def _check_pausable(self, call: Call, session: str, tool_use: str, prompt: Any) -> Verdict:
        """Defer at most one call per run, and wait for the others.

        When two calls of one turn are both deferred, the CLI keeps only the
        last one and the first is lost. So once a call of this run is
        deferred, other calls of the same run wait for their decision. A run
        resumed for the deferred call fires that call first.
        """
        prompt = prompt if isinstance(prompt, str) else None
        async with self._lock(session):
            holder = self._slots.get(session)
            if holder is None or holder[0] == tool_use or (prompt is not None and holder[1] != prompt):
                verdict = await self.gate.check(call, can_pause=True)
                if isinstance(verdict, Pending):
                    self._slots[session] = (tool_use, prompt)
                else:
                    self._slots.pop(session, None)
                return verdict
        return await self.gate.check(call, can_pause=False)

    async def _ask_while_deferred(self, input: Mapping[str, Any], tool_use_id: str | None, context: Any = None) -> HookOutput:
        """Turn a deferral the CLI ignores into a permission prompt.

        The CLI ignores ``defer`` in some cases and then runs its normal
        permission checks, which allow rules and permission modes can pass.
        This second callback answers ``ask`` while the call is deferred. A
        hook ``ask`` always reaches ``can_use_tool``, which waits for the
        decision.
        """
        tool_use = (input.get("tool_use_id") if isinstance(input, Mapping) else None) or tool_use_id
        if not isinstance(tool_use, str):
            return _decision("ask", FAIL_CLOSED)
        future = self._published.setdefault(tool_use, asyncio.get_running_loop().create_future())
        try:
            deferred = await asyncio.wait_for(asyncio.shield(future), self.timeout)
        except Exception:  # noqa: BLE001 - when in doubt, ask
            deferred = True
        finally:
            self._published.pop(tool_use, None)
        return _decision("ask", "Waiting for approval.") if deferred else {}

    def _publish(self, tool_use: str, deferred: bool) -> None:
        if not self._asks:
            return
        future = self._published.get(tool_use)
        if future is None:
            future = self._published[tool_use] = asyncio.get_running_loop().create_future()
        if not future.done():
            future.set_result(deferred)

    def _permission_handler(self, delegate: Callable[..., Awaitable[Any]] | None) -> Callable[..., Awaitable[Any]]:
        async def can_use_tool(tool_name: str, tool_input: dict[str, Any], context: Any) -> PermissionResultAllow | PermissionResultDeny:
            tool_use = getattr(context, "tool_use_id", None)
            call = self._deferred.pop(tool_use, None) if isinstance(tool_use, str) else None
            if call is None:
                if delegate is not None:
                    return await delegate(tool_name, tool_input, context)
                return PermissionResultDeny(message=NO_HANDLER)
            session = (call.resume or {}).get("session_id")
            if self._slots.get(session, ("",))[0] == tool_use:
                self._slots.pop(session, None)  # the run goes on, so it can defer another call
            try:
                if dict(tool_input) != dict(call.arguments):
                    return PermissionResultDeny(message=FAIL_CLOSED)
                verdict = await self.gate.check(call, can_pause=False)
            except Exception:  # noqa: BLE001 - every failure denies
                log.exception("approval permission handler failed")
                return PermissionResultDeny(message=FAIL_CLOSED)
            if isinstance(verdict, Allow):
                self._allowed[tool_use] = verdict
                return PermissionResultAllow()
            return PermissionResultDeny(message=verdict.reason if isinstance(verdict, Deny) else FAIL_CLOSED)

        return can_use_tool

    async def post_tool_use(self, input: Mapping[str, Any], tool_use_id: str | None, context: Any = None) -> HookOutput:
        """The ``PostToolUse`` and ``PostToolUseFailure`` callback: reports the outcome."""
        tool_use = (input.get("tool_use_id") if isinstance(input, Mapping) else None) or tool_use_id
        verdict = self._allowed.pop(tool_use, None) if isinstance(tool_use, str) else None
        if verdict is not None and self.gate.report_outcomes:
            failed = input.get("hook_event_name") == "PostToolUseFailure" or _failed(input.get("tool_response"))
            await verdict.report("failed" if failed else "succeeded")
        return {}

    def _lock(self, session: str) -> asyncio.Lock:
        locks = self._locks.setdefault(asyncio.get_running_loop(), {})
        return locks.setdefault(session, asyncio.Lock())


def _waiting_on(messages: Any, tool_use: str) -> bool:
    """Whether the transcript holds the tool call with no result yet."""
    found = False
    for message in messages:
        content = (getattr(message, "message", None) or {}).get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, Mapping):
                continue
            if block.get("type") == "tool_use" and block.get("id") == tool_use:
                found = True
            elif block.get("type") == "tool_result" and block.get("tool_use_id") == tool_use:
                return False
    return found


async def _session_waiting(options: ClaudeAgentOptions, session: str, tool_use: str) -> bool:
    directory = str(options.cwd) if options.cwd else None
    if options.session_store is not None:
        messages = await get_session_messages_from_store(options.session_store, session, directory=directory)
    else:
        messages = await asyncio.to_thread(get_session_messages, session, directory=directory)
    return _waiting_on(messages, tool_use)


def resumer(
    options: ClaudeAgentOptions | Callable[[Mapping[str, Any]], ClaudeAgentOptions],
    *,
    on_message: Callable[[Any], Awaitable[None] | None] | None = None,
) -> Callable[[Mapping[str, Any], Request], Awaitable[None]]:
    """A ``Receiver`` resumer for sessions run with ``query()`` in this process.

    ``options`` are the agent's options built with ``ApprovalHooks.options()``,
    or a function that builds them from the resume handle. The resumer
    resumes a session only while its transcript shows the deferred call
    without a result, one resume per session at a time. ``on_message``
    receives the resumed run's messages.
    """
    locks: dict[str, asyncio.Lock] = {}

    async def resume(handle: Mapping[str, Any], request: Request) -> None:
        session = handle.get("session_id")
        tool_use = handle.get("tool_use_id")
        if not isinstance(session, str) or not isinstance(tool_use, str):
            return
        base = options if isinstance(options, ClaudeAgentOptions) else options(handle)
        cwd = base.cwd or (handle.get("cwd") if isinstance(handle.get("cwd"), str) else None)
        settings = replace(base, resume=session, cwd=cwd, continue_conversation=False, fork_session=False, session_id=None)
        async with locks.setdefault(session, asyncio.Lock()):
            if not await _session_waiting(settings, session, tool_use):
                log.info("session %s is not waiting on request %s; not resuming", session, request.id)
                return
            finished = asyncio.Event()

            async def no_prompt() -> AsyncIterator[dict[str, Any]]:
                # Keeps input open for hooks until the resumed run ends.
                await finished.wait()
                return
                yield

            try:
                async for message in query(prompt=no_prompt(), options=settings):
                    if on_message is not None:
                        result = on_message(message)
                        if result is not None:
                            await result
                    if isinstance(message, ResultMessage):
                        finished.set()
            finally:
                finished.set()

    return resume
