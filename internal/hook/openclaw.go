package hook

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/aap"
)

// OpenClaw runs the tool gate for OpenClaw, called by the AAP OpenClaw
// plugin (internal/cli/plugins/assets/openclaw) from its `before_tool_call` handler.
//
// OpenClaw has no external hook protocol: every extension point is an
// in-process plugin. The plugin owns the runtime side (registration on the
// waterfall, the hook ceiling, spawn and abort handling, fail-closed on any
// failure to get a verdict) and this frontend owns the AAP side. The plugin
// writes one JSON payload to stdin and reads one JSON verdict from stdout:
//
//	{"decision": "allow"}
//	{"decision": "deny", "reason": "<boundary text>"}
//
// Every call becomes an approval request; the provider's pipeline approves
// at once the tools nobody chose to gate and holds the rest for a human.
// The plugin turns a deny into `block: true, blockReason: reason`, which
// OpenClaw returns to the model as the tool result text, so the model reads
// the boundary and the reviewer's note and the run continues. Allow returns
// nothing, so OpenClaw's own exec approvals and tool policy still apply.
//
// The payload carries `timeout_ms`, the configured approval ceiling. The
// plugin adds a watchdog margin; the request timeout subtracts a margin so the
// provider expires the request and this frontend answers before OpenClaw's
// runner times the handler out (which also fails closed, but with a generic
// reason instead of the boundary text). The ceiling is plugin configuration
// and defaults to a week plus the request margin.
//
// MCP tools are named `<server>__<tool>` by OpenClaw's bundle manager with
// no marker prefix, so the first double underscore is the seam between the
// request's server and tool. Names the bundle manager had to truncate to
// fit a provider's limit stay opaque.
func OpenClaw(ctx context.Context, client *aap.Client, stdin io.Reader, stdout io.Writer) error {
	raw, err := io.ReadAll(stdin)
	if err != nil {
		return err
	}
	allow := func(gated bool, expiry time.Time) {
		_ = json.NewEncoder(stdout).Encode(openclawVerdict{Decision: "allow", Gated: gated, ExpiresAt: expiry.Format(time.RFC3339Nano)})
	}
	deny := func(reason string) {
		_ = json.NewEncoder(stdout).Encode(openclawVerdict{Decision: "deny", Reason: reason})
	}

	var in openclawInput
	if err := aap.Decode(raw, &in); err != nil || in.ToolName == "" || in.Params == nil {
		// The plugin fails closed on anything but a well-formed verdict, so
		// answer explicitly rather than staying silent.
		deny(aap.FailClosedText)
		return nil
	}
	if in.Params == nil {
		in.Params = map[string]any{}
	}

	call := aap.IdentifyTool(in.ToolName, aap.NamingServerPrefixed)

	requestContext := map[string]any{
		"runtime":    "openclaw",
		"session_id": in.SessionID,
	}
	for k, v := range map[string]string{
		"session_key": in.SessionKey,
		"run_id":      in.RunID,
		"call_id":     in.ToolCallID,
		"agent_id":    in.AgentID,
		"tool_kind":   in.ToolKind,
		"cwd":         in.Cwd,
	} {
		if v != "" {
			requestContext[k] = v
		}
	}
	// One request per execution attempt: OpenClaw supplies a call id for
	// every tool call, and the run id keeps parallel sessions apart.
	attempt := strings.Join([]string{in.SessionID, in.RunID, in.ToolCallID}, "\x00")

	timeout := requestTimeout
	if in.TimeoutMs > 0 {
		ceiling := time.Duration(in.TimeoutMs) * time.Millisecond
		if ceiling-openclawHookMargin > 0 {
			timeout = ceiling - openclawHookMargin
		}
	}
	decision, err := gate(ctx, client, aap.CreateInput{
		Tool:           call.Tool,
		Server:         call.Server,
		Arguments:      in.Params,
		Context:        requestContext,
		Timeout:        fmt.Sprintf("%ds", int(timeout.Seconds())),
		IdempotencyKey: aap.IdempotencyKey(attempt, call, in.Params),
	})
	switch {
	case err != nil:
		fmt.Fprintf(os.Stderr, "aap: fail closed: %v\n", err)
		deny(aap.FailClosedText)
	case decision.Allows():
		allow(!decision.Bypassed, decision.ExpiresAt)
	default:
		deny(aap.BoundaryText(decision))
	}
	return nil
}

// openclawHookMargin is how much earlier than the plugin's hook ceiling the
// provider deadline lands, covering the last long-poll and process exit.
const openclawHookMargin = 30 * time.Second

// openclawInput is the payload the AAP OpenClaw plugin builds from the
// before_tool_call event and context.
type openclawInput struct {
	ToolName   string         `json:"tool_name"`
	Params     map[string]any `json:"params"`
	ToolKind   string         `json:"tool_kind"`
	ToolCallID string         `json:"tool_call_id"`
	RunID      string         `json:"run_id"`
	AgentID    string         `json:"agent_id"`
	SessionID  string         `json:"session_id"`
	SessionKey string         `json:"session_key"`
	Cwd        string         `json:"cwd"`
	TimeoutMs  int64          `json:"timeout_ms"`
}

type openclawVerdict struct {
	ExpiresAt string `json:"expires_at,omitempty"`
	Gated     bool   `json:"gated"`
	Decision  string `json:"decision"`
	Reason    string `json:"reason,omitempty"`
}
