// AAP plugin for OpenClaw: the runtime half of the OpenClaw adapter.
//
// OpenClaw runs every tool call through its `before_tool_call` waterfall.
// This plugin registers a handler there that hands the call to the
// `aap` binary (`aap hook openclaw`), which does the AAP work:
// create the approval request (the organization's pipeline decides whether
// it waits for a human), long-poll for the decision, and map it to a
// verdict. The plugin owns what
// only the runtime side can own:
//
//   - the hook ceiling: OpenClaw times a `before_tool_call` handler out after
//     15 seconds by default and fails closed with a generic reason; the
//     registration below raises that to `approvalTimeoutMs` plus a margin so
//     the provider's own expiry, with the boundary text, arrives first;
//   - fail closed on every path that does not yield a verdict: a missing or
//     crashing binary, non-JSON output, an aborted tool call;
//   - the verdict mapping: allow returns nothing, so OpenClaw's exec
//     approvals and tool policy still apply; deny returns `block` with the
//     boundary text, which OpenClaw hands to the model as the tool result.
//
// This file is plain ESM with no imports so it loads from
// `plugins.load.paths` without a build step or a node_modules of its own;
// the entry shape is the one `definePluginEntry` would produce.

import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

// The Go hook subtracts 30 seconds, leaving a full week for approval.
const DEFAULT_APPROVAL_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000 + 30_000;
const HOOK_MARGIN_MS = 60_000;
const FAIL_CLOSED_TEXT =
  "This action is gated by your organization's approval policy, but the approval adapter could not return a decision. The call was not run (fail closed). Do not attempt this action through any other means.";
const CANCELLED_TEXT =
  "This action is gated by your organization's approval policy and the tool call was cancelled before a human decided. The call was not run.";

function readConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const binary = typeof cfg.binary === "string" && cfg.binary.trim() ? cfg.binary.trim() : "aap";
  // The credential the adapter uses: `aap install` configures one instance per
  // runtime and every hook it installs names its own.
  const configDir = typeof cfg.configDir === "string" ? cfg.configDir : undefined;
  const approvalTimeoutMs =
    Number.isFinite(cfg.approvalTimeoutMs) && cfg.approvalTimeoutMs >= 60_000
      ? Math.floor(cfg.approvalTimeoutMs)
      : DEFAULT_APPROVAL_TIMEOUT_MS;
  return { binary, configDir, approvalTimeoutMs };
}

/** Spawn the adapter once for this call and resolve to its verdict. Never rejects. */
function askAdapter({ binary, configDir, payload, timeoutMs, signal, logger }) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (verdict) => {
      if (settled) return;
      settled = true;
      resolve(verdict);
    };
    let child;
    try {
      child = spawn(binary, ["hook", "openclaw"], { env: { ...process.env, ...(configDir ? { AAP_CONFIG_DIR: configDir } : {}) }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      logger?.error?.(`aap: failed to spawn ${binary}: ${String(error)}`);
      settle({ decision: "deny", reason: FAIL_CLOSED_TEXT });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      logger?.error?.(`aap: adapter process error: ${String(error)}`);
      settle({ decision: "deny", reason: FAIL_CLOSED_TEXT });
    });
    child.on("close", (code) => {
      if (stderr.trim()) logger?.warn?.(`aap: ${stderr.trim()}`);
      try {
        const verdict = JSON.parse(stdout.trim());
        if (code === 0 && verdict && (verdict.decision === "allow" || verdict.decision === "deny")) {
          settle(verdict);
          return;
        }
      } catch {
        // fall through to fail closed
      }
      logger?.error?.(`aap: adapter exited ${code} without a verdict`);
      settle({ decision: "deny", reason: FAIL_CLOSED_TEXT });
    });
    const onAbort = () => {
      child.kill("SIGTERM");
      settle({ decision: "deny", reason: CANCELLED_TEXT });
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
    // Belt and braces: the adapter derives its own deadline from timeout_ms,
    // but a wedged process must not outlive the hook ceiling either.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ decision: "deny", reason: FAIL_CLOSED_TEXT });
    }, timeoutMs);
    timer.unref?.();
    child.on("close", () => clearTimeout(timer));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

export default {
  id: "aap",
  name: "AAP",
  description: "Hold gated tool calls for human approval through the organization's AAP instance.",
  configSchema: { type: "object", additionalProperties: false },
  register(api) {
    const config = readConfig(api.pluginConfig);
    const logger = api.logger;
    const hookTimeoutMs = config.approvalTimeoutMs + HOOK_MARGIN_MS;
    api.on(
      "before_tool_call",
      async (event, ctx) => {
        let snapshot;
        try { snapshot = structuredClone(event.params ?? {}); } catch { return { block: true, blockReason: FAIL_CLOSED_TEXT }; }
        const payload = {
          tool_name: event.toolName,
          params: snapshot,
          tool_kind: event.toolKind,
          tool_call_id: event.toolCallId,
          run_id: event.runId ?? ctx?.runId,
          agent_id: ctx?.agentId,
          session_id: ctx?.sessionId,
          session_key: ctx?.sessionKey,
          cwd: typeof event.params?.workdir === "string" ? event.params.workdir : undefined,
          timeout_ms: config.approvalTimeoutMs,
        };
        const verdict = await askAdapter({
          binary: config.binary,
          configDir: config.configDir,
          payload,
          timeoutMs: hookTimeoutMs,
          signal: ctx?.abortSignal,
          logger,
        });
        if (verdict.decision === "deny") {
          return { block: true, blockReason: verdict.reason || FAIL_CLOSED_TEXT };
        }
        if (typeof verdict.gated !== "boolean") return { block: true, blockReason: FAIL_CLOSED_TEXT };
        if (verdict.gated) {
          if (!Number.isFinite(Date.parse(verdict.expires_at)) || Date.now() >= Date.parse(verdict.expires_at)) return { block: true, blockReason: FAIL_CLOSED_TEXT };
          if (!isDeepStrictEqual(event.params ?? {}, snapshot)) return { block: true, blockReason: FAIL_CLOSED_TEXT };
          return { params: snapshot };
        }
        return undefined;
      },
      {
        priority: 100,
        timeoutMs: hookTimeoutMs,
      },
    );
    logger?.info?.(
      `aap: gating tool calls via ${config.binary} (approval window ${Math.round(config.approvalTimeoutMs / 60000)} min)`,
    );
  },
};
