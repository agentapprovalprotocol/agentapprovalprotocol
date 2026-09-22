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

// Hermes runs the AAP half of the Hermes Agent adapter. Hermes invokes this
// frontend directly from its native pre_tool_call shell-hook protocol. The
// hook writes one proposed call to stdin and accepts these stdout directives:
//
//	{"action":"modify","args":{...}}           // approved, preserve reviewed args
//	{"action":"block","message":"<reason>"}   // denied or failed closed
//
// Every call becomes an approval request; the provider's pipeline approves
// at once the tools nobody chose to gate and holds the rest for a human.
// An approved call is returned as an identity modification instead of an
// allow directive. Hermes has no explicit allow directive, and passthrough is
// required so its own guardrails and local approval flow still run. Repeating
// the full reviewed argument object also overwrites modifications returned by
// earlier hooks when this hook is registered last, as documented.
func Hermes(ctx context.Context, client *aap.Client, stdin io.Reader, stdout io.Writer) error {
	raw, err := io.ReadAll(stdin)
	if err != nil {
		return err
	}
	approve := func(args map[string]any) {
		_ = json.NewEncoder(stdout).Encode(hermesVerdict{Action: "modify", Args: &args})
	}
	block := func(message string) {
		_ = json.NewEncoder(stdout).Encode(hermesVerdict{Action: "block", Message: message})
	}

	var in hermesInput
	if err := aap.Decode(raw, &in); err != nil ||
		in.HookEventName != "pre_tool_call" ||
		in.ToolName == "" ||
		in.ToolInput == nil ||
		in.SessionID == "" ||
		in.Extra.ToolCallID == "" {
		block(aap.FailClosedText)
		return nil
	}

	call := aap.IdentifyTool(in.ToolName, aap.NamingMCPPrefixed)

	requestContext := map[string]any{
		"runtime":    "hermes",
		"hook_event": in.HookEventName,
		"session_id": in.SessionID,
	}
	for key, value := range map[string]string{
		"task_id":        in.Extra.TaskID,
		"call_id":        in.Extra.ToolCallID,
		"turn_id":        in.Extra.TurnID,
		"api_request_id": in.Extra.APIRequestID,
		"cwd":            in.Cwd,
	} {
		if value != "" {
			requestContext[key] = value
		}
	}

	// Hermes supplies a provider call id for each execution attempt. Include
	// the surrounding identities too so CLI, gateway, and delegated sessions
	// cannot collide if a provider reuses a call id.
	attempt := strings.Join([]string{
		in.SessionID,
		in.Extra.TaskID,
		in.Extra.TurnID,
		in.Extra.APIRequestID,
		in.Extra.ToolCallID,
	}, "\x00")
	decision, err := gate(ctx, client, aap.CreateInput{
		Tool:           call.Tool,
		Server:         call.Server,
		Arguments:      in.ToolInput,
		Context:        requestContext,
		Timeout:        fmt.Sprintf("%ds", int(hermesApprovalTimeout.Seconds())),
		IdempotencyKey: aap.IdempotencyKey(attempt, call, in.ToolInput),
	})
	switch {
	case err != nil:
		fmt.Fprintf(os.Stderr, "aap: fail closed: %v\n", err)
		block(aap.FailClosedText)
	case decision.Allows():
		approve(in.ToolInput)
	default:
		block(aap.BoundaryText(decision))
	}
	return nil
}

// Hermes caps an individual shell hook at 300 seconds. Expire the provider
// request first so the adapter has time to return the specific AAP boundary
// before Hermes' own fail-closed watchdog kills it.
const hermesApprovalTimeout = 300*time.Second - 30*time.Second

type hermesInput struct {
	HookEventName string         `json:"hook_event_name"`
	ToolName      string         `json:"tool_name"`
	ToolInput     map[string]any `json:"tool_input"`
	SessionID     string         `json:"session_id"`
	Cwd           string         `json:"cwd"`
	Extra         struct {
		TaskID       string `json:"task_id"`
		ToolCallID   string `json:"tool_call_id"`
		TurnID       string `json:"turn_id"`
		APIRequestID string `json:"api_request_id"`
	} `json:"extra"`
}

type hermesVerdict struct {
	Action  string          `json:"action,omitempty"`
	Message string          `json:"message,omitempty"`
	Args    *map[string]any `json:"args,omitempty"`
}
