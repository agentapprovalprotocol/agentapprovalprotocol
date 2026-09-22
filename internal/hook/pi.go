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
	"github.com/agentapprovalprotocol/agentapprovalprotocol/tool"
)

// Pi runs the AAP half of the Pi adapter. The runtime half is the native Pi
// extension in internal/cli/plugins/assets/pi, registered on Pi's `tool_call` event.
// The extension writes one proposed call to stdin and expects one explicit
// verdict on stdout:
//
//	{"decision":"allow","gated":false}  // excluded by the local glob
//	{"decision":"allow","gated":true}   // the AAP provider approved it
//	{"decision":"deny","reason":"..."} // blocked
//
// Every call becomes an approval request; the provider's pipeline approves
// at once the tools nobody chose to gate and holds the rest for a human.
// Pi turns a blocked tool_call event into an isError tool result containing
// the reason, so the model reads the denial as a stated policy boundary.
func Pi(ctx context.Context, client *aap.Client, stdin io.Reader, stdout io.Writer) error {
	raw, err := io.ReadAll(stdin)
	if err != nil {
		return err
	}
	allow := func(gated bool, expiry time.Time) {
		_ = json.NewEncoder(stdout).Encode(piVerdict{Decision: "allow", Gated: gated, ExpiresAt: expiry.Format(time.RFC3339Nano)})
	}
	deny := func(reason string) {
		_ = json.NewEncoder(stdout).Encode(piVerdict{Decision: "deny", Reason: reason})
	}

	var in piInput
	if err := aap.Decode(raw, &in); err != nil || in.ToolName == "" || in.Arguments == nil || in.ToolCallID == "" || in.SessionID == "" {
		// The extension fails closed on anything but a well-formed verdict, but
		// return an explicit denial so the model gets the standard boundary text.
		deny(aap.FailClosedText)
		return nil
	}

	// Pi has no MCP client, so a tool name is the tool.
	call := tool.Identify(in.ToolName, tool.NamingPlain)

	requestContext := map[string]any{
		"runtime":    "pi",
		"session_id": in.SessionID,
		"cwd":        in.Cwd,
	}
	if in.ToolCallID != "" {
		requestContext["call_id"] = in.ToolCallID
	}

	// A Pi tool call id identifies one execution attempt. A restarted adapter
	// for the same call re-attaches; a new call id requires a new decision.
	attempt := strings.Join([]string{in.SessionID, in.ToolCallID}, "\x00")
	timeout := requestTimeout
	if in.TimeoutMs > 0 {
		ceiling := time.Duration(in.TimeoutMs) * time.Millisecond
		timeout = ceiling - piHookMargin
		if timeout < time.Second {
			timeout = time.Second
		}
	}
	decision, err := gate(ctx, client, aap.CreateInput{
		Tool:           call.Tool,
		Server:         call.Server,
		Arguments:      in.Arguments,
		AgentReasoning: in.AgentReasoning,
		Context:        requestContext,
		Timeout:        fmt.Sprintf("%ds", int(timeout.Seconds())),
		IdempotencyKey: aap.IdempotencyKey(attempt, call, in.Arguments),
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

// piHookMargin makes the provider deadline land before the extension's child
// process watchdog, leaving time to return the expiry boundary to Pi.
const piHookMargin = 30 * time.Second

type piInput struct {
	ToolName       string         `json:"tool_name"`
	Arguments      map[string]any `json:"arguments"`
	ToolCallID     string         `json:"tool_call_id"`
	SessionID      string         `json:"session_id"`
	Cwd            string         `json:"cwd"`
	AgentReasoning string         `json:"agent_reasoning"`
	TimeoutMs      int64          `json:"timeout_ms"`
}

type piVerdict struct {
	ExpiresAt string `json:"expires_at,omitempty"`
	Decision  string `json:"decision"`
	Gated     bool   `json:"gated"`
	Reason    string `json:"reason,omitempty"`
}
