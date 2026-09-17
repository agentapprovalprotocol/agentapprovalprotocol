// AAP extension for Pi: the runtime half of the Pi AAP adapter.
//
// Pi runs every model-proposed tool through its `tool_call` extension event.
// This extension snapshots the validated arguments, calls `aap hook pi`,
// and maps its verdict back to Pi. A denial returns `block: true`, which Pi
// exposes to the model as an isError tool result. Approval returns nothing so
// later guards still run.
//
// Pi lets later tool_call handlers mutate arguments. For an approval the provider
// gave we verify the arguments did not change while the provider was deciding, then
// deep-freeze them. A later attempted mutation therefore blocks in Pi's
// fail-safe tool_call error path instead of executing unapproved arguments.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const DEFAULT_APPROVAL_TIMEOUT_MS = 3_600_000;
const PROCESS_MARGIN_MS = 60_000;
const MAX_APPROVAL_TIMEOUT_MS = 2_147_483_647 - PROCESS_MARGIN_MS;
const MAX_OUTPUT_BYTES = 64 * 1024;

export const FAIL_CLOSED_TEXT =
  "This action is gated by your organization's approval policy, but the approval adapter could not return a decision. The call was not run (fail closed). Do not attempt this action through any other means.";
export const CANCELLED_TEXT =
  "This action is gated by your organization's approval policy and the tool call was cancelled before a human decided. The call was not run.";
export const ARGUMENTS_CHANGED_TEXT =
  "This action was approved with different tool arguments than the runtime was about to execute. The call was not run (fail closed).";

// `aap install pi` writes aap.json next to this file with the binary
// path and the AAP configuration root. AAP_BINARY can select a development
// executable; installed configuration retains its credential directory.
function readInstalledConfig() {
  try {
    const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "aap.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readConfig(env = process.env, installed = readInstalledConfig()) {
  const pick = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const binary = pick(env.AAP_BINARY) ?? pick(installed.binary) ?? "aap";
  const configDir = pick(installed.configDir) ?? pick(env.AAP_CONFIG_DIR);
  const configuredTimeout = Number(env.AAP_APPROVAL_TIMEOUT_MS ?? installed.approvalTimeoutMs);
  const approvalTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 60_000 && configuredTimeout <= MAX_APPROVAL_TIMEOUT_MS
    ? Math.floor(configuredTimeout)
    : DEFAULT_APPROVAL_TIMEOUT_MS;
  return { binary, configDir, approvalTimeoutMs };
}

function latestAssistantReasoning(ctx) {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const text = Array.isArray(entry.message.content)
      ? entry.message.content
          .filter((block) => block?.type === "text" && typeof block.text === "string")
          .map((block) => block.text.trim())
          .filter(Boolean)
          .join(" ")
      : "";
    if (!text) continue;
    return text.length > 280 ? `${text.slice(0, 277)}...` : text;
  }
  return "";
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

/** Spawn the adapter once for a call and resolve to a verdict. Never rejects. */
export function askAdapter({ binary, configDir, payload, timeoutMs, signal }) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    let child;
    const onAbort = () => {
      child?.kill("SIGTERM");
      settle({ decision: "deny", reason: CANCELLED_TEXT });
    };
    const settle = (verdict) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(verdict);
    };

    try {
      child = spawn(binary, ["hook", "pi"], { env: { ...process.env, ...(configDir ? { AAP_CONFIG_DIR: configDir } : {}) }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      console.error(`aap: failed to spawn ${binary}: ${String(error)}`);
      settle({ decision: "deny", reason: FAIL_CLOSED_TEXT });
      return;
    }

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const appendOutput = (stream, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        settle({ decision: "deny", reason: FAIL_CLOSED_TEXT });
        return stream;
      }
      return stream + chunk.toString();
    };
    child.stdout.on("data", (chunk) => { stdout = appendOutput(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendOutput(stderr, chunk); });
    child.on("error", (error) => {
      console.error(`aap: adapter process error: ${String(error)}`);
      settle({ decision: "deny", reason: FAIL_CLOSED_TEXT });
    });
    child.on("close", (code) => {
      if (settled) return;
      if (stderr.trim()) console.error(`aap: ${stderr.trim()}`);
      try {
        const verdict = JSON.parse(stdout.trim());
        const validAllow = verdict?.decision === "allow" && typeof verdict.gated === "boolean";
        const validDeny = verdict?.decision === "deny" && typeof verdict.reason === "string" && verdict.reason;
        if (code === 0 && (validAllow || validDeny)) {
          settle(verdict);
          return;
        }
      } catch {
        // Fall through to fail closed.
      }
      console.error(`aap: adapter exited ${code} without a verdict`);
      settle({ decision: "deny", reason: FAIL_CLOSED_TEXT });
    });

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ decision: "deny", reason: FAIL_CLOSED_TEXT });
    }, timeoutMs);
    timer.unref?.();
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

// Factory export makes the runtime behavior testable without loading Pi.
export function createAAPExtension(options = {}) {
  return function AAP(pi) {
    const config = options.config ?? readConfig();
    const runAdapter = options.askAdapter ?? askAdapter;

    pi.on("tool_call", async (event, ctx) => {
      let approvedArguments;
      try {
        approvedArguments = structuredClone(event.input);
      } catch (error) {
        console.error(`aap: could not snapshot tool arguments: ${String(error)}`);
        return { block: true, reason: FAIL_CLOSED_TEXT };
      }

      const verdict = await runAdapter({
        binary: config.binary,
        configDir: config.configDir,
        payload: {
          tool_name: event.toolName,
          arguments: approvedArguments,
          tool_call_id: event.toolCallId,
          session_id: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
          agent_reasoning: latestAssistantReasoning(ctx) || undefined,
          timeout_ms: config.approvalTimeoutMs,
        },
        timeoutMs: config.approvalTimeoutMs + PROCESS_MARGIN_MS,
        signal: ctx.signal,
      });

      if (verdict.decision === "deny") {
        return { block: true, reason: verdict.reason || FAIL_CLOSED_TEXT };
      }
      if (verdict.decision !== "allow" || typeof verdict.gated !== "boolean") {
        return { block: true, reason: FAIL_CLOSED_TEXT };
      }
      if (verdict.gated) {
        if (!Number.isFinite(Date.parse(verdict.expires_at)) || Date.now() >= Date.parse(verdict.expires_at)) return { block: true, reason: FAIL_CLOSED_TEXT };
        if (!isDeepStrictEqual(event.input, approvedArguments)) {
          return { block: true, reason: ARGUMENTS_CHANGED_TEXT };
        }
        deepFreeze(event.input);
      }
      return undefined;
    });
  };
}

export default createAAPExtension();
